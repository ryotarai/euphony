package server

import (
	"net/http"

	"github.com/ryotarai/euphony/internal/session"
)

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
