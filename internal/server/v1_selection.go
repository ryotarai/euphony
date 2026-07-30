package server

import (
	"errors"
	"net/http"

	"github.com/ryotarai/euphony/internal/selection"
)

func (s *Server) v1GetSelection(w http.ResponseWriter, _ *http.Request) {
	writeV1Result(w, http.StatusOK, s.control.Selection())
}

func (s *Server) v1ReplaceSelection(w http.ResponseWriter, r *http.Request) {
	var request struct {
		ManualTerminalIDs []string          `json:"manualTerminalIds"`
		PinnedTerminalIDs []string          `json:"pinnedTerminalIds"`
		FocusedTerminalID string            `json:"focusedTerminalId"`
		Filters           selection.Filters `json:"filters"`
		ExpectedRevision  *uint64           `json:"expectedRevision"`
	}
	if err := decodeV1JSON(r, &request); err != nil {
		writeV1Error(w, http.StatusBadRequest, "invalid_request",
			"Provide one valid complete selection.", nil)
		return
	}
	snapshot, err := s.control.ApplySelection(r.Context(), selection.Action{
		Type:              selection.ActionReplaceState,
		TerminalIDs:       request.ManualTerminalIDs,
		PinnedTerminalIDs: request.PinnedTerminalIDs,
		FocusedTerminalID: request.FocusedTerminalID,
		Statuses:          request.Filters.Statuses,
		CWDFilters:        request.Filters.CWDs,
		ExpectedRevision:  request.ExpectedRevision,
	})
	if err != nil {
		writeSelectionError(w, err)
		return
	}
	writeV1Result(w, http.StatusOK, snapshot)
}

func (s *Server) v1ApplySelection(w http.ResponseWriter, r *http.Request) {
	var action selection.Action
	if err := decodeV1JSON(r, &action); err != nil {
		writeV1Error(w, http.StatusBadRequest, "invalid_request",
			"Provide one valid selection action.", nil)
		return
	}
	snapshot, err := s.control.ApplySelection(r.Context(), action)
	if err != nil {
		writeSelectionError(w, err)
		return
	}
	writeV1Result(w, http.StatusOK, snapshot)
}

func writeSelectionError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, selection.ErrRevisionConflict):
		writeV1Error(w, http.StatusConflict, "selection_conflict",
			"The selection revision is stale.", nil)
	case errors.Is(err, selection.ErrTerminalNotFound):
		writeV1Error(w, http.StatusNotFound, "terminal_not_found",
			"A selected terminal does not exist.", nil)
	case errors.Is(err, selection.ErrTerminalNotSelected):
		writeV1Error(w, http.StatusConflict, "terminal_not_selected",
			"The focused terminal is not selected.", nil)
	case errors.Is(err, selection.ErrInvalidAction):
		writeV1Error(w, http.StatusBadRequest, "invalid_selection_action",
			"The selection action is not supported.", nil)
	default:
		writeV1Error(w, http.StatusInternalServerError, "selection_update_failed",
			"The shared selection could not be updated.", nil)
	}
}
