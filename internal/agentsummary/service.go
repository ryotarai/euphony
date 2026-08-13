package agentsummary

import (
	"context"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/ryotarai/euphony/internal/agentlog"
	"github.com/ryotarai/euphony/internal/control"
	"github.com/ryotarai/euphony/internal/session"
)

const (
	defaultInterval             = 5 * time.Minute
	terminalSummaryUpdatedEvent = "agent.summary.updated"
	terminalSummaryDeletedEvent = "agent.summary.deleted"
)

type SessionSource interface {
	ListCurrent() []session.Metadata
	Metadata(string) (session.Metadata, bool)
	Get(string) (*session.Session, bool)
	Settings() session.Settings
	AgentSummaries() []session.AgentSummary
	AgentSummaryHistory(string) []session.AgentSummaryHistoryEntry
	SaveAgentSummary(context.Context, session.AgentSummary) error
	DeleteAgentSummary(context.Context, string) error
}

type EventSource interface {
	SubscribeEvents([]string) (<-chan control.Event, func())
	Publish(string, any) control.Event
}

type TranscriptResolver interface {
	Resolve(string, string, string) (string, error)
}

type Config struct {
	Sessions SessionSource
	Events   EventSource
	Resolver TranscriptResolver
	Runner   Runner
	Interval time.Duration
	Now      func() time.Time
}

type Service struct {
	sessions SessionSource
	events   EventSource
	resolver TranscriptResolver
	runner   Runner
	interval time.Duration
	now      func() time.Time

	mu       sync.Mutex
	started  bool
	ctx      context.Context
	cancel   context.CancelFunc
	inflight map[string]bool
	pending  map[string]session.Metadata
	latest   map[string]string
	wg       sync.WaitGroup
}

func New(config Config) *Service {
	interval := config.Interval
	if interval <= 0 {
		interval = defaultInterval
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	runner := config.Runner
	if runner == nil {
		runner = NewCommandRunner()
	}
	return &Service{
		sessions: config.Sessions,
		events:   config.Events,
		resolver: config.Resolver,
		runner:   runner,
		interval: interval,
		now:      now,
		inflight: make(map[string]bool),
		pending:  make(map[string]session.Metadata),
		latest:   make(map[string]string),
	}
}

func (s *Service) Start() {
	if s.sessions == nil || s.events == nil {
		return
	}
	s.mu.Lock()
	if s.started {
		s.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.started = true
	s.ctx = ctx
	s.cancel = cancel
	s.mu.Unlock()
	s.wg.Add(1)
	go s.run(ctx)
}

// RefreshAll queues a new summary generation for every current identified
// agent, even when a successful summary already exists for that state.
func (s *Service) RefreshAll() int {
	if s.sessions == nil {
		return 0
	}
	s.mu.Lock()
	ctx := s.ctx
	s.mu.Unlock()
	if ctx == nil || ctx.Err() != nil {
		return 0
	}

	queued := 0
	for _, metadata := range s.sessions.ListCurrent() {
		if !isAgentState(metadata) {
			continue
		}
		s.schedule(ctx, metadata)
		queued++
	}
	return queued
}

func (s *Service) Close(ctx context.Context) error {
	s.mu.Lock()
	if s.cancel != nil {
		s.cancel()
	}
	s.mu.Unlock()
	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Service) run(ctx context.Context) {
	defer s.wg.Done()
	events, unsubscribe := s.events.SubscribeEvents([]string{"agent.updated", "terminal.deleted"})
	defer unsubscribe()
	for _, metadata := range s.sessions.ListCurrent() {
		if !isAgentState(metadata) {
			continue
		}
		s.mu.Lock()
		s.latest[metadata.ID] = metadataKey(metadata)
		s.mu.Unlock()
		if !s.hasFreshSummary(metadata) {
			s.schedule(ctx, metadata)
		}
	}
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-events:
			if !ok {
				return
			}
			s.handleEvent(ctx, event)
		case <-ticker.C:
			for _, metadata := range s.sessions.ListCurrent() {
				if metadata.AgentStatus == "running" && isAgentState(metadata) {
					s.schedule(ctx, metadata)
				}
			}
		}
	}
}

func (s *Service) handleEvent(ctx context.Context, event control.Event) {
	switch event.Type {
	case "agent.updated":
		metadata, ok := eventMetadata(event.Data)
		if !ok {
			return
		}
		if !isAgentState(metadata) {
			s.mu.Lock()
			delete(s.latest, metadata.ID)
			s.mu.Unlock()
			if err := s.sessions.DeleteAgentSummary(ctx, metadata.ID); err == nil {
				s.events.Publish(terminalSummaryDeletedEvent, map[string]string{"terminalId": metadata.ID})
			}
			return
		}
		key := metadataKey(metadata)
		s.mu.Lock()
		previous, seen := s.latest[metadata.ID]
		changed := !seen || previous != key
		if changed {
			s.latest[metadata.ID] = key
		}
		s.mu.Unlock()
		if changed {
			s.schedule(ctx, metadata)
		}
	case "terminal.deleted":
		id := deletedTerminalID(event.Data)
		if id == "" {
			return
		}
		s.mu.Lock()
		delete(s.latest, id)
		s.mu.Unlock()
		if err := s.sessions.DeleteAgentSummary(ctx, id); err == nil {
			s.events.Publish(terminalSummaryDeletedEvent, map[string]string{"terminalId": id})
		}
	}
}

func (s *Service) schedule(ctx context.Context, metadata session.Metadata) {
	if !isAgentState(metadata) || ctx.Err() != nil {
		return
	}
	s.mu.Lock()
	if s.inflight[metadata.ID] {
		s.pending[metadata.ID] = metadata
		s.mu.Unlock()
		return
	}
	s.inflight[metadata.ID] = true
	s.wg.Add(1)
	s.mu.Unlock()
	go func() {
		defer s.wg.Done()
		s.generate(ctx, metadata)
	}()
}

func (s *Service) generate(ctx context.Context, metadata session.Metadata) {
	settings := s.sessions.Settings()
	provider := settings.AgentSummaryProvider
	if provider != "openai" && provider != "claude" && provider != "codex" {
		provider = session.DefaultAgentSummaryProvider
	}
	prompt := s.promptFor(metadata)
	var generation Generation
	var err error
	if effortRunner, ok := s.runner.(EffortRunner); ok {
		generation, err = effortRunner.GenerateWithEffort(
			ctx, provider, prompt, settings.AgentSummaryOpenAIEffort,
		)
	} else {
		generation, err = s.runner.Generate(ctx, provider, prompt)
	}
	if ctx.Err() != nil {
		s.finishInflight(ctx, metadata.ID)
		return
	}
	if err != nil {
		s.saveResult(ctx, metadata, session.AgentSummary{
			TerminalID: metadata.ID, Provider: provider, Status: metadata.AgentStatus,
			GeneratedAt: s.now().UTC(), Error: err.Error(),
		})
		return
	}
	generation, err = normalizeGeneration(generation, metadata.AgentStatus)
	if err != nil {
		s.saveResult(ctx, metadata, session.AgentSummary{
			TerminalID: metadata.ID, Provider: provider, Status: metadata.AgentStatus,
			GeneratedAt: s.now().UTC(), Error: err.Error(),
		})
		return
	}
	summary := session.AgentSummary{
		TerminalID: metadata.ID, Provider: provider, Status: metadata.AgentStatus,
		Purpose: generation.Purpose, Summary: generation.Summary, Action: generation.Action, Priority: generation.Priority,
		Options:     generation.Options,
		GeneratedAt: s.now().UTC(),
	}
	s.saveResult(ctx, metadata, summary)
}

func (s *Service) saveResult(ctx context.Context, expected session.Metadata, summary session.AgentSummary) {
	current, ok := s.sessions.Metadata(expected.ID)
	if !ok || !sameAgentState(expected, current) {
		hadPending := s.finishInflight(ctx, expected.ID)
		if !hadPending && ok && isAgentState(current) {
			s.mu.Lock()
			s.latest[current.ID] = metadataKey(current)
			s.mu.Unlock()
			s.schedule(ctx, current)
		}
		return
	}
	if summary.Error != "" {
		for _, previous := range s.sessions.AgentSummaries() {
			if previous.TerminalID == expected.ID && previous.Error == "" {
				summary.Purpose = previous.Purpose
				summary.Summary = previous.Summary
				summary.Action = previous.Action
				summary.Priority = previous.Priority
				summary.Options = cloneSummaryOptions(previous.Options)
				break
			}
		}
	}
	if err := s.sessions.SaveAgentSummary(ctx, summary); err != nil {
		s.finishInflight(ctx, expected.ID)
		return
	}
	persisted := summary
	for _, current := range s.sessions.AgentSummaries() {
		if current.TerminalID == expected.ID {
			persisted = current
			break
		}
	}
	s.finishInflight(ctx, expected.ID)
	s.events.Publish(terminalSummaryUpdatedEvent, persisted)
}

func cloneSummaryOptions(options []session.AgentSummaryOption) []session.AgentSummaryOption {
	if options == nil {
		return nil
	}
	return append([]session.AgentSummaryOption(nil), options...)
}

func (s *Service) finishInflight(ctx context.Context, id string) bool {
	s.mu.Lock()
	delete(s.inflight, id)
	pending, ok := s.pending[id]
	delete(s.pending, id)
	s.mu.Unlock()
	if ok {
		s.schedule(ctx, pending)
	}
	return ok
}

func (s *Service) hasFreshSummary(metadata session.Metadata) bool {
	for _, summary := range s.sessions.AgentSummaries() {
		if summary.TerminalID == metadata.ID && summary.Status == metadata.AgentStatus && summary.Error == "" {
			return true
		}
	}
	return false
}

func (s *Service) promptFor(metadata session.Metadata) string {
	var transcript []agentlog.Entry
	originalRequest := ""
	if s.resolver != nil && metadata.AgentSessionID != "" {
		agent := metadata.Agent
		if agent == "" {
			agent = metadata.ResumeAgent
		}
		if path, err := s.resolver.Resolve(agent, metadata.AgentSessionID, metadata.AgentTranscriptPath); err == nil {
			if file, err := os.Open(path); err == nil {
				if info, err := file.Stat(); err == nil {
					if page, err := agentlog.ReadPage(agent, file, info.Size(), maxTranscriptEntries); err == nil {
						transcript = page.Entries
					}
				}
				originalRequest = readOriginalRequest(agent, file)
				_ = file.Close()
			}
		}
	}
	var terminalTail []byte
	if terminal, ok := s.sessions.Get(metadata.ID); ok {
		terminalTail, _ = terminal.HistorySnapshot(maxTerminalContextBytes)
	}
	return BuildPrompt(
		metadata,
		transcript,
		terminalTail,
		s.sessions.Settings().AgentSummaryPrompt,
		originalRequest,
		s.sessions.AgentSummaryHistory(metadata.ID),
	)
}

// readOriginalRequest parses the head of a transcript to recover the request
// that started the session. The tail page the summary otherwise sees only shows
// the current subtask, which is why purpose used to drift onto it.
func readOriginalRequest(agent string, file *os.File) string {
	entries, err := agentlog.ParseAt(agent, io.NewSectionReader(file, 0, maxTranscriptHeadBytes), 0)
	if err != nil {
		return ""
	}
	return firstUserRequest(entries)
}

func isAgentState(metadata session.Metadata) bool {
	return metadata.Agent != "" &&
		(metadata.AgentStatus == "running" || metadata.AgentStatus == "waiting" || metadata.AgentStatus == "blocked")
}

func sameAgentState(left, right session.Metadata) bool {
	return left.Agent == right.Agent && left.AgentSessionID == right.AgentSessionID &&
		left.AgentStatus == right.AgentStatus
}

func metadataKey(metadata session.Metadata) string {
	return strings.Join([]string{metadata.Agent, metadata.AgentSessionID, metadata.AgentStatus}, "\x00")
}

func eventMetadata(value any) (session.Metadata, bool) {
	switch metadata := value.(type) {
	case session.Metadata:
		return metadata, true
	case *session.Metadata:
		if metadata != nil {
			return *metadata, true
		}
	}
	return session.Metadata{}, false
}

func deletedTerminalID(value any) string {
	if deleted, ok := value.(map[string]string); ok {
		return deleted["id"]
	}
	if deleted, ok := value.(map[string]any); ok {
		if id, ok := deleted["id"].(string); ok {
			return id
		}
	}
	return ""
}
