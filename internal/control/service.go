package control

import (
	"context"
	"errors"
	"reflect"
	"sort"
	"sync"
	"time"

	"github.com/ryotarai/euphony/internal/selection"
	"github.com/ryotarai/euphony/internal/session"
)

const defaultEventBufferSize = 128

const (
	defaultAutomationQuietPeriod = 120 * time.Millisecond
	defaultAutomationMaxSettle   = 2 * time.Second
)

type Service struct {
	sessions *session.Manager
	events   *eventHub

	runCommand      func(string, string) error
	sendInput       func(string, TerminalInput) error
	agentForeground func(string, string) error

	dispatchMu         sync.Mutex
	lastChangeSequence uint64

	mu        sync.RWMutex
	selection selection.State
	snapshot  selection.Snapshot

	automationMu          sync.RWMutex
	automationLocks       map[string]struct{}
	automationGatesMu     sync.Mutex
	automationGates       map[string]*sync.RWMutex
	automationQuietPeriod time.Duration
	automationMaxSettle   time.Duration
}

func New(manager *session.Manager) (*Service, error) {
	state, found, err := manager.LoadSelection(context.Background())
	if err != nil {
		return nil, err
	}
	terminals := projectTerminals(manager.ListCurrent())
	if !found {
		if len(terminals) > 0 {
			state.ManualTerminalIDs = []string{terminals[0].ID}
			state.FocusedTerminalID = terminals[0].ID
			state.Revision = 1
		}
	} else {
		state, _ = selection.Reconcile(state, terminals)
	}
	if !found || state.Revision > 0 {
		if err := manager.SaveSelection(context.Background(), state); err != nil {
			return nil, err
		}
	}
	service := &Service{
		sessions:              manager,
		events:                newEventHub(defaultEventBufferSize, time.Now),
		selection:             state,
		snapshot:              selection.Resolve(state, terminals),
		automationLocks:       make(map[string]struct{}),
		automationGates:       make(map[string]*sync.RWMutex),
		automationQuietPeriod: defaultAutomationQuietPeriod,
		automationMaxSettle:   defaultAutomationMaxSettle,
	}
	service.runCommand = service.RunTerminal
	service.sendInput = service.SendTerminalInput
	service.agentForeground = service.requireAgentForeground
	manager.SetChangeHandler(service.handleSessionChange)
	service.dispatchMu.Lock()
	service.reconcileFromSessions(nil)
	service.dispatchMu.Unlock()
	return service, nil
}

func (s *Service) Selection() selection.Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneSnapshot(s.snapshot)
}

func (s *Service) ApplySelection(
	ctx context.Context,
	action selection.Action,
) (selection.Snapshot, error) {
	s.dispatchMu.Lock()
	defer s.dispatchMu.Unlock()

	terminals := projectTerminals(s.sessions.ListCurrent())
	s.mu.Lock()
	next, err := selection.Apply(s.selection, action, terminals)
	if err != nil {
		s.mu.Unlock()
		return selection.Snapshot{}, err
	}
	if err := s.sessions.SaveSelection(ctx, next); err != nil {
		s.mu.Unlock()
		return selection.Snapshot{}, err
	}
	s.selection = next
	s.snapshot = selection.Resolve(next, terminals)
	snapshot := cloneSnapshot(s.snapshot)
	s.mu.Unlock()
	s.events.publish("selection.changed", snapshot)
	return snapshot, nil
}

func (s *Service) SubscribeEvents(types []string) (<-chan Event, func()) {
	return s.events.subscribe(types)
}

func (s *Service) Heartbeat() Event {
	return s.events.heartbeat()
}

func (s *Service) Publish(eventType string, data any) Event {
	return s.events.publish(eventType, data)
}

func (s *Service) handleSessionChange(change session.Change) {
	s.dispatchMu.Lock()
	defer s.dispatchMu.Unlock()
	if change.Sequence != 0 && change.Sequence <= s.lastChangeSequence {
		return
	}
	if change.Sequence != 0 {
		s.lastChangeSequence = change.Sequence
	}
	s.reconcileFromSessions(&change)
}

func (s *Service) reconcileFromSessions(change *session.Change) {
	metadata := s.sessions.ListCurrent()
	terminals := projectTerminals(metadata)
	s.mu.Lock()
	previousSnapshot := s.snapshot
	next := s.selection
	var err error
	if shouldPromoteFocusedAgent(previousSnapshot, change) {
		next, err = selection.Apply(next, selection.Action{
			Type:              selection.ActionPromoteFocusedAgent,
			FocusedTerminalID: change.After.ID,
		}, terminals)
	} else {
		var cleaned bool
		if change != nil && change.Kind == session.ChangeDeleted && change.Before != nil {
			next, cleaned = selection.ReconcileAfterTerminalDeletion(
				next,
				previousSnapshot,
				change.Before.ID,
				replacementTerminalID(*change.Before, metadata),
				terminals,
			)
		} else {
			next, cleaned = selection.Reconcile(next, terminals)
		}
		resolved := selection.Resolve(next, terminals)
		if !cleaned && !snapshotsEqualIgnoringRevision(previousSnapshot, resolved) {
			next.Revision++
		}
	}
	if err != nil {
		s.mu.Unlock()
		return
	}
	nextSnapshot := selection.Resolve(next, terminals)
	selectionChanged := !reflect.DeepEqual(previousSnapshot, nextSnapshot)
	if selectionChanged {
		if err := s.sessions.SaveSelection(context.Background(), next); err != nil {
			s.mu.Unlock()
			return
		}
		s.selection = next
		s.snapshot = nextSnapshot
	}
	snapshot := cloneSnapshot(nextSnapshot)
	s.mu.Unlock()

	if change != nil {
		s.publishSessionChange(*change)
	}
	if selectionChanged {
		s.events.publish("selection.changed", snapshot)
	}
}

func (s *Service) publishSessionChange(change session.Change) {
	switch change.Kind {
	case session.ChangeCreated:
		s.events.publish("terminal.created", *change.After)
	case session.ChangeUpdated:
		s.events.publish("terminal.updated", *change.After)
		if change.Before != nil && change.After != nil &&
			(change.Before.Agent != change.After.Agent ||
				change.Before.AgentStatus != change.After.AgentStatus ||
				change.Before.AgentTitle != change.After.AgentTitle ||
				change.Before.NeedsAttention != change.After.NeedsAttention) {
			s.events.publish("agent.updated", *change.After)
		}
	case session.ChangeDeleted:
		s.events.publish("terminal.deleted", map[string]string{"id": change.Before.ID})
	}
}

func projectTerminals(metadata []session.Metadata) []selection.Terminal {
	result := make([]selection.Terminal, 0, len(metadata))
	for _, item := range metadata {
		statuses := make([]string, 0, 2)
		if item.NeedsAttention {
			statuses = append(statuses, "attention")
		}
		if item.AgentStatus != "" {
			statuses = append(statuses, item.AgentStatus)
		} else if item.State == session.StateRunning {
			statuses = append(statuses, "terminal")
		} else {
			statuses = append(statuses, string(item.State))
		}
		result = append(result, selection.Terminal{
			ID:       item.ID,
			CWD:      item.CWD,
			Statuses: statuses,
		})
	}
	return result
}

func replacementTerminalID(deleted session.Metadata, remaining []session.Metadata) string {
	index := sort.Search(len(remaining), func(index int) bool {
		return !remaining[index].CreatedAt.Before(deleted.CreatedAt)
	})
	if index < len(remaining) {
		return remaining[index].ID
	}
	if len(remaining) == 0 {
		return ""
	}
	return remaining[len(remaining)-1].ID
}

func shouldPromoteFocusedAgent(snapshot selection.Snapshot, change *session.Change) bool {
	return change != nil &&
		change.Before != nil &&
		change.After != nil &&
		change.Before.Agent == "" &&
		change.After.Agent != "" &&
		snapshot.FocusedTerminalID == change.After.ID
}

func snapshotsEqualIgnoringRevision(left, right selection.Snapshot) bool {
	left.Revision = 0
	right.Revision = 0
	return reflect.DeepEqual(left, right)
}

func cloneSnapshot(snapshot selection.Snapshot) selection.Snapshot {
	return selection.Snapshot{
		TerminalIDs:       append([]string{}, snapshot.TerminalIDs...),
		ManualTerminalIDs: append([]string{}, snapshot.ManualTerminalIDs...),
		PinnedTerminalIDs: append([]string{}, snapshot.PinnedTerminalIDs...),
		FocusedTerminalID: snapshot.FocusedTerminalID,
		Filters: selection.Filters{
			Statuses: append([]string{}, snapshot.Filters.Statuses...),
			CWDs:     append([]selection.CWDFilter{}, snapshot.Filters.CWDs...),
		},
		PinnedFilters: selection.Filters{
			Statuses: append([]string{}, snapshot.PinnedFilters.Statuses...),
			CWDs:     append([]selection.CWDFilter{}, snapshot.PinnedFilters.CWDs...),
		},
		Revision: snapshot.Revision,
	}
}

func IsSelectionError(err error) bool {
	return errors.Is(err, selection.ErrInvalidAction) ||
		errors.Is(err, selection.ErrRevisionConflict) ||
		errors.Is(err, selection.ErrTerminalNotFound) ||
		errors.Is(err, selection.ErrTerminalNotSelected)
}
