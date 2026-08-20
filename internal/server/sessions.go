package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/ryotarai/euphony/internal/control"
	"github.com/ryotarai/euphony/internal/session"
)

func (s *Server) listSessions(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.sessions.ListCurrent())
	s.sessions.RefreshMetadata()
}

func (s *Server) createSession(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Name string `json:"name"`
		CWD  string `json:"cwd"`
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Provide a valid session name.")
		return
	}
	if err := ensureJSONEnd(decoder); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Provide one JSON object.")
		return
	}
	if strings.TrimSpace(request.Name) == "" || len(request.Name) > 80 {
		writeError(w, http.StatusBadRequest, "invalid_name", "Session names must contain 1 to 80 characters.")
		return
	}
	metadata, err := s.sessions.Create(r.Context(), request.Name, request.CWD)
	if err != nil {
		if strings.Contains(err.Error(), "working directory") {
			writeError(w, http.StatusBadRequest, "invalid_cwd", "Choose an existing working directory.")
			return
		}
		writeError(w, http.StatusInternalServerError, "pty_start_failed", "The terminal process could not start.")
		return
	}
	writeJSON(w, http.StatusCreated, metadata)
}

func (s *Server) deleteSession(w http.ResponseWriter, r *http.Request) {
	err := s.sessions.Delete(r.PathValue("id"))
	if errors.Is(err, session.ErrNotFound) {
		writeError(w, http.StatusNotFound, "session_not_found", "The terminal session does not exist.")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "session_delete_failed", "The terminal session could not be removed.")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) archiveSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	selectionSnapshot, err := s.control.ArchiveAgentSessionContext(r.Context(), id)
	if errors.Is(err, session.ErrAgentSessionNotReady) {
		writeError(w, http.StatusConflict, "agent_session_not_ready",
			"The agent session is not ready to be archived yet.")
		return
	}
	if errors.Is(err, control.ErrTerminalNotFound) {
		writeError(w, http.StatusNotFound, "session_not_found", "The agent session does not exist.")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "session_archive_failed", "The agent session could not be archived.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":        id,
		"selection": selectionSnapshot,
	})
}

func (s *Server) acknowledgeAttention(w http.ResponseWriter, r *http.Request) {
	metadata, err := s.sessions.AcknowledgeAttention(r.PathValue("id"))
	if errors.Is(err, session.ErrNotFound) {
		writeError(w, http.StatusNotFound, "session_not_found", "The terminal session does not exist.")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "attention_acknowledge_failed",
			"The terminal attention state could not be acknowledged.")
		return
	}
	writeJSON(w, http.StatusOK, metadata)
}

func (s *Server) createTicket(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, ok := s.sessions.Get(id); !ok {
		writeError(w, http.StatusNotFound, "session_not_found", "The terminal session does not exist.")
		return
	}
	ticket, err := s.tickets.create(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "ticket_failed", "A terminal connection ticket could not be created.")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"ticket": ticket})
}

func ensureJSONEnd(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("additional JSON value")
		}
		return err
	}
	return nil
}
