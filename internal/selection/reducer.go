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
	if err := validateStatuses(action.Statuses, action.CWDFilters); err != nil {
		return State{}, err
	}
	if err := validateStatuses(action.PinnedStatuses, action.PinnedCWDFilters); err != nil {
		return State{}, err
	}

	switch action.Type {
	case ActionReplace:
		state.ManualTerminalIDs = unique(action.TerminalIDs)
		state.StatusFilters = append([]string{}, state.PinnedFilters.Statuses...)
		state.CWDFilters = append([]CWDFilter{}, state.PinnedFilters.CWDs...)
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
		state.PinnedFilters = Filters{
			Statuses: uniqueNonEmpty(action.PinnedStatuses),
			CWDs:     uniqueCWDFilters(action.PinnedCWDFilters),
		}
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
		state.StatusFilters = uniqueNonEmpty(append(
			append([]string{}, action.Statuses...),
			state.PinnedFilters.Statuses...,
		))
	case ActionFilterStatusAdd:
		state.StatusFilters = uniqueNonEmpty(append(state.StatusFilters, action.Statuses...))
	case ActionFilterStatusRemove:
		state.StatusFilters = without(state.StatusFilters, action.Statuses)
		state.PinnedFilters.Statuses = without(
			state.PinnedFilters.Statuses,
			action.Statuses,
		)
	case ActionFilterCWDSet:
		state.CWDFilters = uniqueCWDFilters(append(
			append([]CWDFilter{}, action.CWDFilters...),
			state.PinnedFilters.CWDs...,
		))
	case ActionFilterCWDAdd:
		state.CWDFilters = uniqueCWDFilters(append(state.CWDFilters, action.CWDFilters...))
	case ActionFilterCWDRemove:
		state.CWDFilters = withoutCWDFilters(state.CWDFilters, action.CWDFilters)
		state.PinnedFilters.CWDs = withoutCWDFilters(
			state.PinnedFilters.CWDs,
			action.CWDFilters,
		)
	case ActionPromoteFocusedAgent:
		if _, ok := available[action.FocusedTerminalID]; !ok {
			return State{}, ErrTerminalNotFound
		}
		state.ManualTerminalIDs = []string{action.FocusedTerminalID}
		state.FocusedTerminalID = action.FocusedTerminalID
		state.StatusFilters = append([]string{}, state.PinnedFilters.Statuses...)
		state.CWDFilters = append([]CWDFilter{}, state.PinnedFilters.CWDs...)
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
		PinnedFilters: Filters{
			Statuses: append([]string{}, state.PinnedFilters.Statuses...),
			CWDs:     append([]CWDFilter{}, state.PinnedFilters.CWDs...),
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

func ReconcileAfterTerminalDeletion(
	current State,
	previous Snapshot,
	deletedID, replacementID string,
	terminals []Terminal,
) (State, bool) {
	next, changed := Reconcile(current, terminals)
	if previous.FocusedTerminalID != deletedID ||
		!slices.Equal(previous.TerminalIDs, []string{deletedID}) ||
		replacementID == "" ||
		len(current.StatusFilters) > 0 || len(current.CWDFilters) > 0 ||
		len(current.PinnedFilters.Statuses) > 0 || len(current.PinnedFilters.CWDs) > 0 ||
		len(Resolve(next, terminals).TerminalIDs) > 0 {
		return next, changed
	}
	next.ManualTerminalIDs = []string{replacementID}
	next.FocusedTerminalID = replacementID
	if !changed {
		next.Revision = current.Revision + 1
	}
	return next, true
}

func normalize(state State, terminals []Terminal) State {
	state.ManualTerminalIDs = orderedIDs(state.ManualTerminalIDs, terminals)
	state.PinnedTerminalIDs = orderedIDs(state.PinnedTerminalIDs, terminals)
	state.StatusFilters = uniqueNonEmpty(state.StatusFilters)
	state.CWDFilters = uniqueCWDFilters(state.CWDFilters)
	state.PinnedFilters.Statuses = uniqueNonEmpty(state.PinnedFilters.Statuses)
	state.PinnedFilters.CWDs = uniqueCWDFilters(state.PinnedFilters.CWDs)
	for _, status := range state.PinnedFilters.Statuses {
		state.PinnedFilters.CWDs = withoutStatusCWDFilters(
			state.PinnedFilters.CWDs,
			status,
		)
	}
	state.StatusFilters = uniqueNonEmpty(append(
		state.StatusFilters,
		state.PinnedFilters.Statuses...,
	))
	state.CWDFilters = uniqueCWDFilters(append(
		state.CWDFilters,
		state.PinnedFilters.CWDs...,
	))
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
		pinned := slices.Contains(state.PinnedFilters.Statuses, status)
		state.StatusFilters = without(state.StatusFilters, []string{status})
		state.PinnedFilters.Statuses = without(
			state.PinnedFilters.Statuses,
			[]string{status},
		)
		for _, candidate := range terminals {
			if candidate.CWD == terminal.CWD || !slices.Contains(candidate.Statuses, status) {
				continue
			}
			filter := CWDFilter{
				Status: status,
				CWD:    candidate.CWD,
			}
			state.CWDFilters = append(state.CWDFilters, filter)
			if pinned {
				state.PinnedFilters.CWDs = append(state.PinnedFilters.CWDs, filter)
			}
		}
	}
	for _, filter := range append([]CWDFilter(nil), state.CWDFilters...) {
		if filter.CWD == terminal.CWD && slices.Contains(terminal.Statuses, filter.Status) {
			state.CWDFilters = withoutCWDFilters(state.CWDFilters, []CWDFilter{filter})
			state.PinnedFilters.CWDs = withoutCWDFilters(
				state.PinnedFilters.CWDs,
				[]CWDFilter{filter},
			)
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

func validateStatuses(statuses []string, cwdFilters []CWDFilter) error {
	valid := map[string]bool{
		"starting":  true,
		"running":   true,
		"waiting":   true,
		"blocked":   true,
		"attention": true,
		"terminal":  true,
		"exited":    true,
		"failed":    true,
	}
	for _, status := range statuses {
		if !valid[status] {
			return ErrInvalidAction
		}
	}
	for _, filter := range cwdFilters {
		if !valid[filter.Status] || filter.CWD == "" {
			return ErrInvalidAction
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

func withoutStatusCWDFilters(filters []CWDFilter, status string) []CWDFilter {
	result := make([]CWDFilter, 0, len(filters))
	for _, filter := range filters {
		if filter.Status != status {
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
		slices.Equal(left.CWDFilters, right.CWDFilters) &&
		slices.Equal(left.PinnedFilters.Statuses, right.PinnedFilters.Statuses) &&
		slices.Equal(left.PinnedFilters.CWDs, right.PinnedFilters.CWDs)
}
