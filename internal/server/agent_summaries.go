package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"

	"github.com/ryotarai/euphony/internal/agentsummary"
	"github.com/ryotarai/euphony/internal/control"
	"github.com/ryotarai/euphony/internal/session"
)

const maxAgentActionScreenBytes = 128 << 10

type executeAgentSummaryOptionRequest struct {
	ScreenText *string `json:"screenText"`
}

func decodeExecuteAgentSummaryOptionRequest(r *http.Request) (executeAgentSummaryOptionRequest, error) {
	var request executeAgentSummaryOptionRequest
	if r.Body == nil {
		return request, nil
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxAgentActionScreenBytes))
	if err := decoder.Decode(&request); errors.Is(err, io.EOF) {
		return request, nil
	} else if err != nil {
		return request, err
	}
	return request, nil
}

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

func (s *Server) markAgentSummaryDone(w http.ResponseWriter, r *http.Request) {
	summary, err := s.sessions.MarkAgentSummaryDone(r.Context(), r.PathValue("id"))
	switch {
	case errors.Is(err, session.ErrAgentSummaryNotFound):
		writeError(w, http.StatusNotFound, "agent_summary_not_found", "The agent summary does not exist.")
		return
	case err != nil:
		writeError(w, http.StatusInternalServerError, "agent_summary_done_failed", "The agent summary could not be marked as done.")
		return
	}
	s.summaryEvents.Publish("agent.summary.updated", summary)
	writeJSON(w, http.StatusOK, summary)
}

func (s *Server) executeAgentSummaryOption(w http.ResponseWriter, r *http.Request) {
	request, err := decodeExecuteAgentSummaryOptionRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "agent_summary_action_invalid_request", "The terminal screen payload is invalid.")
		return
	}
	terminalID := r.PathValue("id")
	optionID := r.PathValue("optionID")
	var current session.AgentSummary
	found := false
	for _, summary := range s.sessions.AgentSummaries() {
		if summary.TerminalID == terminalID {
			current = summary
			found = true
			break
		}
	}
	if !found {
		writeError(w, http.StatusNotFound, "agent_summary_not_found", "The agent summary does not exist.")
		return
	}
	if current.Done || current.Action == "" ||
		(current.Status != "waiting" && current.Status != "blocked") {
		writeError(w, http.StatusConflict, "agent_summary_not_actionable", "The agent summary no longer requires an action.")
		return
	}
	var option session.AgentSummaryOption
	for _, candidate := range current.Options {
		if candidate.ID == optionID {
			option = candidate
			break
		}
	}
	if option.ID == "" {
		writeError(w, http.StatusNotFound, "agent_summary_option_not_found", "The agent summary option does not exist.")
		return
	}
	err = s.control.RunTerminalAutomationWithScreenAndWrite(r.Context(), terminalID,
		func(ctx context.Context, screen control.TerminalRead) ([]byte, error) {
			settings := s.sessions.Settings()
			provider := settings.AgentSummaryProvider
			if !validAgentSummaryProvider(provider) {
				provider = current.Provider
			}
			if !validAgentSummaryProvider(provider) {
				provider = session.DefaultAgentSummaryProvider
			}
			effort := settings.AgentSummaryOpenAIEffort
			if effort == "" {
				effort = session.DefaultAgentSummaryOpenAIEffort
			}
			screenText := screen.Text
			if request.ScreenText != nil {
				screenText = *request.ScreenText
			}
			prompt := agentsummary.BuildTerminalActionPrompt(current, option, screenText)
			generation, err := s.actionRunner.GenerateTerminalAction(ctx, provider, prompt, effort)
			if err != nil {
				return nil, err
			}
			return []byte(agentsummary.NormalizeTerminalActionInput(generation.Input)), nil
		},
		func(ctx context.Context, data []byte) (int, error) {
			return s.sessions.WriteTerminalIfAgentSummaryCurrent(ctx, current, data)
		},
	)
	if err != nil {
		switch {
		case errors.Is(err, session.ErrAgentSummaryChanged):
			writeError(w, http.StatusConflict, "agent_summary_changed", "The agent summary changed while the action was running.")
		case errors.Is(err, session.ErrAgentSummaryNotFound):
			writeError(w, http.StatusNotFound, "agent_summary_not_found", "The agent summary does not exist.")
		case errors.Is(err, control.ErrTerminalLocked):
			writeError(w, http.StatusConflict, "terminal_locked", "The terminal is being controlled by Inbox.")
		case errors.Is(err, control.ErrTerminalNotFound):
			writeError(w, http.StatusNotFound, "terminal_not_found", "The terminal does not exist.")
		case errors.Is(err, control.ErrInvalidInput):
			writeError(w, http.StatusBadGateway, "agent_summary_action_invalid", "The AI returned invalid terminal input.")
		default:
			writeError(w, http.StatusBadGateway, "agent_summary_action_failed", "The AI could not determine a terminal operation.")
		}
		return
	}
	summary, err := s.sessions.MarkAgentSummaryDoneIfCurrent(r.Context(), current)
	switch {
	case errors.Is(err, session.ErrAgentSummaryNotFound):
		writeError(w, http.StatusNotFound, "agent_summary_not_found", "The agent summary does not exist.")
		return
	case errors.Is(err, session.ErrAgentSummaryChanged):
		writeError(w, http.StatusConflict, "agent_summary_changed", "The agent summary changed while the action was running.")
		return
	case err != nil:
		writeError(w, http.StatusInternalServerError, "agent_summary_done_failed", "The agent summary could not be marked as done.")
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

func (s *Server) refreshAgentSummaries(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusAccepted, map[string]int{
		"queued": s.summaries.RefreshAll(),
	})
}

func activeAgentMetadata(metadata session.Metadata) bool {
	return metadata.Agent != "" &&
		(metadata.AgentStatus == "running" || metadata.AgentStatus == "waiting" || metadata.AgentStatus == "blocked")
}
