package agentsummary

import (
	"context"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ryotarai/euphony/internal/agentlog"
	"github.com/ryotarai/euphony/internal/control"
	"github.com/ryotarai/euphony/internal/session"
)

func TestBuildPromptIncludesBoundedContextWithoutANSI(t *testing.T) {
	metadata := session.Metadata{
		ID: "terminal-1", Name: "Codex", Agent: "codex", AgentStatus: "running",
		AgentSessionID: "thread-1", CWD: "/repo", AgentTitle: "Implement API",
	}
	entries := []agentlog.Entry{{
		ID: "entry-1", Kind: "message", Role: "assistant",
		Content: "I am updating the request handler.",
	}}
	prompt := BuildPrompt(metadata, entries, []byte("\x1b[31mterminal output\x1b[0m\n"), "Prioritize user-visible blockers.\nKeep the wording concise.")
	if !strings.Contains(prompt, "I am updating the request handler.") ||
		!strings.Contains(prompt, "terminal output") ||
		!strings.Contains(prompt, "Agent status: running") ||
		!strings.Contains(prompt, "Prioritize user-visible blockers.") ||
		!strings.Contains(prompt, "Keep the wording concise.") {
		t.Fatalf("prompt = %q", prompt)
	}
	if strings.Contains(prompt, "\x1b[") {
		t.Fatalf("prompt contains ANSI escape sequence: %q", prompt)
	}
	if !strings.Contains(prompt, `"priority"`) ||
		!strings.Contains(prompt, "high") ||
		!strings.Contains(prompt, "medium") ||
		!strings.Contains(prompt, "low") {
		t.Fatalf("prompt does not describe action priority: %q", prompt)
	}

	largeTerminal := []byte(strings.Repeat("x", maxTerminalContextBytes+100))
	bounded := BuildPrompt(metadata, nil, largeTerminal, strings.Repeat("追加指示", maxAdditionalPromptRunes+100))
	if len(bounded) > maxPromptBytes {
		t.Fatalf("prompt length = %d, want <= %d", len(bounded), maxPromptBytes)
	}
}

func TestBuildPromptOmitsEmptyAdditionalInstructions(t *testing.T) {
	metadata := session.Metadata{ID: "terminal-1", Name: "Codex", Agent: "codex", AgentStatus: "running"}
	prompt := BuildPrompt(metadata, nil, nil, "   \n\t")
	if strings.Contains(prompt, "Additional instructions from the workspace owner:") {
		t.Fatalf("prompt includes an empty additional instruction section: %q", prompt)
	}
}

func TestServicePassesConfiguredAdditionalPromptToRunner(t *testing.T) {
	manager := session.NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	settings := manager.Settings()
	settings.AgentSummaryPrompt = "Focus on the user's immediate next action."
	if err := manager.UpdateSettings(context.Background(), settings); err != nil {
		t.Fatalf("UpdateSettings() error = %v", err)
	}
	metadata, err := manager.Create(context.Background(), "Agent", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	metadata, err = manager.UpdateAgent(metadata.ID, session.AgentUpdate{
		Agent: "codex", AgentSessionID: "thread-1", Status: "running",
	})
	if err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
	runner := &promptCaptureRunner{result: Generation{Summary: "Working."}}
	service := New(Config{Sessions: manager, Events: newTestEvents(), Runner: runner})

	service.generate(context.Background(), metadata)

	if !strings.Contains(runner.prompt, "Focus on the user's immediate next action.") {
		t.Fatalf("runner prompt = %q", runner.prompt)
	}
}

func TestParseGenerationValidatesActionPriority(t *testing.T) {
	got, err := ParseGeneration(
		`{"summary":"Waiting.","action":"Approve it.","priority":"high"}`,
		"waiting",
	)
	if err != nil || got.Priority != "high" {
		t.Fatalf("generation = %#v, %v", got, err)
	}
	if _, err := ParseGeneration(
		`{"summary":"Blocked.","action":"Approve it.","priority":"urgent"}`,
		"blocked",
	); err == nil {
		t.Fatal("invalid priority accepted")
	}
	got, err = ParseGeneration(
		`{"summary":"Working.","action":"Ignore me.","priority":"high"}`,
		"running",
	)
	if err != nil || got.Action != "" || got.Priority != "" {
		t.Fatalf("running generation = %#v, %v", got, err)
	}
}

func TestCommandSpecUsesCurrentProviderArguments(t *testing.T) {
	tests := []struct {
		provider string
		name     string
		args     []string
	}{
		{provider: "claude", name: "claude", args: []string{"-p", "--model", "haiku", "--effort", "low"}},
		{provider: "codex", name: "codex", args: []string{"-c", "model_reasoning_effort=low", "-c", "service_tier=standard", "exec", "--model", "gpt-5.6-luna"}},
	}
	for _, test := range tests {
		name, args, err := commandSpec(test.provider)
		if err != nil || name != test.name || !reflect.DeepEqual(args, test.args) {
			t.Fatalf("commandSpec(%q) = %q %#v, %v; want %q %#v", test.provider, name, args, err, test.name, test.args)
		}
	}
	if _, _, err := commandSpec("other"); err == nil {
		t.Fatal("commandSpec(other) error = nil")
	}
}

func TestParseGenerationAcceptsJSONAndRejectsIncompleteOutput(t *testing.T) {
	got, err := ParseGeneration(`{"summary":"Updating tests.","action":""}`, "running")
	if err != nil || got.Summary != "Updating tests." || got.Action != "" {
		t.Fatalf("ParseGeneration() = %#v, %v", got, err)
	}
	got, err = ParseGeneration("```json\n{\"summary\":\"Waiting for input.\",\"action\":\"Answer the question.\",\"priority\":\"medium\"}\n```", "waiting")
	if err != nil || got.Summary != "Waiting for input." || got.Action != "Answer the question." || got.Priority != "medium" {
		t.Fatalf("ParseGeneration(fenced) = %#v, %v", got, err)
	}
	if _, err := ParseGeneration("not JSON", "running"); err == nil {
		t.Fatal("ParseGeneration(malformed) error = nil")
	}
	if _, err := ParseGeneration(`{"summary":"Needs a response.","action":""}`, "blocked"); err == nil {
		t.Fatal("ParseGeneration(missing action) error = nil")
	}
}

func TestServiceSchedulesStatusChangesAndRunningTicks(t *testing.T) {
	manager := session.NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Agent", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	metadata, err = manager.UpdateAgent(metadata.ID, session.AgentUpdate{
		Agent: "claude", AgentSessionID: "thread-1", Status: "running",
	})
	if err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
	events := newTestEvents()
	runner := &testRunner{result: Generation{Summary: "Current work.", Action: "Respond."}}
	service := New(Config{
		Sessions: manager, Events: events, Runner: runner,
		Interval: 25 * time.Millisecond,
	})
	service.Start()
	t.Cleanup(func() { _ = service.Close(context.Background()) })
	waitForRunnerCalls(t, runner, 1)

	metadata, err = manager.UpdateAgent(metadata.ID, session.AgentUpdate{
		Agent: "claude", AgentSessionID: "thread-1", Status: "waiting",
	})
	if err != nil {
		t.Fatalf("UpdateAgent(waiting) error = %v", err)
	}
	events.emit("agent.updated", metadata)
	waitForRunnerCalls(t, runner, 2)

	metadata, err = manager.UpdateAgent(metadata.ID, session.AgentUpdate{
		Agent: "claude", AgentSessionID: "thread-1", Status: "running",
	})
	if err != nil {
		t.Fatalf("UpdateAgent(running) error = %v", err)
	}
	events.emit("agent.updated", metadata)
	waitForRunnerCalls(t, runner, 3)
	waitForRunnerCalls(t, runner, 4)

	if calls := runner.callCount(); calls != 4 {
		t.Fatalf("runner call count = %d, want 4", calls)
	}
}

func TestServiceRefreshAllQueuesEveryCurrentAgentState(t *testing.T) {
	manager := session.NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	statuses := []string{"running", "waiting", "blocked"}
	for index, status := range statuses {
		metadata, err := manager.Create(context.Background(), "Agent", t.TempDir())
		if err != nil {
			t.Fatalf("Create(%s) error = %v", status, err)
		}
		metadata, err = manager.UpdateAgent(metadata.ID, session.AgentUpdate{
			Agent: "codex", Status: status,
		})
		if err != nil {
			t.Fatalf("UpdateAgent(%s) error = %v", status, err)
		}
		if err := manager.SaveAgentSummary(context.Background(), session.AgentSummary{
			TerminalID: metadata.ID, Provider: "codex", Status: status,
			Summary: "Previous summary.", Action: "Previous action.",
			GeneratedAt: time.Date(2026, 8, 7, 1, index, 0, 0, time.UTC),
		}); err != nil {
			t.Fatalf("SaveAgentSummary(%s) error = %v", status, err)
		}
	}
	if _, err := manager.Create(context.Background(), "Shell", t.TempDir()); err != nil {
		t.Fatalf("Create(plain) error = %v", err)
	}

	runner := &testRunner{result: Generation{
		Summary: "Refreshed summary.", Action: "Refreshed action.", Priority: "medium",
	}}
	service := New(Config{
		Sessions: manager, Events: newTestEvents(), Runner: runner, Interval: time.Hour,
	})
	service.Start()
	t.Cleanup(func() { _ = service.Close(context.Background()) })

	if queued := service.RefreshAll(); queued != len(statuses) {
		t.Fatalf("RefreshAll() queued = %d, want %d", queued, len(statuses))
	}
	waitForRunnerCalls(t, runner, len(statuses))
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		summaries := manager.AgentSummaries()
		refreshed := 0
		for _, summary := range summaries {
			if summary.Summary == "Refreshed summary." {
				refreshed++
			}
		}
		if refreshed == len(statuses) {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("agent summaries were not all refreshed: %#v", manager.AgentSummaries())
}

func TestSaveResultPublishesManagerNormalizedUnreadState(t *testing.T) {
	manager := session.NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Agent", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	metadata, err = manager.UpdateAgent(metadata.ID, session.AgentUpdate{
		Agent: "codex", AgentSessionID: "thread-1", Status: "waiting",
	})
	if err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
	events := newTestEvents()
	service := New(Config{Sessions: manager, Events: events})

	service.saveResult(context.Background(), metadata, session.AgentSummary{
		TerminalID: metadata.ID,
		Provider:   "codex",
		Status:     "waiting",
		Summary:    "Waiting for input.",
		Action:     "Provide the requested input.",
		GeneratedAt: time.Date(
			2026, 8, 6, 1, 2, 3, 4, time.UTC,
		),
	})

	summaries := manager.AgentSummaries()
	if len(summaries) != 1 || !summaries[0].Unread {
		t.Fatalf("manager summaries = %#v, want one unread summary", summaries)
	}
	published := events.publishedEvents()
	if len(published) != 1 || published[0].Type != terminalSummaryUpdatedEvent {
		t.Fatalf("published events = %#v, want one %s event", published, terminalSummaryUpdatedEvent)
	}
	got, ok := published[0].Data.(session.AgentSummary)
	if !ok {
		t.Fatalf("published event data = %#v, want session.AgentSummary", published[0].Data)
	}
	if got.TerminalID != metadata.ID || !got.Unread {
		t.Fatalf("published summary = %#v, want terminal %q with unread=true", got, metadata.ID)
	}
}

func TestServicePersistsGeneratedActionPriority(t *testing.T) {
	manager := session.NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Agent", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	metadata, err = manager.UpdateAgent(metadata.ID, session.AgentUpdate{
		Agent: "codex", AgentSessionID: "thread-1", Status: "waiting",
	})
	if err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
	service := New(Config{
		Sessions: manager,
		Events:   newTestEvents(),
		Runner: &testRunner{result: Generation{
			Summary: "Waiting for input.", Action: "Approve it.", Priority: "high",
		}},
	})

	service.generate(context.Background(), metadata)

	summaries := manager.AgentSummaries()
	if len(summaries) != 1 || summaries[0].Priority != "high" {
		t.Fatalf("summaries = %#v, want one high-priority summary", summaries)
	}
}

func TestSaveResultPublishesUnreadForChangedAction(t *testing.T) {
	manager := session.NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Agent", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	metadata, err = manager.UpdateAgent(metadata.ID, session.AgentUpdate{
		Agent: "codex", AgentSessionID: "thread-1", Status: "waiting",
	})
	if err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
	if err := manager.SaveAgentSummary(context.Background(), session.AgentSummary{
		TerminalID: metadata.ID, Provider: "codex", Status: "waiting",
		Summary: "Waiting for input.", Action: "Provide the requested input.",
	}); err != nil {
		t.Fatalf("SaveAgentSummary(initial) error = %v", err)
	}
	if _, err := manager.MarkAgentSummaryRead(context.Background(), metadata.ID); err != nil {
		t.Fatalf("MarkAgentSummaryRead() error = %v", err)
	}
	events := newTestEvents()
	service := New(Config{Sessions: manager, Events: events})

	service.saveResult(context.Background(), metadata, session.AgentSummary{
		TerminalID: metadata.ID, Provider: "codex", Status: "waiting",
		Summary: "Waiting for a different input.", Action: "Approve the new file access.",
	})

	published := events.publishedEvents()
	if len(published) != 1 {
		t.Fatalf("published events = %#v, want one event", published)
	}
	got, ok := published[0].Data.(session.AgentSummary)
	if !ok || got.Action != "Approve the new file access." || !got.Unread {
		t.Fatalf("published summary = %#v, want changed action with unread=true", published[0].Data)
	}
}

func TestServiceDiscardsStaleGenerationAndSchedulesCurrentStatus(t *testing.T) {
	manager := session.NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Agent", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	metadata, err = manager.UpdateAgent(metadata.ID, session.AgentUpdate{
		Agent: "codex", AgentSessionID: "thread-1", Status: "running",
	})
	if err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
	events := newTestEvents()
	runner := &testRunner{
		result:  Generation{Summary: "Fresh status.", Action: "Respond."},
		started: make(chan struct{}), release: make(chan struct{}),
	}
	service := New(Config{Sessions: manager, Events: events, Runner: runner, Interval: time.Hour})
	service.Start()
	t.Cleanup(func() { _ = service.Close(context.Background()) })
	select {
	case <-runner.started:
	case <-time.After(time.Second):
		t.Fatal("initial summary generation did not start")
	}

	metadata, err = manager.UpdateAgent(metadata.ID, session.AgentUpdate{
		Agent: "codex", AgentSessionID: "thread-1", Status: "waiting",
	})
	if err != nil {
		t.Fatalf("UpdateAgent(waiting) error = %v", err)
	}
	events.emit("agent.updated", metadata)
	close(runner.release)
	waitForRunnerCalls(t, runner, 2)

	summaries := manager.AgentSummaries()
	if len(summaries) != 1 || summaries[0].Status != "waiting" {
		t.Fatalf("summaries = %#v, want one waiting summary", summaries)
	}
}

type testRunner struct {
	mu      sync.Mutex
	calls   []string
	result  Generation
	started chan struct{}
	release chan struct{}
}

type promptCaptureRunner struct {
	prompt string
	result Generation
}

func (r *promptCaptureRunner) Generate(_ context.Context, _, prompt string) (Generation, error) {
	r.prompt = prompt
	return r.result, nil
}

func (r *testRunner) Generate(ctx context.Context, provider, _ string) (Generation, error) {
	r.mu.Lock()
	r.calls = append(r.calls, provider)
	if r.started != nil && len(r.calls) == 1 {
		close(r.started)
	}
	r.mu.Unlock()
	if r.release != nil {
		select {
		case <-r.release:
		case <-ctx.Done():
			return Generation{}, ctx.Err()
		}
	}
	return r.result, nil
}

func (r *testRunner) callCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.calls)
}

func waitForRunnerCalls(t *testing.T, runner *testRunner, want int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if runner.callCount() >= want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("runner calls = %d, want at least %d", runner.callCount(), want)
}

type testEvents struct {
	mu          sync.Mutex
	subscribers []chan control.Event
	published   []control.Event
}

func newTestEvents() *testEvents {
	return &testEvents{}
}

func (e *testEvents) SubscribeEvents(_ []string) (<-chan control.Event, func()) {
	e.mu.Lock()
	channel := make(chan control.Event, 16)
	e.subscribers = append(e.subscribers, channel)
	e.mu.Unlock()
	var once sync.Once
	return channel, func() {
		once.Do(func() {
			e.mu.Lock()
			for index, subscriber := range e.subscribers {
				if subscriber == channel {
					e.subscribers = append(e.subscribers[:index], e.subscribers[index+1:]...)
					close(channel)
					break
				}
			}
			e.mu.Unlock()
		})
	}
}

func (e *testEvents) Publish(eventType string, data any) control.Event {
	event := control.Event{Type: eventType, Data: data, OccurredAt: time.Now()}
	e.mu.Lock()
	e.published = append(e.published, event)
	e.mu.Unlock()
	return event
}

func (e *testEvents) publishedEvents() []control.Event {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]control.Event(nil), e.published...)
}

func (e *testEvents) emit(eventType string, data any) {
	e.mu.Lock()
	subscribers := append([]chan control.Event(nil), e.subscribers...)
	e.mu.Unlock()
	event := control.Event{Type: eventType, Data: data, OccurredAt: time.Now()}
	for _, subscriber := range subscribers {
		subscriber <- event
	}
}
