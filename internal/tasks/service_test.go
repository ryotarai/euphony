package tasks

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/ryotarai/euphony/internal/agentsummary"
	"github.com/ryotarai/euphony/internal/control"
	"github.com/ryotarai/euphony/internal/selection"
	"github.com/ryotarai/euphony/internal/session"
)

func TestServiceCreateAppliesTodoDefaultsAndValidatesFields(t *testing.T) {
	service, _ := newTestService(t)
	created, err := service.Create(context.Background(), CreateInput{Title: "Implement task API"})
	if err != nil {
		t.Fatal(err)
	}
	if created.Status != StatusTodo || created.Priority != PriorityMedium {
		t.Fatalf("Create() = %#v, want todo/medium", created)
	}
	for _, input := range []CreateInput{
		{Title: "", Priority: PriorityMedium, Status: StatusTodo},
		{Title: "Bad priority", Priority: "urgent", Status: StatusTodo},
		{Title: "Bad status", Priority: PriorityLow, Status: "finished"},
	} {
		if _, err := service.Create(context.Background(), input); err == nil {
			t.Errorf("Create(%#v) error = nil", input)
		}
	}
}

func TestServiceStartAgentLinksTerminalAndMarksTaskInProgress(t *testing.T) {
	service, agents := newTestService(t)
	task, err := service.Create(context.Background(), CreateInput{
		Title: "Build task dashboard", Priority: PriorityHigh,
	})
	if err != nil {
		t.Fatal(err)
	}
	started, err := service.StartAgent(context.Background(), task.ID, StartInput{
		Agent: "claude",
		CWD:   "/repo",
	})
	if err != nil {
		t.Fatal(err)
	}
	if started.Status != StatusInProgress || started.TerminalID != "terminal-new" || started.Agent != "claude" {
		t.Fatalf("StartAgent() = %#v", started)
	}
	if agents.createdName != task.Title || agents.createdCWD != "/repo" || agents.createdMode != control.SelectionAdd {
		t.Fatalf("CreateTerminal() = %q %q %q", agents.createdName, agents.createdCWD, agents.createdMode)
	}
	if agents.startedID != "terminal-new" || agents.startedKind != "claude" {
		t.Fatalf("StartAgent control call = %q %q", agents.startedID, agents.startedKind)
	}
	updates, err := service.Get(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(updates.Updates) != 1 || updates.Updates[0].Kind != UpdateSystem {
		t.Fatalf("start updates = %#v", updates.Updates)
	}
}

func TestServicePromptRecordsInstructionAfterAgentAcceptsIt(t *testing.T) {
	service, agents := newTestService(t)
	task, err := service.Create(context.Background(), CreateInput{Title: "Communicate with agent"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.StartAgent(context.Background(), task.ID, StartInput{Agent: "codex"}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Prompt(context.Background(), task.ID, "Please run the focused tests."); err != nil {
		t.Fatal(err)
	}
	if agents.prompt != "Please run the focused tests." {
		t.Fatalf("PromptAgent() = %q", agents.prompt)
	}
	got, err := service.Get(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Updates) != 2 || got.Updates[1].Kind != UpdateUserInstruction {
		t.Fatalf("prompt updates = %#v", got.Updates)
	}

	agents.promptErr = errors.New("agent unavailable")
	if _, err := service.Prompt(context.Background(), task.ID, "This must not be recorded."); err == nil {
		t.Fatal("Prompt() error = nil")
	}
	got, err = service.Get(context.Background(), task.ID)
	if err != nil || len(got.Updates) != 2 {
		t.Fatalf("failed prompt updates = %#v, %v", got.Updates, err)
	}
}

func TestServiceRefineReturnsProposalWithoutMutatingTask(t *testing.T) {
	service, _ := newTestService(t)
	refiner := &testRefiner{result: agentsummary.TaskRefinement{
		Title: "Refined title", Description: "More precise", Priority: PriorityHigh, Status: StatusTodo,
		Rationale: "The work can be split.",
	}}
	service.refiner = refiner
	task, err := service.Create(context.Background(), CreateInput{Title: "Original title", Description: "Original description"})
	if err != nil {
		t.Fatal(err)
	}
	proposal, err := service.Refine(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if proposal.Title != "Refined title" || refiner.provider != "claude" {
		t.Fatalf("Refine() = %#v, provider %q", proposal, refiner.provider)
	}
	unchanged, err := service.Get(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if unchanged.Title != task.Title || len(unchanged.Updates) != 0 {
		t.Fatalf("task after Refine() = %#v", unchanged)
	}
}

func TestServiceRefineDefaultsToCodexProvider(t *testing.T) {
	refiner := &testRefiner{result: agentsummary.TaskRefinement{
		Title: "Refined title", Priority: PriorityMedium, Status: StatusTodo,
	}}
	service, err := New(Config{
		Store: NewMemoryStore(), Refiner: refiner,
		Now:   func() time.Time { return time.Date(2026, 8, 5, 0, 0, 0, 0, time.UTC) },
		NewID: func() string { return "task-codex-default" },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = service.Close(context.Background()) })

	task, err := service.Create(context.Background(), CreateInput{Title: "Use the default provider"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Refine(context.Background(), task.ID); err != nil {
		t.Fatal(err)
	}
	if refiner.provider != session.DefaultAgentSummaryProvider {
		t.Fatalf("Refine() provider = %q, want %q", refiner.provider, session.DefaultAgentSummaryProvider)
	}
}

func TestServicePersistsAgentEventsAndUnlinksDeletedTerminal(t *testing.T) {
	service, events := newEventTestService(t)
	task, err := service.Create(context.Background(), CreateInput{Title: "Follow agent"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.StartAgent(context.Background(), task.ID, StartInput{Agent: "claude"}); err != nil {
		t.Fatal(err)
	}
	metadata := session.Metadata{
		ID: "terminal-new", Agent: "claude", AgentStatus: "waiting", AgentTitle: "Needs approval",
	}
	events.emit("agent.updated", metadata)
	events.emit("agent.summary.updated", session.AgentSummary{
		TerminalID: metadata.ID, Provider: "claude", Status: "waiting",
		Summary: "The agent needs approval.", Action: "Approve the change.",
		GeneratedAt: time.Now().UTC(),
	})
	waitForTask(t, service, task.ID, func(got Task) bool { return len(got.Updates) >= 3 })
	got, err := service.Get(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Updates[1].Kind != UpdateAgentStatus || got.Updates[2].Kind != UpdateAgentSummary {
		t.Fatalf("agent updates = %#v", got.Updates)
	}
	events.emit("terminal.deleted", map[string]string{"id": metadata.ID})
	waitForTask(t, service, task.ID, func(got Task) bool { return got.TerminalID == "" })
	got, err = service.Get(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Updates) != 4 || got.Updates[3].Kind != UpdateSystem {
		t.Fatalf("deletion updates = %#v", got.Updates)
	}
}

type testAgents struct {
	metadata    session.Metadata
	createdName string
	createdCWD  string
	createdMode control.SelectionMode
	startedID   string
	startedKind string
	prompt      string
	promptErr   error
}

func (a *testAgents) CreateTerminal(_ context.Context, name, cwd string, mode control.SelectionMode) (session.Metadata, selection.Snapshot, error) {
	a.createdName, a.createdCWD, a.createdMode = name, cwd, mode
	a.metadata = session.Metadata{ID: "terminal-new", Name: name, CWD: cwd, State: session.StateRunning}
	return a.metadata, selection.Snapshot{}, nil
}

func (a *testAgents) StartAgent(_ context.Context, id, kind string, _ []string) (session.Metadata, error) {
	a.startedID, a.startedKind = id, kind
	a.metadata.Agent, a.metadata.AgentStatus = kind, "waiting"
	return a.metadata, nil
}

func (a *testAgents) GetAgent(_ string) (session.Metadata, error) {
	if a.metadata.Agent == "" {
		return session.Metadata{}, control.ErrAgentNotRunning
	}
	return a.metadata, nil
}

func (a *testAgents) GetTerminal(id string) (session.Metadata, error) {
	if a.metadata.ID != id {
		return session.Metadata{}, control.ErrTerminalNotFound
	}
	return a.metadata, nil
}

func (a *testAgents) PromptAgent(_ context.Context, _ string, prompt string, _ bool, _ []string) (session.Metadata, error) {
	if a.promptErr != nil {
		return session.Metadata{}, a.promptErr
	}
	a.prompt = prompt
	return a.metadata, nil
}

type testRefiner struct {
	result   agentsummary.TaskRefinement
	provider string
}

func (r *testRefiner) Refine(_ context.Context, provider, _ string) (agentsummary.TaskRefinement, error) {
	r.provider = provider
	return r.result, nil
}

type testEventSource struct {
	mu   sync.Mutex
	subs []chan control.Event
}

func (e *testEventSource) SubscribeEvents(_ []string) (<-chan control.Event, func()) {
	e.mu.Lock()
	channel := make(chan control.Event, 32)
	e.subs = append(e.subs, channel)
	e.mu.Unlock()
	return channel, func() {
		e.mu.Lock()
		for index, candidate := range e.subs {
			if candidate == channel {
				e.subs = append(e.subs[:index], e.subs[index+1:]...)
				close(channel)
				break
			}
		}
		e.mu.Unlock()
	}
}

func (e *testEventSource) Publish(_ string, _ any) control.Event { return control.Event{} }

func (e *testEventSource) emit(eventType string, data any) {
	e.mu.Lock()
	subs := append([]chan control.Event(nil), e.subs...)
	e.mu.Unlock()
	for _, subscriber := range subs {
		subscriber <- control.Event{Type: eventType, Data: data, OccurredAt: time.Now().UTC()}
	}
}

func newTestService(t *testing.T) (*Service, *testAgents) {
	t.Helper()
	agents := &testAgents{}
	service, err := New(Config{
		Store: NewMemoryStore(), Agents: agents, Provider: func() string { return "claude" },
		Refiner: &testRefiner{result: agentsummary.TaskRefinement{Title: "refined", Description: "", Priority: PriorityMedium, Status: StatusTodo}},
		Now:     func() time.Time { return time.Date(2026, 8, 5, 0, 0, 0, 0, time.UTC) },
		NewID:   func() string { return "task-test" },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = service.Close(context.Background()) })
	return service, agents
}

func newEventTestService(t *testing.T) (*Service, *testEventSource) {
	t.Helper()
	agents := &testAgents{}
	events := &testEventSource{}
	service, err := New(Config{
		Store: NewMemoryStore(), Agents: agents, Events: events,
		Provider: func() string { return "claude" },
		Refiner:  &testRefiner{}, Now: time.Now,
		NewID: func() string { return "task-events" },
	})
	if err != nil {
		t.Fatal(err)
	}
	service.Start()
	t.Cleanup(func() { _ = service.Close(context.Background()) })
	return service, events
}

func waitForTask(t *testing.T, service *Service, id string, predicate func(Task) bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		got, err := service.Get(context.Background(), id)
		if err == nil && predicate(got) {
			return
		}
		time.Sleep(time.Millisecond)
	}
	got, _ := service.Get(context.Background(), id)
	t.Fatalf("task did not reach expected state: %#v", got)
}
