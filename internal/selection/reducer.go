package selection

import "slices"

func Apply(current State, action Action, terminals []Terminal) (State, error) {
	if action.ExpectedRevision != nil && *action.ExpectedRevision != current.Revision {
		return State{}, ErrRevisionConflict
	}
	state := normalize(current, terminals)
	available := terminalSet(terminals)
	if err := validateTerminalIDs(action.TerminalIDs, available); err != nil {
		return State{}, err
	}
	if err := validateTerminalIDs(action.PinnedTerminalIDs, available); err != nil {
		return State{}, err
	}

	switch action.Type {
	case ActionReplace:
		state.ManualTerminalIDs = unique(action.TerminalIDs)
		state.StatusFilters = nil
		state.CWDFilters = nil
		if action.FocusedTerminalID != "" {
			if _, ok := available[action.FocusedTerminalID]; !ok {
				return State{}, ErrTerminalNotFound
			}
			if !slices.Contains(state.ManualTerminalIDs, action.FocusedTerminalID) &&
				!slices.Contains(state.PinnedTerminalIDs, action.FocusedTerminalID) {
				return State{}, ErrTerminalNotSelected
			}
			state.FocusedTerminalID = action.FocusedTerminalID
		}
	case ActionReplaceState:
		state.ManualTerminalIDs = unique(action.TerminalIDs)
		state.PinnedTerminalIDs = unique(action.PinnedTerminalIDs)
		state.StatusFilters = uniqueNonEmpty(action.Statuses)
		state.CWDFilters = uniqueCWDFilters(action.CWDFilters)
		state.FocusedTerminalID = action.FocusedTerminalID
		if state.FocusedTerminalID != "" &&
			!snapshotContains(Resolve(state, terminals), state.FocusedTerminalID) {
			return State{}, ErrTerminalNotSelected
		}
	case ActionAdd:
		state.ManualTerminalIDs = unique(append(state.ManualTerminalIDs, action.TerminalIDs...))
		if action.FocusedTerminalID != "" {
			if _, ok := available[action.FocusedTerminalID]; !ok {
				return State{}, ErrTerminalNotFound
			}
			if !snapshotContains(Resolve(state, terminals), action.FocusedTerminalID) {
				return State{}, ErrTerminalNotSelected
			}
			state.FocusedTerminalID = action.FocusedTerminalID
		}
	case ActionRemove:
		for _, id := range unique(action.TerminalIDs) {
			removeTerminal(&state, id, terminals)
		}
	case ActionFocus:
		if _, ok := available[action.FocusedTerminalID]; !ok {
			return State{}, ErrTerminalNotFound
		}
		if !snapshotContains(Resolve(state, terminals), action.FocusedTerminalID) {
			return State{}, ErrTerminalNotSelected
		}
		state.FocusedTerminalID = action.FocusedTerminalID
	case ActionPin:
		state.PinnedTerminalIDs = unique(append(state.PinnedTerminalIDs, action.TerminalIDs...))
		if len(action.TerminalIDs) > 0 {
			state.FocusedTerminalID = action.TerminalIDs[len(action.TerminalIDs)-1]
		}
	case ActionUnpin:
		state.PinnedTerminalIDs = without(state.PinnedTerminalIDs, action.TerminalIDs)
	case ActionFilterStatusSet:
		state.StatusFilters = uniqueNonEmpty(action.Statuses)
	case ActionFilterStatusAdd:
		state.StatusFilters = uniqueNonEmpty(append(state.StatusFilters, action.Statuses...))
	case ActionFilterStatusRemove:
		state.StatusFilters = without(state.StatusFilters, action.Statuses)
	case ActionFilterCWDSet:
		state.CWDFilters = uniqueCWDFilters(action.CWDFilters)
	case ActionFilterCWDAdd:
		state.CWDFilters = uniqueCWDFilters(append(state.CWDFilters, action.CWDFilters...))
	case ActionFilterCWDRemove:
		state.CWDFilters = withoutCWDFilters(state.CWDFilters, action.CWDFilters)
	case ActionPromoteFocusedAgent:
		if _, ok := available[action.FocusedTerminalID]; !ok {
			return State{}, ErrTerminalNotFound
		}
		state.ManualTerminalIDs = []string{action.FocusedTerminalID}
		state.FocusedTerminalID = action.FocusedTerminalID
		state.StatusFilters = nil
		state.CWDFilters = nil
	default:
		return State{}, ErrInvalidAction
	}

	state = normalize(state, terminals)
	state.Revision = current.Revision + 1
	return state, nil
}

func Resolve(state State, terminals []Terminal) Snapshot {
	manual := stringSet(state.ManualTerminalIDs)
	pinned := stringSet(state.PinnedTerminalIDs)
	selected := make([]string, 0, len(terminals))
	for _, terminal := range terminals {
		if manual[terminal.ID] || pinned[terminal.ID] || matchesFilters(terminal, state) {
			selected = append(selected, terminal.ID)
		}
	}
	focus := state.FocusedTerminalID
	if !slices.Contains(selected, focus) {
		focus = ""
		if len(selected) > 0 {
			focus = selected[0]
		}
	}
	return Snapshot{
		TerminalIDs:       selected,
		ManualTerminalIDs: orderedIDs(state.ManualTerminalIDs, terminals),
		PinnedTerminalIDs: orderedIDs(state.PinnedTerminalIDs, terminals),
		FocusedTerminalID: focus,
		Filters: Filters{
			Statuses: append([]string{}, state.StatusFilters...),
			CWDs:     append([]CWDFilter{}, state.CWDFilters...),
		},
		Revision: state.Revision,
	}
}

func Reconcile(current State, terminals []Terminal) (State, bool) {
	next := normalize(current, terminals)
	next.Revision = current.Revision
	if statesEqual(current, next) {
		return next, false
	}
	next.Revision++
	return next, true
}

func normalize(state State, terminals []Terminal) State {
	state.ManualTerminalIDs = orderedIDs(state.ManualTerminalIDs, terminals)
	state.PinnedTerminalIDs = orderedIDs(state.PinnedTerminalIDs, terminals)
	state.StatusFilters = uniqueNonEmpty(state.StatusFilters)
	state.CWDFilters = uniqueCWDFilters(state.CWDFilters)
	snapshot := Resolve(state, terminals)
	state.FocusedTerminalID = snapshot.FocusedTerminalID
	return state
}

func removeTerminal(state *State, id string, terminals []Terminal) {
	state.ManualTerminalIDs = without(state.ManualTerminalIDs, []string{id})
	terminal, ok := findTerminal(terminals, id)
	if !ok {
		return
	}
	for _, status := range append([]string(nil), state.StatusFilters...) {
		if !slices.Contains(terminal.Statuses, status) {
			continue
		}
		state.StatusFilters = without(state.StatusFilters, []string{status})
		for _, candidate := range terminals {
			if candidate.CWD == terminal.CWD || !slices.Contains(candidate.Statuses, status) {
				continue
			}
			state.CWDFilters = append(state.CWDFilters, CWDFilter{
				Status: status,
				CWD:    candidate.CWD,
			})
		}
	}
	for _, filter := range append([]CWDFilter(nil), state.CWDFilters...) {
		if filter.CWD == terminal.CWD && slices.Contains(terminal.Statuses, filter.Status) {
			state.CWDFilters = withoutCWDFilters(state.CWDFilters, []CWDFilter{filter})
		}
	}
}

func matchesFilters(terminal Terminal, state State) bool {
	for _, status := range state.StatusFilters {
		if slices.Contains(terminal.Statuses, status) {
			return true
		}
	}
	for _, filter := range state.CWDFilters {
		if terminal.CWD == filter.CWD && slices.Contains(terminal.Statuses, filter.Status) {
			return true
		}
	}
	return false
}

func validateTerminalIDs(ids []string, available map[string]struct{}) error {
	for _, id := range ids {
		if _, ok := available[id]; !ok {
			return ErrTerminalNotFound
		}
	}
	return nil
}

func terminalSet(terminals []Terminal) map[string]struct{} {
	result := make(map[string]struct{}, len(terminals))
	for _, terminal := range terminals {
		result[terminal.ID] = struct{}{}
	}
	return result
}

func stringSet(values []string) map[string]bool {
	result := make(map[string]bool, len(values))
	for _, value := range values {
		result[value] = true
	}
	return result
}

func unique(values []string) []string {
	seen := make(map[string]bool, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

func uniqueNonEmpty(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range unique(values) {
		if value != "" {
			result = append(result, value)
		}
	}
	return result
}

func orderedIDs(ids []string, terminals []Terminal) []string {
	wanted := stringSet(ids)
	result := make([]string, 0, len(ids))
	for _, terminal := range terminals {
		if wanted[terminal.ID] {
			result = append(result, terminal.ID)
		}
	}
	return result
}

func without(values, removed []string) []string {
	blocked := stringSet(removed)
	result := make([]string, 0, len(values))
	for _, value := range values {
		if !blocked[value] {
			result = append(result, value)
		}
	}
	return result
}

func uniqueCWDFilters(filters []CWDFilter) []CWDFilter {
	seen := make(map[CWDFilter]bool, len(filters))
	result := make([]CWDFilter, 0, len(filters))
	for _, filter := range filters {
		if filter.Status == "" || filter.CWD == "" || seen[filter] {
			continue
		}
		seen[filter] = true
		result = append(result, filter)
	}
	return result
}

func withoutCWDFilters(filters, removed []CWDFilter) []CWDFilter {
	blocked := make(map[CWDFilter]bool, len(removed))
	for _, filter := range removed {
		blocked[filter] = true
	}
	result := make([]CWDFilter, 0, len(filters))
	for _, filter := range filters {
		if !blocked[filter] {
			result = append(result, filter)
		}
	}
	return result
}

func findTerminal(terminals []Terminal, id string) (Terminal, bool) {
	for _, terminal := range terminals {
		if terminal.ID == id {
			return terminal, true
		}
	}
	return Terminal{}, false
}

func snapshotContains(snapshot Snapshot, id string) bool {
	return slices.Contains(snapshot.TerminalIDs, id)
}

func statesEqual(left, right State) bool {
	return slices.Equal(left.ManualTerminalIDs, right.ManualTerminalIDs) &&
		slices.Equal(left.PinnedTerminalIDs, right.PinnedTerminalIDs) &&
		left.FocusedTerminalID == right.FocusedTerminalID &&
		slices.Equal(left.StatusFilters, right.StatusFilters) &&
		slices.Equal(left.CWDFilters, right.CWDFilters)
}
