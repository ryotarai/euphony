package selection

import "errors"

var (
	ErrInvalidAction       = errors.New("invalid selection action")
	ErrRevisionConflict    = errors.New("selection revision conflict")
	ErrTerminalNotFound    = errors.New("terminal not found")
	ErrTerminalNotSelected = errors.New("terminal not selected")
)

type Terminal struct {
	ID       string
	CWD      string
	Statuses []string
}

type CWDFilter struct {
	Status string `json:"status"`
	CWD    string `json:"cwd"`
}

type Filters struct {
	Statuses []string    `json:"statuses"`
	CWDs     []CWDFilter `json:"cwds"`
}

type State struct {
	ManualTerminalIDs []string    `json:"manualTerminalIds"`
	PinnedTerminalIDs []string    `json:"pinnedTerminalIds"`
	FocusedTerminalID string      `json:"focusedTerminalId,omitempty"`
	StatusFilters     []string    `json:"statusFilters"`
	CWDFilters        []CWDFilter `json:"cwdFilters"`
	PinnedFilters     Filters     `json:"pinnedFilters"`
	Revision          uint64      `json:"revision"`
}

type Snapshot struct {
	TerminalIDs       []string `json:"terminalIds"`
	ManualTerminalIDs []string `json:"manualTerminalIds"`
	PinnedTerminalIDs []string `json:"pinnedTerminalIds"`
	FocusedTerminalID string   `json:"focusedTerminalId,omitempty"`
	Filters           Filters  `json:"filters"`
	PinnedFilters     Filters  `json:"pinnedFilters"`
	Revision          uint64   `json:"revision"`
}

type ActionType string

const (
	ActionReplace             ActionType = "replace"
	ActionReplaceState        ActionType = "replace_state"
	ActionAdd                 ActionType = "add"
	ActionRemove              ActionType = "remove"
	ActionFocus               ActionType = "focus"
	ActionPin                 ActionType = "pin"
	ActionUnpin               ActionType = "unpin"
	ActionFilterStatusSet     ActionType = "filter_status_set"
	ActionFilterStatusAdd     ActionType = "filter_status_add"
	ActionFilterStatusRemove  ActionType = "filter_status_remove"
	ActionFilterCWDSet        ActionType = "filter_cwd_set"
	ActionFilterCWDAdd        ActionType = "filter_cwd_add"
	ActionFilterCWDRemove     ActionType = "filter_cwd_remove"
	ActionPromoteFocusedAgent ActionType = "promote_focused_agent"
)

type Action struct {
	Type              ActionType  `json:"type"`
	TerminalIDs       []string    `json:"terminalIds,omitempty"`
	PinnedTerminalIDs []string    `json:"pinnedTerminalIds,omitempty"`
	FocusedTerminalID string      `json:"focusedTerminalId,omitempty"`
	Statuses          []string    `json:"statuses,omitempty"`
	CWDFilters        []CWDFilter `json:"cwdFilters,omitempty"`
	PinnedStatuses    []string    `json:"pinnedStatuses,omitempty"`
	PinnedCWDFilters  []CWDFilter `json:"pinnedCwdFilters,omitempty"`
	ExpectedRevision  *uint64     `json:"expectedRevision,omitempty"`
}
