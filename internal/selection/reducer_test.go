package selection

import (
	"errors"
	"reflect"
	"testing"
)

func TestPinSelectsTerminalAndUnpinPreservesManualSelection(t *testing.T) {
	terminals := []Terminal{{ID: "t1", CWD: "/repo", Statuses: []string{"running"}}}
	state := State{ManualTerminalIDs: []string{"t1"}}

	state, err := Apply(state, Action{
		Type:        ActionPin,
		TerminalIDs: []string{"t1"},
	}, terminals)
	if err != nil {
		t.Fatalf("Apply(pin) error = %v", err)
	}
	if !reflect.DeepEqual(state.PinnedTerminalIDs, []string{"t1"}) {
		t.Fatalf("PinnedTerminalIDs = %#v", state.PinnedTerminalIDs)
	}

	state, err = Apply(state, Action{
		Type:        ActionUnpin,
		TerminalIDs: []string{"t1"},
	}, terminals)
	if err != nil {
		t.Fatalf("Apply(unpin) error = %v", err)
	}
	snapshot := Resolve(state, terminals)
	if !reflect.DeepEqual(snapshot.TerminalIDs, []string{"t1"}) {
		t.Fatalf("TerminalIDs = %#v, want [t1]", snapshot.TerminalIDs)
	}
}

func TestStatusFiltersTrackDynamicMembershipAndAttentionOverlay(t *testing.T) {
	terminals := []Terminal{
		{ID: "waiting", CWD: "/repo", Statuses: []string{"waiting", "attention"}},
		{ID: "running", CWD: "/repo", Statuses: []string{"running"}},
	}
	state := State{StatusFilters: []string{"waiting", "attention"}}

	snapshot := Resolve(state, terminals)
	if !reflect.DeepEqual(snapshot.TerminalIDs, []string{"waiting"}) {
		t.Fatalf("TerminalIDs = %#v, want [waiting]", snapshot.TerminalIDs)
	}

	terminals[1].Statuses = []string{"waiting"}
	snapshot = Resolve(state, terminals)
	if !reflect.DeepEqual(snapshot.TerminalIDs, []string{"waiting", "running"}) {
		t.Fatalf("dynamic TerminalIDs = %#v", snapshot.TerminalIDs)
	}
}

func TestRemovingStatusOwnedTerminalDecomposesParentIntoSiblingCWDFilters(t *testing.T) {
	terminals := []Terminal{
		{ID: "a", CWD: "/repo/a", Statuses: []string{"running"}},
		{ID: "b", CWD: "/repo/b", Statuses: []string{"running"}},
		{ID: "c", CWD: "/repo/b", Statuses: []string{"running"}},
	}
	state := State{StatusFilters: []string{"running"}, FocusedTerminalID: "a"}

	state, err := Apply(state, Action{
		Type:        ActionRemove,
		TerminalIDs: []string{"a"},
	}, terminals)
	if err != nil {
		t.Fatalf("Apply(remove) error = %v", err)
	}
	if len(state.StatusFilters) != 0 {
		t.Fatalf("StatusFilters = %#v, want empty", state.StatusFilters)
	}
	wantFilters := []CWDFilter{{Status: "running", CWD: "/repo/b"}}
	if !reflect.DeepEqual(state.CWDFilters, wantFilters) {
		t.Fatalf("CWDFilters = %#v, want %#v", state.CWDFilters, wantFilters)
	}
	snapshot := Resolve(state, terminals)
	if !reflect.DeepEqual(snapshot.TerminalIDs, []string{"b", "c"}) ||
		snapshot.FocusedTerminalID != "b" {
		t.Fatalf("snapshot = %#v", snapshot)
	}
}

func TestRemovingCWDFilterOwnedTerminalReleasesWholeCWDFilter(t *testing.T) {
	terminals := []Terminal{
		{ID: "a", CWD: "/repo", Statuses: []string{"running"}},
		{ID: "b", CWD: "/repo", Statuses: []string{"running"}},
	}
	state := State{CWDFilters: []CWDFilter{{Status: "running", CWD: "/repo"}}}

	state, err := Apply(state, Action{
		Type:        ActionRemove,
		TerminalIDs: []string{"a"},
	}, terminals)
	if err != nil {
		t.Fatalf("Apply(remove) error = %v", err)
	}
	if len(state.CWDFilters) != 0 {
		t.Fatalf("CWDFilters = %#v, want empty", state.CWDFilters)
	}
	if got := Resolve(state, terminals).TerminalIDs; len(got) != 0 {
		t.Fatalf("TerminalIDs = %#v, want empty", got)
	}
}

func TestFocusRequiresAnEffectivelySelectedTerminal(t *testing.T) {
	terminals := []Terminal{
		{ID: "a", CWD: "/repo", Statuses: []string{"running"}},
		{ID: "b", CWD: "/repo", Statuses: []string{"waiting"}},
	}
	state := State{ManualTerminalIDs: []string{"a"}, FocusedTerminalID: "a"}

	_, err := Apply(state, Action{
		Type:              ActionFocus,
		FocusedTerminalID: "b",
	}, terminals)
	if !errors.Is(err, ErrTerminalNotSelected) {
		t.Fatalf("Apply(focus) error = %v, want ErrTerminalNotSelected", err)
	}
}

func TestReplaceRejectsFocusOutsideReplacement(t *testing.T) {
	terminals := []Terminal{
		{ID: "a", CWD: "/repo", Statuses: []string{"running"}},
		{ID: "b", CWD: "/repo", Statuses: []string{"waiting"}},
	}

	_, err := Apply(State{}, Action{
		Type:              ActionReplace,
		TerminalIDs:       []string{"a"},
		FocusedTerminalID: "b",
	}, terminals)
	if !errors.Is(err, ErrTerminalNotSelected) {
		t.Fatalf("Apply(replace) error = %v, want ErrTerminalNotSelected", err)
	}
}

func TestResolveUsesEmptyArraysInsteadOfNullSelectionCollections(t *testing.T) {
	snapshot := Resolve(State{}, nil)
	if snapshot.TerminalIDs == nil ||
		snapshot.ManualTerminalIDs == nil ||
		snapshot.PinnedTerminalIDs == nil ||
		snapshot.Filters.Statuses == nil ||
		snapshot.Filters.CWDs == nil {
		t.Fatalf("Resolve() returned nil collection: %#v", snapshot)
	}
}

func TestExpectedRevisionRejectsStaleFullReplacement(t *testing.T) {
	terminals := []Terminal{{ID: "a", CWD: "/repo", Statuses: []string{"terminal"}}}
	state := State{ManualTerminalIDs: []string{"a"}, Revision: 4}
	stale := uint64(3)

	_, err := Apply(state, Action{
		Type:             ActionReplace,
		TerminalIDs:      []string{"a"},
		ExpectedRevision: &stale,
	}, terminals)
	if !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("Apply(replace) error = %v, want ErrRevisionConflict", err)
	}
}

func TestReplaceAndAddUpdateManualSelectionWithoutDroppingPins(t *testing.T) {
	terminals := []Terminal{
		{ID: "a", CWD: "/repo", Statuses: []string{"running"}},
		{ID: "b", CWD: "/repo", Statuses: []string{"waiting"}},
		{ID: "pinned", CWD: "/other", Statuses: []string{"terminal"}},
	}
	state := State{
		ManualTerminalIDs: []string{"a"},
		PinnedTerminalIDs: []string{"pinned"},
		FocusedTerminalID: "a",
		StatusFilters:     []string{"running"},
		Revision:          2,
	}
	expected := uint64(2)

	state, err := Apply(state, Action{
		Type:              ActionReplace,
		TerminalIDs:       []string{"b"},
		FocusedTerminalID: "b",
		ExpectedRevision:  &expected,
	}, terminals)
	if err != nil {
		t.Fatalf("Apply(replace) error = %v", err)
	}
	if !reflect.DeepEqual(state.ManualTerminalIDs, []string{"b"}) ||
		!reflect.DeepEqual(state.PinnedTerminalIDs, []string{"pinned"}) ||
		state.FocusedTerminalID != "b" ||
		len(state.StatusFilters) != 0 ||
		state.Revision != 3 {
		t.Fatalf("replace state = %#v", state)
	}

	state, err = Apply(state, Action{
		Type:        ActionAdd,
		TerminalIDs: []string{"a", "a"},
	}, terminals)
	if err != nil {
		t.Fatalf("Apply(add) error = %v", err)
	}
	if !reflect.DeepEqual(state.ManualTerminalIDs, []string{"a", "b"}) ||
		state.FocusedTerminalID != "b" ||
		state.Revision != 4 {
		t.Fatalf("add state = %#v", state)
	}
}

func TestAddCanFocusTheNewlySelectedTerminal(t *testing.T) {
	terminals := []Terminal{
		{ID: "a", CWD: "/repo", Statuses: []string{"running"}},
		{ID: "b", CWD: "/repo", Statuses: []string{"waiting"}},
	}
	state := State{ManualTerminalIDs: []string{"a"}, FocusedTerminalID: "a"}

	next, err := Apply(state, Action{
		Type:              ActionAdd,
		TerminalIDs:       []string{"b"},
		FocusedTerminalID: "b",
	}, terminals)
	if err != nil {
		t.Fatalf("Apply(add focused) error = %v", err)
	}
	if next.FocusedTerminalID != "b" {
		t.Fatalf("FocusedTerminalID = %q, want b", next.FocusedTerminalID)
	}
}

func TestReplaceStateAtomicallySetsEverySelectionSource(t *testing.T) {
	terminals := []Terminal{
		{ID: "manual", CWD: "/repo", Statuses: []string{"waiting"}},
		{ID: "pinned", CWD: "/other", Statuses: []string{"terminal"}},
		{ID: "filtered", CWD: "/third", Statuses: []string{"running"}},
	}
	current := State{Revision: 8}
	expected := uint64(8)

	next, err := Apply(current, Action{
		Type:              ActionReplaceState,
		TerminalIDs:       []string{"manual"},
		PinnedTerminalIDs: []string{"pinned"},
		FocusedTerminalID: "manual",
		Statuses:          []string{"running"},
		CWDFilters:        []CWDFilter{},
		ExpectedRevision:  &expected,
	}, terminals)
	if err != nil {
		t.Fatalf("Apply(replace state) error = %v", err)
	}
	snapshot := Resolve(next, terminals)
	if !reflect.DeepEqual(snapshot.TerminalIDs, []string{"manual", "pinned", "filtered"}) ||
		!reflect.DeepEqual(snapshot.ManualTerminalIDs, []string{"manual"}) ||
		!reflect.DeepEqual(snapshot.PinnedTerminalIDs, []string{"pinned"}) ||
		snapshot.FocusedTerminalID != "manual" ||
		!reflect.DeepEqual(snapshot.Filters.Statuses, []string{"running"}) ||
		snapshot.Revision != 9 {
		t.Fatalf("replace state snapshot = %#v", snapshot)
	}
}

func TestPinnedFiltersRemainDynamicAcrossManualReplacement(t *testing.T) {
	terminals := []Terminal{
		{ID: "running-a", CWD: "/repo/a", Statuses: []string{"running"}},
		{ID: "waiting", CWD: "/repo", Statuses: []string{"waiting"}},
	}

	state, err := Apply(State{}, Action{
		Type:             ActionReplaceState,
		TerminalIDs:      []string{"waiting"},
		Statuses:         []string{"running"},
		PinnedStatuses:   []string{"running"},
		PinnedCWDFilters: []CWDFilter{},
	}, terminals)
	if err != nil {
		t.Fatalf("Apply(replace state) error = %v", err)
	}
	state, err = Apply(state, Action{
		Type:              ActionReplace,
		TerminalIDs:       []string{"waiting"},
		FocusedTerminalID: "waiting",
	}, terminals)
	if err != nil {
		t.Fatalf("Apply(replace) error = %v", err)
	}

	terminals = append(terminals,
		Terminal{ID: "running-b", CWD: "/repo/b", Statuses: []string{"running"}})
	snapshot := Resolve(state, terminals)
	if !reflect.DeepEqual(snapshot.TerminalIDs,
		[]string{"running-a", "waiting", "running-b"}) {
		t.Fatalf("TerminalIDs = %#v", snapshot.TerminalIDs)
	}
	if !reflect.DeepEqual(snapshot.Filters.Statuses, []string{"running"}) ||
		!reflect.DeepEqual(snapshot.PinnedFilters.Statuses, []string{"running"}) ||
		snapshot.PinnedFilters.CWDs == nil {
		t.Fatalf("pinned filters = %#v, active filters = %#v",
			snapshot.PinnedFilters, snapshot.Filters)
	}
}

func TestPinnedFilterRemovalDecomposesStatusIntoPinnedSiblingCWDs(t *testing.T) {
	terminals := []Terminal{
		{ID: "a", CWD: "/repo/a", Statuses: []string{"running"}},
		{ID: "b", CWD: "/repo/b", Statuses: []string{"running"}},
		{ID: "c", CWD: "/repo/b", Statuses: []string{"running"}},
	}
	state := State{
		StatusFilters: []string{"running"},
		PinnedFilters: Filters{Statuses: []string{"running"}},
	}

	state, err := Apply(state, Action{
		Type:        ActionRemove,
		TerminalIDs: []string{"a"},
	}, terminals)
	if err != nil {
		t.Fatalf("Apply(remove) error = %v", err)
	}

	want := []CWDFilter{{Status: "running", CWD: "/repo/b"}}
	if len(state.StatusFilters) != 0 ||
		len(state.PinnedFilters.Statuses) != 0 ||
		!reflect.DeepEqual(state.CWDFilters, want) ||
		!reflect.DeepEqual(state.PinnedFilters.CWDs, want) {
		t.Fatalf("decomposed state = %#v, want pinned cwd %#v", state, want)
	}
}

func TestFilterActionsSetAddAndRemoveStatusAndCWDSelectors(t *testing.T) {
	terminals := []Terminal{
		{ID: "a", CWD: "/repo/a", Statuses: []string{"running"}},
		{ID: "b", CWD: "/repo/b", Statuses: []string{"blocked"}},
	}
	state := State{}
	var err error

	state, err = Apply(state, Action{
		Type:     ActionFilterStatusSet,
		Statuses: []string{"running", "running"},
	}, terminals)
	if err != nil {
		t.Fatalf("Apply(status set) error = %v", err)
	}
	state, err = Apply(state, Action{
		Type:     ActionFilterStatusAdd,
		Statuses: []string{"blocked"},
	}, terminals)
	if err != nil {
		t.Fatalf("Apply(status add) error = %v", err)
	}
	state, err = Apply(state, Action{
		Type:     ActionFilterStatusRemove,
		Statuses: []string{"running"},
	}, terminals)
	if err != nil {
		t.Fatalf("Apply(status remove) error = %v", err)
	}
	if !reflect.DeepEqual(state.StatusFilters, []string{"blocked"}) {
		t.Fatalf("StatusFilters = %#v", state.StatusFilters)
	}

	first := CWDFilter{Status: "running", CWD: "/repo/a"}
	second := CWDFilter{Status: "blocked", CWD: "/repo/b"}
	state, err = Apply(state, Action{
		Type:       ActionFilterCWDSet,
		CWDFilters: []CWDFilter{first, first},
	}, terminals)
	if err != nil {
		t.Fatalf("Apply(cwd set) error = %v", err)
	}
	state, err = Apply(state, Action{
		Type:       ActionFilterCWDAdd,
		CWDFilters: []CWDFilter{second},
	}, terminals)
	if err != nil {
		t.Fatalf("Apply(cwd add) error = %v", err)
	}
	state, err = Apply(state, Action{
		Type:       ActionFilterCWDRemove,
		CWDFilters: []CWDFilter{first},
	}, terminals)
	if err != nil {
		t.Fatalf("Apply(cwd remove) error = %v", err)
	}
	if !reflect.DeepEqual(state.CWDFilters, []CWDFilter{second}) {
		t.Fatalf("CWDFilters = %#v", state.CWDFilters)
	}
}

func TestFilterActionsRejectUnknownStatus(t *testing.T) {
	_, err := Apply(State{}, Action{
		Type:     ActionFilterStatusSet,
		Statuses: []string{"paused"},
	}, []Terminal{{ID: "a", CWD: "/repo", Statuses: []string{"running"}}})
	if !errors.Is(err, ErrInvalidAction) {
		t.Fatalf("Apply(paused) error = %v", err)
	}
}

func TestReconcileRemovesDeletedTerminalsAndRepairsFocus(t *testing.T) {
	state := State{
		ManualTerminalIDs: []string{"deleted", "kept"},
		PinnedTerminalIDs: []string{"deleted"},
		FocusedTerminalID: "deleted",
		Revision:          7,
	}
	terminals := []Terminal{{ID: "kept", CWD: "/repo", Statuses: []string{"terminal"}}}

	next, changed := Reconcile(state, terminals)
	if !changed {
		t.Fatal("Reconcile changed = false, want true")
	}
	if !reflect.DeepEqual(next.ManualTerminalIDs, []string{"kept"}) ||
		len(next.PinnedTerminalIDs) != 0 ||
		next.FocusedTerminalID != "kept" ||
		next.Revision != 8 {
		t.Fatalf("Reconcile state = %#v", next)
	}
}

func TestReconcileAfterTerminalDeletionSelectsReplacement(t *testing.T) {
	terminals := []Terminal{{ID: "next"}, {ID: "last"}}
	previous := Snapshot{
		TerminalIDs:       []string{"deleted"},
		FocusedTerminalID: "deleted",
	}
	state := State{
		ManualTerminalIDs: []string{"deleted"},
		FocusedTerminalID: "deleted",
		Revision:          4,
	}

	next, changed := ReconcileAfterTerminalDeletion(
		state,
		previous,
		"deleted",
		"next",
		terminals,
	)
	if !changed || !reflect.DeepEqual(next.ManualTerminalIDs, []string{"next"}) ||
		next.FocusedTerminalID != "next" {
		t.Fatalf("state = %#v, changed = %v", next, changed)
	}
}

func TestReconcileAfterTerminalDeletionKeepsIntentionalEmptySelection(t *testing.T) {
	state := State{Revision: 4}

	next, changed := ReconcileAfterTerminalDeletion(
		state,
		Snapshot{},
		"deleted",
		"next",
		[]Terminal{{ID: "next"}},
	)
	if changed || len(next.ManualTerminalIDs) != 0 || next.FocusedTerminalID != "" {
		t.Fatalf("state = %#v, changed = %v", next, changed)
	}
}

func TestReconcileAfterTerminalDeletionDoesNotBypassFilters(t *testing.T) {
	state := State{
		ManualTerminalIDs: []string{"deleted"},
		FocusedTerminalID: "deleted",
		StatusFilters:     []string{"waiting"},
		Revision:          4,
	}
	previous := Snapshot{
		TerminalIDs:       []string{"deleted"},
		FocusedTerminalID: "deleted",
		Filters:           Filters{Statuses: []string{"waiting"}},
	}

	next, changed := ReconcileAfterTerminalDeletion(
		state,
		previous,
		"deleted",
		"next",
		[]Terminal{{ID: "next", Statuses: []string{"running"}}},
	)
	if !changed || len(next.ManualTerminalIDs) != 0 || next.FocusedTerminalID != "" {
		t.Fatalf("state = %#v, changed = %v", next, changed)
	}
}

func TestPromoteFocusedAgentKeepsPinsAndClearsOtherSelectionSources(t *testing.T) {
	terminals := []Terminal{
		{ID: "agent", CWD: "/repo", Statuses: []string{"running"}},
		{ID: "pinned", CWD: "/other", Statuses: []string{"waiting"}},
		{ID: "filtered", CWD: "/third", Statuses: []string{"running"}},
	}
	state := State{
		ManualTerminalIDs: []string{"agent"},
		PinnedTerminalIDs: []string{"pinned"},
		FocusedTerminalID: "agent",
		StatusFilters:     []string{"running"},
		Revision:          10,
	}

	next, err := Apply(state, Action{
		Type:              ActionPromoteFocusedAgent,
		FocusedTerminalID: "agent",
	}, terminals)
	if err != nil {
		t.Fatalf("Apply(promote) error = %v", err)
	}
	if !reflect.DeepEqual(next.ManualTerminalIDs, []string{"agent"}) ||
		!reflect.DeepEqual(next.PinnedTerminalIDs, []string{"pinned"}) ||
		next.FocusedTerminalID != "agent" ||
		len(next.StatusFilters) != 0 ||
		len(next.CWDFilters) != 0 {
		t.Fatalf("promoted state = %#v", next)
	}
	snapshot := Resolve(next, terminals)
	if !reflect.DeepEqual(snapshot.TerminalIDs, []string{"agent", "pinned"}) {
		t.Fatalf("TerminalIDs = %#v", snapshot.TerminalIDs)
	}
}

func TestSelectionOrderFollowsTerminalCreationOrder(t *testing.T) {
	terminals := []Terminal{
		{ID: "first", CWD: "/repo", Statuses: []string{"running"}},
		{ID: "second", CWD: "/repo", Statuses: []string{"running"}},
	}
	state := State{
		ManualTerminalIDs: []string{"second", "first", "second"},
		PinnedTerminalIDs: []string{"second"},
	}

	snapshot := Resolve(state, terminals)
	if !reflect.DeepEqual(snapshot.TerminalIDs, []string{"first", "second"}) {
		t.Fatalf("TerminalIDs = %#v", snapshot.TerminalIDs)
	}
}
