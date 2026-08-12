package tasks

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/ryotarai/euphony/internal/agentsummary"
	"github.com/ryotarai/euphony/internal/control"
	"github.com/ryotarai/euphony/internal/selection"
	"github.com/ryotarai/euphony/internal/session"
)

type StartInput struct {
	Agent string
	CWD   string
}

type AgentController interface {
	CreateTerminal(context.Context, string, string, control.SelectionMode) (session.Metadata, selection.Snapshot, error)
	CreateTerminalWithCommand(context.Context, string, string, control.SelectionMode, string) (session.Metadata, selection.Snapshot, error)
	StartAgent(context.Context, string, string, []string) (session.Metadata, error)
	GetAgent(string) (session.Metadata, error)
	GetTerminal(string) (session.Metadata, error)
	PromptAgent(context.Context, string, string, bool, []string) (session.Metadata, error)
}

type EventSource interface {
	SubscribeEvents([]string) (<-chan control.Event, func())
	Publish(string, any) control.Event
}

type SelectionSource interface {
	Selection() selection.Snapshot
}

type Config struct {
	Store     Repository
	Agents    AgentController
	Events    EventSource
	Selection SelectionSource
	Provider  func() string
	Refiner   agentsummary.Refiner
	Now       func() time.Time
	NewID     func() string
}

type Service struct {
	store     Repository
	agents    AgentController
	events    EventSource
	selection SelectionSource
	provider  func() string
	refiner   agentsummary.Refiner
	now       func() time.Time
	newID     func() string

	mu     sync.Mutex
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func New(config Config) (*Service, error) {
	store := config.Store
	if store == nil {
		store = NewMemoryStore()
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	newID := config.NewID
	if newID == nil {
		newID = uuid.NewString
	}
	provider := config.Provider
	if provider == nil {
		provider = func() string { return session.DefaultAgentSummaryProvider }
	}
	refiner := config.Refiner
	if refiner == nil {
		refiner = agentsummary.NewCommandRunner()
	}
	return &Service{
		store: store, agents: config.Agents, events: config.Events,
		selection: config.Selection, provider: provider, refiner: refiner,
		now: now, newID: newID,
	}, nil
}

func (s *Service) Start() {
	if s.events == nil {
		return
	}
	s.mu.Lock()
	if s.cancel != nil {
		s.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	events, unsubscribe := s.events.SubscribeEvents([]string{
		"agent.updated", "agent.summary.updated", "terminal.deleted",
	})
	s.wg.Add(1)
	s.mu.Unlock()
	go func() {
		defer s.wg.Done()
		defer unsubscribe()
		for {
			select {
			case <-ctx.Done():
				return
			case event, open := <-events:
				if !open {
					return
				}
				s.handleEvent(event)
			}
		}
	}()
}

func (s *Service) Close(ctx context.Context) error {
	s.mu.Lock()
	cancel := s.cancel
	s.cancel = nil
	s.mu.Unlock()
	if cancel == nil {
		return s.store.Close()
	}
	cancel()
	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return s.store.Close()
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Service) List(ctx context.Context) ([]Task, error) {
	tasks, err := s.store.List(ctx)
	if err != nil {
		return nil, err
	}
	for index := range tasks {
		if err := s.loadUpdates(ctx, &tasks[index]); err != nil {
			return nil, err
		}
	}
	return tasks, nil
}

func (s *Service) Get(ctx context.Context, id string) (Task, error) {
	task, err := s.store.Get(ctx, id)
	if err != nil {
		return Task{}, err
	}
	if err := s.loadUpdates(ctx, &task); err != nil {
		return Task{}, err
	}
	return task, nil
}

func (s *Service) Create(ctx context.Context, input CreateInput) (Task, error) {
	title := strings.TrimSpace(input.Title)
	description := strings.TrimSpace(input.Description)
	priority := input.Priority
	if priority == "" {
		priority = PriorityMedium
	}
	status := input.Status
	if status == "" {
		status = StatusTodo
	}
	if err := ValidateTaskFields(title, description, priority, status); err != nil {
		return Task{}, err
	}
	now := s.currentTime()
	task := Task{
		ID: s.newID(), Title: title, Description: description,
		Priority: priority, Status: status, CreatedAt: now, UpdatedAt: now,
	}
	if err := s.store.Create(ctx, task); err != nil {
		return Task{}, err
	}
	s.publish("task.created", task)
	return task, nil
}

func (s *Service) Update(ctx context.Context, id string, input UpdateInput) (Task, error) {
	task, err := s.store.Get(ctx, id)
	if err != nil {
		return Task{}, err
	}
	if input.Title != nil {
		task.Title = strings.TrimSpace(*input.Title)
	}
	if input.Description != nil {
		task.Description = strings.TrimSpace(*input.Description)
	}
	if input.Priority != nil {
		task.Priority = strings.TrimSpace(*input.Priority)
	}
	if input.Status != nil {
		task.Status = strings.TrimSpace(*input.Status)
	}
	if err := ValidateTaskFields(task.Title, task.Description, task.Priority, task.Status); err != nil {
		return Task{}, err
	}
	task.UpdatedAt = s.currentTime()
	if err := s.store.Update(ctx, task); err != nil {
		return Task{}, err
	}
	s.publish("task.updated", task)
	return s.Get(ctx, id)
}

func (s *Service) Delete(ctx context.Context, id string) error {
	if err := s.store.Delete(ctx, id); err != nil {
		return err
	}
	s.publish("task.deleted", map[string]string{"id": id})
	return nil
}

func (s *Service) StartAgent(ctx context.Context, id string, input StartInput) (Task, error) {
	if input.Agent != "claude" && input.Agent != "codex" {
		return Task{}, fmt.Errorf("unsupported agent %q", input.Agent)
	}
	if s.agents == nil {
		return Task{}, errors.New("agent control is unavailable")
	}
	task, err := s.store.Get(ctx, id)
	if err != nil {
		return Task{}, err
	}
	if task.Status == StatusDone {
		return Task{}, errors.New("done tasks cannot start an agent")
	}
	terminalID := task.TerminalID
	createdTerminal := false
	if terminalID != "" {
		metadata, terminalErr := s.agents.GetTerminal(terminalID)
		if terminalErr != nil {
			terminalID = ""
		} else if metadata.Agent != "" {
			return Task{}, control.ErrAgentAlreadyRunning
		}
	}
	if terminalID == "" {
		cwd := strings.TrimSpace(input.CWD)
		if cwd == "" && s.selection != nil {
			focused := s.selection.Selection().FocusedTerminalID
			if focused != "" {
				if metadata, getErr := s.agents.GetTerminal(focused); getErr == nil {
					cwd = metadata.CWD
				}
			}
		}
		metadata, _, createErr := s.agents.CreateTerminalWithCommand(
			ctx, task.Title, cwd, control.SelectionAdd, input.Agent,
		)
		if createErr != nil {
			return Task{}, createErr
		}
		terminalID = metadata.ID
		createdTerminal = true
	}
	task.TerminalID = terminalID
	task.Agent = input.Agent
	task.Status = StatusInProgress
	task.UpdatedAt = s.currentTime()
	if err := s.store.Update(ctx, task); err != nil {
		return Task{}, err
	}
	s.publish("task.updated", task)
	if !createdTerminal {
		if _, err := s.agents.StartAgent(ctx, terminalID, input.Agent, nil); err != nil {
			_, _ = s.appendUpdate(ctx, task, UpdateError,
				fmt.Sprintf("Could not start %s: %s", input.Agent, err))
			return task, err
		}
	}
	updated, err := s.appendUpdate(ctx, task, UpdateSystem,
		fmt.Sprintf("Started %s agent.", input.Agent))
	if err != nil {
		return Task{}, err
	}
	return updated, nil
}

func (s *Service) Prompt(ctx context.Context, id, prompt string) (Task, error) {
	if strings.TrimSpace(prompt) == "" {
		return Task{}, errors.New("instruction is required")
	}
	if len(prompt) > control.MaxAgentInputBytes {
		return Task{}, errors.New("instruction is too large")
	}
	if s.agents == nil {
		return Task{}, errors.New("agent control is unavailable")
	}
	task, err := s.store.Get(ctx, id)
	if err != nil {
		return Task{}, err
	}
	if task.TerminalID == "" {
		return Task{}, control.ErrAgentNotRunning
	}
	if _, err := s.agents.GetAgent(task.TerminalID); err != nil {
		return Task{}, err
	}
	if _, err := s.agents.PromptAgent(ctx, task.TerminalID, prompt, false, nil); err != nil {
		return Task{}, err
	}
	updated, err := s.appendUpdate(ctx, task, UpdateUserInstruction, prompt)
	if err != nil {
		return Task{}, err
	}
	return updated, nil
}

func (s *Service) Refine(ctx context.Context, id string) (agentsummary.TaskRefinement, error) {
	task, err := s.Get(ctx, id)
	if err != nil {
		return agentsummary.TaskRefinement{}, err
	}
	provider := s.provider()
	if provider != "claude" && provider != "codex" {
		provider = session.DefaultAgentSummaryProvider
	}
	prompt := buildRefinementPrompt(task)
	proposal, err := s.refiner.Refine(ctx, provider, prompt)
	if err != nil {
		return agentsummary.TaskRefinement{}, err
	}
	if err := ValidateTaskFields(proposal.Title, proposal.Description, proposal.Priority, proposal.Status); err != nil {
		return agentsummary.TaskRefinement{}, err
	}
	return proposal, nil
}

func (s *Service) handleEvent(event control.Event) {
	ctx := context.Background()
	switch event.Type {
	case "agent.updated":
		metadata, ok := event.Data.(session.Metadata)
		if ok {
			s.handleAgentStatus(ctx, metadata)
		}
	case "agent.summary.updated":
		summary, ok := event.Data.(session.AgentSummary)
		if ok {
			s.handleAgentSummary(ctx, summary)
		}
	case "terminal.deleted":
		data, ok := event.Data.(map[string]string)
		if ok {
			s.handleTerminalDeleted(ctx, data["id"])
		}
	}
}

func (s *Service) handleAgentStatus(ctx context.Context, metadata session.Metadata) {
	tasks, err := s.store.List(ctx)
	if err != nil {
		return
	}
	for _, task := range tasks {
		if task.TerminalID != metadata.ID {
			continue
		}
		if task.Status != StatusDone {
			nextStatus := StatusInProgress
			if metadata.AgentStatus == "blocked" {
				nextStatus = StatusBlocked
			}
			if task.Status != nextStatus {
				task.Status = nextStatus
				task.UpdatedAt = s.currentTime()
				if err := s.store.Update(ctx, task); err == nil {
					s.publish("task.updated", task)
				}
			}
		}
		_, _ = s.appendUpdate(ctx, task, UpdateAgentStatus,
			fmt.Sprintf("Agent status: %s.", metadata.AgentStatus))
	}
}

func (s *Service) handleAgentSummary(ctx context.Context, summary session.AgentSummary) {
	tasks, err := s.store.List(ctx)
	if err != nil {
		return
	}
	body := "Agent summary: " + summary.Summary
	if summary.Action != "" {
		body += " Next action: " + summary.Action
	}
	for _, task := range tasks {
		if task.TerminalID == summary.TerminalID {
			_, _ = s.appendUpdate(ctx, task, UpdateAgentSummary, body)
		}
	}
}

func (s *Service) handleTerminalDeleted(ctx context.Context, terminalID string) {
	if terminalID == "" {
		return
	}
	tasks, err := s.store.List(ctx)
	if err != nil {
		return
	}
	for _, task := range tasks {
		if task.TerminalID != terminalID {
			continue
		}
		task.TerminalID = ""
		task.Agent = ""
		task.UpdatedAt = s.currentTime()
		if err := s.store.Update(ctx, task); err == nil {
			s.publish("task.updated", task)
			_, _ = s.appendUpdate(ctx, task, UpdateSystem, "The linked agent terminal was closed.")
		}
	}
}

func (s *Service) appendUpdate(ctx context.Context, task Task, kind, body string) (Task, error) {
	if err := ValidateUpdateBody(body); err != nil {
		return Task{}, err
	}
	update := TaskUpdate{
		ID: s.newID(), TaskID: task.ID, TerminalID: task.TerminalID,
		Kind: kind, Body: body, CreatedAt: s.currentTime(),
	}
	added, err := s.store.AppendUpdate(ctx, update)
	if err != nil {
		return Task{}, err
	}
	if added {
		task.UpdatedAt = update.CreatedAt
		if err := s.store.Update(ctx, task); err != nil {
			return Task{}, err
		}
		s.publish("task.update.created", update)
		s.publish("task.updated", task)
	}
	return s.Get(ctx, task.ID)
}

func (s *Service) loadUpdates(ctx context.Context, task *Task) error {
	updates, err := s.store.ListUpdates(ctx, task.ID)
	if err != nil {
		return err
	}
	task.Updates = updates
	return nil
}

func (s *Service) publish(eventType string, data any) {
	if s.events != nil {
		s.events.Publish(eventType, data)
	}
}

func (s *Service) currentTime() time.Time { return s.now().UTC() }

func buildRefinementPrompt(task Task) string {
	var builder strings.Builder
	builder.WriteString(`You refine a task for a terminal-first coding workspace.
Return exactly one JSON object and no markdown:
{"title":"...","description":"...","priority":"low|medium|high","status":"todo|in_progress|blocked|done","rationale":"..."}
Keep the user's intent. Make the title specific, the description actionable, and preserve the current status unless the context clearly requires a change.

Current task:
`)
	fmt.Fprintf(&builder, "Title: %s\nDescription: %s\nPriority: %s\nStatus: %s\n", task.Title, task.Description, task.Priority, task.Status)
	if len(task.Updates) > 0 {
		builder.WriteString("Recent activity:\n")
		start := len(task.Updates) - 8
		if start < 0 {
			start = 0
		}
		for _, update := range task.Updates[start:] {
			fmt.Fprintf(&builder, "- %s: %s\n", update.Kind, update.Body)
		}
	}
	return builder.String()
}
