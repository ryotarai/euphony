package server

import (
	"errors"
	"net/http"

	"github.com/ryotarai/euphony/internal/session"
)

func (s *Server) markAgentSummaryRead(w http.ResponseWriter, r *http.Request) {
	summary, err := s.sessions.MarkAgentSummaryRead(r.Context(), r.PathValue("id"))
	switch {
	case errors.Is(err, session.ErrAgentSummaryNotFound):
		writeError(w, http.StatusNotFound, "agent_summary_not_found", "The agent summary does not exist.")
		return
	case err != nil:
		writeError(w, http.StatusInternalServerError, "agent_summary_read_failed", "The agent summary could not be marked as read.")
		return
	}
	s.control.Publish("agent.summary.updated", summary)
	writeJSON(w, http.StatusOK, summary)
}

func (s *Server) listAgentSummaries(w http.ResponseWriter, _ *http.Request) {
	summaries := make(map[string]session.AgentSummary)
	for _, summary := range s.sessions.AgentSummaries() {
		summaries[summary.TerminalID] = summary
	}
	result := make([]session.AgentSummary, 0, len(summaries))
	for _, metadata := range s.sessions.ListCurrent() {
		if !activeAgentMetadata(metadata) {
			continue
		}
		if summary, ok := summaries[metadata.ID]; ok {
			result = append(result, summary)
		}
	}
	writeJSON(w, http.StatusOK, result)
}

func activeAgentMetadata(metadata session.Metadata) bool {
	return metadata.Agent != "" &&
		(metadata.AgentStatus == "running" || metadata.AgentStatus == "waiting" || metadata.AgentStatus == "blocked")
}
