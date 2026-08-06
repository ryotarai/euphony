package server

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/ryotarai/euphony/internal/agentsummary"
	"github.com/ryotarai/euphony/internal/session"
)

func TestAgentSummariesEndpointReturnsCurrentSummariesInSessionOrder(t *testing.T) {
	srv, err := New(Config{
		Token: "token", Shell: "/bin/sh",
		DatabasePath:  filepath.Join(t.TempDir(), "euphony.sqlite3"),
		SummaryRunner: blockingSummaryRunner{},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	first, err := srv.sessions.Create(context.Background(), "First", t.TempDir())
	if err != nil {
		t.Fatalf("Create(first) error = %v", err)
	}
	first, err = srv.sessions.UpdateAgent(first.ID, session.AgentUpdate{
		Agent: "codex", AgentSessionID: "thread-1", Status: "running",
	})
	if err != nil {
		t.Fatalf("UpdateAgent(first) error = %v", err)
	}
	second, err := srv.sessions.Create(context.Background(), "Second", t.TempDir())
	if err != nil {
		t.Fatalf("Create(second) error = %v", err)
	}
	second, err = srv.sessions.UpdateAgent(second.ID, session.AgentUpdate{
		Agent: "claude", AgentSessionID: "thread-2", Status: "waiting",
	})
	if err != nil {
		t.Fatalf("UpdateAgent(second) error = %v", err)
	}
	if err := srv.sessions.SaveAgentSummary(context.Background(), session.AgentSummary{
		TerminalID: first.ID, Provider: "codex", Status: "running",
		Summary: "Updating the API.", GeneratedAt: time.Date(2026, 8, 5, 1, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("SaveAgentSummary(first) error = %v", err)
	}
	if err := srv.sessions.SaveAgentSummary(context.Background(), session.AgentSummary{
		TerminalID: second.ID, Provider: "claude", Status: "waiting",
		Summary: "Waiting for a decision.", Action: "Answer the question.",
		GeneratedAt: time.Date(2026, 8, 5, 1, 1, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("SaveAgentSummary(second) error = %v", err)
	}
	plain, err := srv.sessions.Create(context.Background(), "Shell", t.TempDir())
	if err != nil {
		t.Fatalf("Create(plain) error = %v", err)
	}
	if err := srv.sessions.SaveAgentSummary(context.Background(), session.AgentSummary{
		TerminalID: plain.ID, Provider: "claude", Status: "running", Summary: "Do not show me.",
		GeneratedAt: time.Date(2026, 8, 5, 1, 2, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("SaveAgentSummary(plain) error = %v", err)
	}

	response := performRequest(t, srv, http.MethodGet, "/api/agent-summaries", "")
	if response.Code != http.StatusOK {
		t.Fatalf("GET /api/agent-summaries status = %d, body = %s", response.Code, response.Body.String())
	}
	var got []session.AgentSummary
	decodeResponse(t, response, &got)
	want := []session.AgentSummary{
		{TerminalID: first.ID, Provider: "codex", Status: "running", Summary: "Updating the API.", Unread: true, GeneratedAt: time.Date(2026, 8, 5, 1, 0, 0, 0, time.UTC)},
		{TerminalID: second.ID, Provider: "claude", Status: "waiting", Summary: "Waiting for a decision.", Action: "Answer the question.", Unread: true, GeneratedAt: time.Date(2026, 8, 5, 1, 1, 0, 0, time.UTC)},
	}
	if !jsonEqual(got, want) {
		t.Fatalf("summaries = %#v, want %#v", got, want)
	}
}

func TestMarkAgentSummaryReadEndpointUpdatesAndPublishesSummary(t *testing.T) {
	srv, err := New(Config{
		Token: "token", Shell: "/bin/sh",
		SummaryRunner: blockingSummaryRunner{},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	terminal, err := srv.sessions.Create(context.Background(), "Agent", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := srv.sessions.UpdateAgent(terminal.ID, session.AgentUpdate{
		Agent: "codex", Status: "waiting",
	}); err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
	if err := srv.sessions.SaveAgentSummary(context.Background(), session.AgentSummary{
		TerminalID: terminal.ID,
		Provider:   "codex",
		Status:     "waiting",
		Summary:    "Waiting for input.",
		Action:     "Provide the requested input.",
		GeneratedAt: time.Date(
			2026, 8, 5, 1, 0, 0, 0, time.UTC,
		),
	}); err != nil {
		t.Fatalf("SaveAgentSummary() error = %v", err)
	}

	events, unsubscribe := srv.control.SubscribeEvents([]string{"agent.summary.updated"})
	defer unsubscribe()
	path := "/api/agent-summaries/" + terminal.ID + "/read"
	first := performRequest(t, srv, http.MethodPost, path, "")
	if first.Code != http.StatusOK {
		t.Fatalf("first POST status = %d, body = %s", first.Code, first.Body.String())
	}
	var firstSummary session.AgentSummary
	decodeResponse(t, first, &firstSummary)
	if firstSummary.TerminalID != terminal.ID || firstSummary.Unread {
		t.Fatalf("first response = %#v, want terminal %q read", firstSummary, terminal.ID)
	}

	select {
	case event := <-events:
		got, ok := event.Data.(session.AgentSummary)
		if event.Type != "agent.summary.updated" || !ok || got.TerminalID != terminal.ID || got.Unread {
			t.Fatalf("event = %#v, want read summary for terminal %q", event, terminal.ID)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for agent.summary.updated")
	}

	second := performRequest(t, srv, http.MethodPost, path, "")
	if second.Code != http.StatusOK {
		t.Fatalf("second POST status = %d, body = %s", second.Code, second.Body.String())
	}
	var secondSummary session.AgentSummary
	decodeResponse(t, second, &secondSummary)
	if secondSummary != firstSummary || secondSummary.Unread {
		t.Fatalf("second response = %#v, want %#v", secondSummary, firstSummary)
	}

	missing := performRequest(t, srv, http.MethodPost, "/api/agent-summaries/missing/read", "")
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing POST status = %d, body = %s", missing.Code, missing.Body.String())
	}
	var missingError errorResponse
	decodeResponse(t, missing, &missingError)
	if missingError.Code != "agent_summary_not_found" {
		t.Fatalf("missing error code = %q, want agent_summary_not_found", missingError.Code)
	}
}

type blockingSummaryRunner struct{}

func (blockingSummaryRunner) Generate(ctx context.Context, _ string, _ string) (agentsummary.Generation, error) {
	<-ctx.Done()
	return agentsummary.Generation{}, ctx.Err()
}

func TestAgentSummaryEventsUseTheExistingEventHub(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	events, unsubscribe := srv.control.SubscribeEvents([]string{"agent.summary.updated"})
	defer unsubscribe()
	want := session.AgentSummary{
		TerminalID: "terminal-1", Provider: "claude", Status: "blocked", Summary: "Needs permission.", Action: "Approve it.",
		GeneratedAt: time.Date(2026, 8, 5, 1, 0, 0, 0, time.UTC),
	}
	srv.control.Publish("agent.summary.updated", want)
	select {
	case event := <-events:
		got, ok := event.Data.(session.AgentSummary)
		if !ok || got != want {
			t.Fatalf("event = %#v, want summary %#v", event, want)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for agent.summary.updated")
	}
}

func jsonEqual[T any](left, right T) bool {
	leftJSON, _ := json.Marshal(left)
	rightJSON, _ := json.Marshal(right)
	return string(leftJSON) == string(rightJSON)
}
