package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/ryotarai/euphony/internal/session"
)

func (s *Server) updateTerminalHook(w http.ResponseWriter, r *http.Request) {
	var request struct {
		TerminalID          string `json:"terminalId"`
		Agent               string `json:"agent"`
		ResumeAgent         string `json:"resumeAgent"`
		AgentSessionID      string `json:"agentSessionId"`
		AgentTranscriptPath string `json:"agentTranscriptPath"`
		Status              string `json:"status"`
		Title               string `json:"title"`
		CWD                 string `json:"cwd"`
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil || ensureJSONEnd(decoder) != nil ||
		strings.TrimSpace(request.TerminalID) == "" ||
		!validHookAgent(request.Agent) || !validHookAgent(request.ResumeAgent) ||
		!validHookStatus(request.Status) ||
		len(request.AgentSessionID) > 200 || len(request.Status) > 40 ||
		len(request.AgentTranscriptPath) > 8192 ||
		len(request.Title) > 240 || len(request.CWD) > 4096 {
		writeError(w, http.StatusBadRequest, "invalid_hook", "Provide valid terminal activity.")
		return
	}
	metadata, err := s.sessions.UpdateAgent(request.TerminalID, session.AgentUpdate{
		Agent: request.Agent, ResumeAgent: request.ResumeAgent,
		AgentSessionID: request.AgentSessionID, Status: request.Status,
		TranscriptPath: request.AgentTranscriptPath,
		Title:          request.Title, CWD: request.CWD,
	})
	if errors.Is(err, session.ErrNotFound) {
		writeError(w, http.StatusNotFound, "session_not_found", "The terminal session does not exist.")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "session_update_failed", "The terminal activity could not be saved.")
		return
	}
	writeJSON(w, http.StatusOK, metadata)
}

func validHookAgent(value string) bool {
	switch strings.TrimSpace(value) {
	case "", "codex", "claude":
		return true
	default:
		return false
	}
}

func validHookStatus(value string) bool {
	switch strings.TrimSpace(value) {
	case "", "running", "waiting", "blocked":
		return true
	default:
		return false
	}
}
