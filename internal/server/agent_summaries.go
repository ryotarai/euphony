package server

import (
	"errors"
	"net/http"
	"sync"

	"github.com/ryotarai/euphony/internal/control"
	"github.com/ryotarai/euphony/internal/session"
)

// agentSummaryEventPublisher serializes summary event publication and reads
// the manager's normalized value immediately before each event. Summary
// generation and read requests persist through the manager in parallel; this
// keeps a delayed producer from publishing an older unread bit after a newer
// read transition has already completed.
type agentSummaryEventPublisher struct {
	events   *control.Service
	sessions *session.Manager
	mu       sync.Mutex
}

func newAgentSummaryEventPublisher(events *control.Service, sessions *session.Manager) *agentSummaryEventPublisher {
	return &agentSummaryEventPublisher{events: events, sessions: sessions}
}

func (p *agentSummaryEventPublisher) SubscribeEvents(types []string) (<-chan control.Event, func()) {
	return p.events.SubscribeEvents(types)
}

func (p *agentSummaryEventPublisher) Publish(eventType string, data any) control.Event {
	if eventType != "agent.summary.updated" {
		return p.events.Publish(eventType, data)
	}
	summary, ok := data.(session.AgentSummary)
	if !ok {
		return p.events.Publish(eventType, data)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	found := false
	for _, current := range p.sessions.AgentSummaries() {
		if current.TerminalID == summary.TerminalID {
			summary = current
			found = true
			break
		}
	}
	if !found {
		return control.Event{}
	}
	return p.events.Publish(eventType, summary)
}

func (s *Server) markAgentSummaryRead(w http.ResponseWriter, r *http.Request) {
	summary, err := s.sessions.MarkAgentSummaryRead(r.Context(), r.PathValue("id"))
	switch {
	// Agent-summary lookup has its own not-found sentinel, distinct from terminal lookup.
	case errors.Is(err, session.ErrAgentSummaryNotFound):
		writeError(w, http.StatusNotFound, "agent_summary_not_found", "The agent summary does not exist.")
		return
	case err != nil:
		writeError(w, http.StatusInternalServerError, "agent_summary_read_failed", "The agent summary could not be marked as read.")
		return
	}
	s.summaryEvents.Publish("agent.summary.updated", summary)
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
