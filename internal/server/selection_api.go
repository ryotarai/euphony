package server

import (
	"errors"
	"net/http"

	"github.com/ryotarai/euphony/internal/selection"
)

func (s *Server) apiGetSelection(w http.ResponseWriter, _ *http.Request) {
	writeAPIResult(w, http.StatusOK, s.control.Selection())
}

func (s *Server) apiReplaceSelection(w http.ResponseWriter, r *http.Request) {
	var request struct {
		ManualTerminalIDs []string          `json:"manualTerminalIds"`
		PinnedTerminalIDs []string          `json:"pinnedTerminalIds"`
		FocusedTerminalID string            `json:"focusedTerminalId"`
		Filters           selection.Filters `json:"filters"`
		PinnedFilters     selection.Filters `json:"pinnedFilters"`
		ExpectedRevision  *uint64           `json:"expectedRevision"`
	}
	if err := decodeAPIJSON(r, &request); err != nil {
		writeAPIDecodeError(w, err, "Provide one valid complete selection.")
		return
	}
	snapshot, err := s.control.ApplySelection(r.Context(), selection.Action{
		Type:              selection.ActionReplaceState,
		TerminalIDs:       request.ManualTerminalIDs,
		PinnedTerminalIDs: request.PinnedTerminalIDs,
		FocusedTerminalID: request.FocusedTerminalID,
		Statuses:          request.Filters.Statuses,
		CWDFilters:        request.Filters.CWDs,
		PinnedStatuses:    request.PinnedFilters.Statuses,
		PinnedCWDFilters:  request.PinnedFilters.CWDs,
		ExpectedRevision:  request.ExpectedRevision,
	})
	if err != nil {
		writeSelectionError(w, err)
		return
	}
	writeAPIResult(w, http.StatusOK, snapshot)
}

func (s *Server) apiApplySelection(w http.ResponseWriter, r *http.Request) {
	var action selection.Action
	if err := decodeAPIJSON(r, &action); err != nil {
		writeAPIDecodeError(w, err, "Provide one valid selection action.")
		return
	}
	snapshot, err := s.control.ApplySelection(r.Context(), action)
	if err != nil {
		writeSelectionError(w, err)
		return
	}
	writeAPIResult(w, http.StatusOK, snapshot)
}

func writeSelectionError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, selection.ErrRevisionConflict):
		writeAPIError(w, http.StatusConflict, "selection_conflict",
			"The selection revision is stale.", nil)
	case errors.Is(err, selection.ErrTerminalNotFound):
		writeAPIError(w, http.StatusNotFound, "terminal_not_found",
			"A selected terminal does not exist.", nil)
	case errors.Is(err, selection.ErrTerminalNotSelected):
		writeAPIError(w, http.StatusConflict, "terminal_not_selected",
			"The focused terminal is not selected.", nil)
	case errors.Is(err, selection.ErrInvalidAction):
		writeAPIError(w, http.StatusBadRequest, "invalid_selection_action",
			"The selection action is not supported.", nil)
	default:
		writeAPIError(w, http.StatusInternalServerError, "selection_update_failed",
			"The shared selection could not be updated.", nil)
	}
}
