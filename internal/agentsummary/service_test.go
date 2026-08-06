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
	prompt := BuildPrompt(metadata, entries, []byte("\x1b[31mterminal output\x1b[0m\n"))
	if !strings.Contains(prompt, "I am updating the request handler.") ||
		!strings.Contains(prompt, "terminal output") ||
		!strings.Contains(prompt, "Agent status: running") {
		t.Fatalf("prompt = %q", prompt)
	}
	if strings.Contains(prompt, "\x1b[") {
		t.Fatalf("prompt contains ANSI escape sequence: %q", prompt)
	}

	largeTerminal := []byte(strings.Repeat("x", maxTerminalContextBytes+100))
	bounded := BuildPrompt(metadata, nil, largeTerminal)
	if len(bounded) > maxPromptBytes {
		t.Fatalf("prompt length = %d, want <= %d", len(bounded), maxPromptBytes)
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
	got, err = ParseGeneration("```json\n{\"summary\":\"Waiting for input.\",\"action\":\"Answer the question.\"}\n```", "waiting")
	if err != nil || got.Summary != "Waiting for input." || got.Action != "Answer the question." {
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

func (e *testEvents) Publish(_ string, _ any) control.Event {
	return control.Event{}
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
