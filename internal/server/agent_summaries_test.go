package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ryotarai/euphony/internal/agentsummary"
	"github.com/ryotarai/euphony/internal/control"
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

func TestRefreshAgentSummariesEndpointQueuesAllCurrentAgents(t *testing.T) {
	srv, err := New(Config{
		Token: "token", Shell: "/bin/sh", SummaryRunner: blockingSummaryRunner{},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	for _, status := range []string{"running", "waiting", "blocked"} {
		terminal, err := srv.sessions.Create(context.Background(), "Agent", t.TempDir())
		if err != nil {
			t.Fatalf("Create(%s) error = %v", status, err)
		}
		agent := "codex"
		if status == "blocked" {
			agent = "claude"
		}
		if _, err := srv.sessions.UpdateAgent(terminal.ID, session.AgentUpdate{
			Agent: agent, Status: status,
		}); err != nil {
			t.Fatalf("UpdateAgent(%s) error = %v", status, err)
		}
	}
	if _, err := srv.sessions.Create(context.Background(), "Shell", t.TempDir()); err != nil {
		t.Fatalf("Create(plain) error = %v", err)
	}

	response := performRequest(t, srv, http.MethodPost, "/api/agent-summaries/refresh", "")
	if response.Code != http.StatusAccepted {
		t.Fatalf("POST refresh status = %d, body = %s", response.Code, response.Body.String())
	}
	var result struct {
		Queued int `json:"queued"`
	}
	decodeResponse(t, response, &result)
	if result.Queued != 3 {
		t.Fatalf("queued = %d, want 3", result.Queued)
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
	if !reflect.DeepEqual(secondSummary, firstSummary) || secondSummary.Unread {
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
	if missingError.Message != "The agent summary does not exist." {
		t.Fatalf("missing error message = %q, want agent summary not found message", missingError.Message)
	}
}

func TestMarkAgentSummaryDoneEndpointUpdatesAndPublishesSummary(t *testing.T) {
	srv, err := New(Config{
		Token: "token", Shell: "/bin/sh", SummaryRunner: blockingSummaryRunner{},
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
		TerminalID: terminal.ID, Provider: "codex", Status: "waiting",
		Summary: "Waiting for input.", Action: "Provide the requested input.", Priority: "high",
	}); err != nil {
		t.Fatalf("SaveAgentSummary() error = %v", err)
	}

	events, unsubscribe := srv.control.SubscribeEvents([]string{"agent.summary.updated"})
	defer unsubscribe()
	path := "/api/agent-summaries/" + terminal.ID + "/done"
	response := performRequest(t, srv, http.MethodPost, path, "")
	if response.Code != http.StatusOK {
		t.Fatalf("POST done status = %d, body = %s", response.Code, response.Body.String())
	}
	var got session.AgentSummary
	decodeResponse(t, response, &got)
	if got.TerminalID != terminal.ID || !got.Done || got.Unread || got.Priority != "high" {
		t.Fatalf("done response = %#v, want done=true unread=false priority=high", got)
	}
	select {
	case event := <-events:
		published, ok := event.Data.(session.AgentSummary)
		if event.Type != "agent.summary.updated" || !ok || !published.Done || published.Unread {
			t.Fatalf("event = %#v, want done summary", event)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for agent.summary.updated")
	}

	second := performRequest(t, srv, http.MethodPost, path, "")
	if second.Code != http.StatusOK {
		t.Fatalf("second POST done status = %d, body = %s", second.Code, second.Body.String())
	}
	var secondSummary session.AgentSummary
	decodeResponse(t, second, &secondSummary)
	if !reflect.DeepEqual(secondSummary, got) {
		t.Fatalf("second done response = %#v, want %#v", secondSummary, got)
	}

	missing := performRequest(t, srv, http.MethodPost, "/api/agent-summaries/missing/done", "")
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing POST done status = %d, body = %s", missing.Code, missing.Body.String())
	}
}

func TestMarkAgentSummaryReadEndpointReturns500WithoutPublishingOnCanceledPersistence(t *testing.T) {
	srv, err := New(Config{
		Token: "token", Shell: "/bin/sh",
		DatabasePath:  filepath.Join(t.TempDir(), "euphony.sqlite3"),
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
		TerminalID: terminal.ID, Provider: "codex", Status: "waiting",
		Summary: "Waiting for input.", Action: "Provide the requested input.",
	}); err != nil {
		t.Fatalf("SaveAgentSummary() error = %v", err)
	}

	events, unsubscribe := srv.control.SubscribeEvents([]string{"agent.summary.updated"})
	defer unsubscribe()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequestWithContext(ctx, http.MethodPost,
		"/api/agent-summaries/"+terminal.ID+"/read", bytes.NewBufferString("{}"))
	request.Header.Set("Authorization", "Bearer token")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	srv.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("canceled POST status = %d, body = %s", response.Code, response.Body.String())
	}
	var failure errorResponse
	decodeResponse(t, response, &failure)
	if failure.Code != "agent_summary_read_failed" ||
		failure.Message != "The agent summary could not be marked as read." {
		t.Fatalf("canceled POST error = %#v, want agent_summary_read_failed", failure)
	}
	if got := srv.sessions.AgentSummaries()[0]; !got.Unread {
		t.Fatalf("summary after canceled POST = %#v, want unread rollback", got)
	}
	select {
	case event := <-events:
		t.Fatalf("unexpected event after canceled POST: %#v", event)
	default:
	}
}

func TestAgentSummaryEventPublisherUsesCurrentManagerState(t *testing.T) {
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
	if err := srv.sessions.SaveAgentSummary(context.Background(), session.AgentSummary{
		TerminalID: terminal.ID, Provider: "codex", Status: "running",
		Summary: "Working.", Unread: true,
	}); err != nil {
		t.Fatalf("SaveAgentSummary() error = %v", err)
	}
	if _, err := srv.sessions.MarkAgentSummaryRead(context.Background(), terminal.ID); err != nil {
		t.Fatalf("MarkAgentSummaryRead() error = %v", err)
	}

	events, unsubscribe := srv.control.SubscribeEvents([]string{"agent.summary.updated"})
	defer unsubscribe()
	srv.summaryEvents.Publish("agent.summary.updated", session.AgentSummary{
		TerminalID: terminal.ID, Provider: "codex", Status: "running",
		Summary: "Working.", Unread: true,
	})
	select {
	case event := <-events:
		got, ok := event.Data.(session.AgentSummary)
		if !ok || got.Unread {
			t.Fatalf("published event = %#v, want manager-normalized unread=false", event)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for agent.summary.updated")
	}
}

func TestAgentSummaryEventPublisherDropsDeletedSummary(t *testing.T) {
	srv, err := New(Config{
		Token: "token", Shell: "/bin/sh",
		SummaryRunner: blockingSummaryRunner{},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	events, unsubscribe := srv.control.SubscribeEvents([]string{"agent.summary.updated"})
	defer unsubscribe()
	got := srv.summaryEvents.Publish("agent.summary.updated", session.AgentSummary{
		TerminalID: "deleted-terminal", Provider: "codex", Status: "running",
		Summary: "This summary must not be resurrected.", Unread: true,
	})
	if got.Type != "" {
		t.Fatalf("published event = %#v, want zero event for deleted summary", got)
	}
	select {
	case event := <-events:
		t.Fatalf("unexpected event for deleted summary: %#v", event)
	default:
	}
}

func TestExecuteAgentSummaryOptionMarksDonePublishesAndRejectsInvalidOption(t *testing.T) {
	srv, err := New(Config{
		Token: "token", Shell: "/bin/sh", SummaryRunner: blockingSummaryRunner{},
		ActionRunner: &recordingTerminalActionRunner{input: "printf 'option-executed\\n'\r"},
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
		TerminalID: terminal.ID, Provider: "codex", Status: "waiting",
		Summary: "Waiting for access.", Action: "Allow the request.", Priority: "high",
		Options: []session.AgentSummaryOption{{ID: "option-1", Label: "Allow", Input: "printf 'option-executed\\n'\r"}},
	}); err != nil {
		t.Fatalf("SaveAgentSummary() error = %v", err)
	}

	before, err := srv.control.ReadTerminal(terminal.ID, 4096)
	if err != nil {
		t.Fatalf("ReadTerminal(before) error = %v", err)
	}
	invalid := performRequest(t, srv, http.MethodPost,
		"/api/agent-summaries/"+terminal.ID+"/options/option-99/execute", "")
	if invalid.Code != http.StatusNotFound {
		t.Fatalf("invalid option status = %d, body = %s", invalid.Code, invalid.Body.String())
	}
	var invalidError errorResponse
	decodeResponse(t, invalid, &invalidError)
	if invalidError.Code != "agent_summary_option_not_found" {
		t.Fatalf("invalid option error = %#v", invalidError)
	}
	afterInvalid, err := srv.control.ReadTerminal(terminal.ID, 4096)
	if err != nil {
		t.Fatalf("ReadTerminal(after invalid) error = %v", err)
	}
	if afterInvalid.Text != before.Text {
		t.Fatalf("invalid option changed terminal output from %q to %q", before.Text, afterInvalid.Text)
	}

	events, unsubscribe := srv.control.SubscribeEvents([]string{"agent.summary.updated"})
	defer unsubscribe()
	response := performRequest(t, srv, http.MethodPost,
		"/api/agent-summaries/"+terminal.ID+"/options/option-1/execute",
		`{"screenText":"rendered-screen"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("execute option status = %d, body = %s", response.Code, response.Body.String())
	}
	var got session.AgentSummary
	decodeResponse(t, response, &got)
	if got.TerminalID != terminal.ID || !got.Done || got.Unread || len(got.Options) != 1 || got.Options[0].ID != "option-1" {
		t.Fatalf("execute response = %#v, want done/read normalized summary", got)
	}
	repeat := performRequest(t, srv, http.MethodPost,
		"/api/agent-summaries/"+terminal.ID+"/options/option-1/execute", "")
	if repeat.Code != http.StatusConflict {
		t.Fatalf("repeat execute status = %d, body = %s", repeat.Code, repeat.Body.String())
	}
	var repeatError errorResponse
	decodeResponse(t, repeat, &repeatError)
	if repeatError.Code != "agent_summary_not_actionable" {
		t.Fatalf("repeat execute error = %#v", repeatError)
	}
	select {
	case event := <-events:
		published, ok := event.Data.(session.AgentSummary)
		if !ok || published.TerminalID != terminal.ID || !published.Done || published.Unread {
			t.Fatalf("execute event = %#v, want done/read summary", event)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for option execution summary event")
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		read, readErr := srv.control.ReadTerminal(terminal.ID, 4096)
		if readErr == nil && bytes.Contains([]byte(read.Text), []byte("option-executed")) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("option input was not written to terminal")
}

func TestExecuteAgentSummaryOptionUsesAIWithTheCurrentTerminalScreen(t *testing.T) {
	actionRunner := &recordingTerminalActionRunner{
		prompts: make(chan string, 1),
		input:   "printf 'ai-action\\n'\r",
	}
	srv, err := New(Config{
		Token: "token", Shell: "/bin/sh", SummaryRunner: blockingSummaryRunner{}, ActionRunner: actionRunner,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	terminal, err := srv.sessions.Create(context.Background(), "Agent", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := srv.sessions.UpdateAgent(terminal.ID, session.AgentUpdate{Agent: "codex", Status: "waiting"}); err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
	if err := srv.control.RunTerminal(terminal.ID, "printf 'approval-screen\\n'"); err != nil {
		t.Fatalf("RunTerminal() error = %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := srv.control.WaitOutput(ctx, terminal.ID, control.OutputMatch{Literal: "approval-screen"}); err != nil {
		t.Fatalf("WaitOutput() error = %v", err)
	}
	if err := srv.sessions.SaveAgentSummary(context.Background(), session.AgentSummary{
		TerminalID: terminal.ID, Provider: "codex", Status: "waiting", Summary: "Waiting for approval.",
		Action: "Approve the request.", Priority: "high",
		Options: []session.AgentSummaryOption{{ID: "option-1", Label: "Allow access", Input: "printf 'direct-input\\n'\r"}},
	}); err != nil {
		t.Fatalf("SaveAgentSummary() error = %v", err)
	}

	response := performRequest(t, srv, http.MethodPost,
		"/api/agent-summaries/"+terminal.ID+"/options/option-1/execute",
		`{"screenText":"rendered-screen"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("execute option status = %d, body = %s", response.Code, response.Body.String())
	}
	select {
	case prompt := <-actionRunner.prompts:
		for _, want := range []string{"rendered-screen", "Approve the request.", "Allow access", "direct-input"} {
			if !strings.Contains(prompt, want) {
				t.Fatalf("AI action prompt = %q, want %q", prompt, want)
			}
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for AI action prompt")
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		read, readErr := srv.control.ReadTerminal(terminal.ID, 4096)
		if readErr == nil && strings.Contains(read.Text, "ai-action") {
			if strings.Contains(read.Text, "direct-input") {
				t.Fatalf("terminal executed raw summary input: %q", read.Text)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("AI action input was not written to terminal")
}

func TestExecuteAgentSummaryOptionReturnsConflictWhenTerminalIsLocked(t *testing.T) {
	srv, err := New(Config{
		Token: "token", Shell: "/bin/sh", SummaryRunner: blockingSummaryRunner{},
		ActionRunner: &recordingTerminalActionRunner{input: "y\r"},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	terminal, err := srv.sessions.Create(context.Background(), "Agent", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := srv.sessions.UpdateAgent(terminal.ID, session.AgentUpdate{Agent: "codex", Status: "waiting"}); err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
	if err := srv.sessions.SaveAgentSummary(context.Background(), session.AgentSummary{
		TerminalID: terminal.ID, Provider: "codex", Status: "waiting", Summary: "Waiting.",
		Action: "Allow.", Priority: "medium", Options: []session.AgentSummaryOption{{Label: "Allow", Input: "y\r"}},
	}); err != nil {
		t.Fatalf("SaveAgentSummary() error = %v", err)
	}
	automationDone := make(chan error, 1)
	go func() {
		automationDone <- srv.control.RunTerminalAutomation(
			context.Background(), terminal.ID, []byte("sleep 0.25; printf 'busy\\n'\r"),
		)
	}()
	deadline := time.Now().Add(time.Second)
	for !srv.control.IsTerminalLocked(terminal.ID) && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !srv.control.IsTerminalLocked(terminal.ID) {
		t.Fatal("automation did not acquire terminal lock")
	}
	response := performRequest(t, srv, http.MethodPost,
		"/api/agent-summaries/"+terminal.ID+"/options/option-1/execute", "")
	if response.Code != http.StatusConflict {
		t.Fatalf("busy option status = %d, body = %s", response.Code, response.Body.String())
	}
	var failure errorResponse
	decodeResponse(t, response, &failure)
	if failure.Code != "terminal_locked" {
		t.Fatalf("busy option error = %#v", failure)
	}
	if err := <-automationDone; err != nil {
		t.Fatalf("background automation error = %v", err)
	}
	for _, summary := range srv.sessions.AgentSummaries() {
		if summary.TerminalID == terminal.ID && (summary.Done || !summary.Unread) {
			t.Fatalf("busy option changed actionable summary = %#v", summary)
		}
	}
}

func TestExecuteAgentSummaryOptionDoesNotCompleteANewerSummary(t *testing.T) {
	actionRunner := &blockingTerminalActionRunner{
		started: make(chan struct{}),
		release: make(chan struct{}),
		input:   "printf 'stale-option-executed\\n'\r",
	}
	srv, err := New(Config{
		Token: "token", Shell: "/bin/sh", SummaryRunner: blockingSummaryRunner{},
		ActionRunner: actionRunner,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	terminal, err := srv.sessions.Create(context.Background(), "Agent", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := srv.sessions.UpdateAgent(terminal.ID, session.AgentUpdate{Agent: "codex", Status: "waiting"}); err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
	firstGeneratedAt := time.Date(2026, 8, 5, 1, 0, 0, 0, time.UTC)
	if err := srv.sessions.SaveAgentSummary(context.Background(), session.AgentSummary{
		TerminalID: terminal.ID, Provider: "codex", Status: "waiting", Summary: "Waiting for access.",
		Action: "Allow the request.", Priority: "high", GeneratedAt: firstGeneratedAt,
		Options: []session.AgentSummaryOption{{ID: "option-1", Label: "Allow", Input: "sleep 0.25; printf 'option-executed\\n'\r"}},
	}); err != nil {
		t.Fatalf("SaveAgentSummary(first) error = %v", err)
	}

	responseCh := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		responseCh <- performRequest(t, srv, http.MethodPost,
			"/api/agent-summaries/"+terminal.ID+"/options/option-1/execute", "")
	}()
	deadline := time.Now().Add(time.Second)
	for !srv.control.IsTerminalLocked(terminal.ID) && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !srv.control.IsTerminalLocked(terminal.ID) {
		t.Fatal("option execution did not acquire terminal lock")
	}
	select {
	case <-actionRunner.started:
	case <-time.After(time.Second):
		t.Fatal("AI action runner did not start")
	}
	if err := srv.sessions.SaveAgentSummary(context.Background(), session.AgentSummary{
		TerminalID: terminal.ID, Provider: "codex", Status: "waiting", Summary: "The agent asked again.",
		Action: "Allow the request.", Priority: "high", GeneratedAt: firstGeneratedAt.Add(time.Minute),
		Options: []session.AgentSummaryOption{{ID: "option-1", Label: "Deny", Input: "n\r"}},
	}); err != nil {
		t.Fatalf("SaveAgentSummary(newer) error = %v", err)
	}
	close(actionRunner.release)

	response := <-responseCh
	if response.Code != http.StatusConflict {
		t.Fatalf("stale option status = %d, body = %s", response.Code, response.Body.String())
	}
	var failure errorResponse
	decodeResponse(t, response, &failure)
	if failure.Code != "agent_summary_changed" {
		t.Fatalf("stale option error = %#v, want agent_summary_changed", failure)
	}
	got := srv.sessions.AgentSummaries()[0]
	if got.Done || got.Options[0].Label != "Deny" {
		t.Fatalf("stale option changed newer summary = %#v, want actionable newer summary", got)
	}
	read, readErr := srv.control.ReadTerminal(terminal.ID, 4096)
	if readErr != nil {
		t.Fatalf("ReadTerminal() error = %v", readErr)
	}
	if strings.Contains(read.Text, "stale-option-executed") {
		t.Fatalf("stale action reached terminal: %q", read.Text)
	}
}

type blockingSummaryRunner struct{}

type recordingTerminalActionRunner struct {
	prompts chan string
	input   string
}

type blockingTerminalActionRunner struct {
	started chan struct{}
	release chan struct{}
	input   string
}

func (r *blockingTerminalActionRunner) GenerateTerminalAction(ctx context.Context, _ string, _ string, _ string) (agentsummary.TerminalActionGeneration, error) {
	close(r.started)
	select {
	case <-r.release:
		return agentsummary.TerminalActionGeneration{Input: r.input}, nil
	case <-ctx.Done():
		return agentsummary.TerminalActionGeneration{}, ctx.Err()
	}
}

func (r *recordingTerminalActionRunner) GenerateTerminalAction(_ context.Context, _ string, prompt string, _ string) (agentsummary.TerminalActionGeneration, error) {
	if r.prompts != nil {
		r.prompts <- prompt
	}
	return agentsummary.TerminalActionGeneration{Input: r.input}, nil
}

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
		if !ok || !reflect.DeepEqual(got, want) {
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
