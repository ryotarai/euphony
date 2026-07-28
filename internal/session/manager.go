package session

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
)

var ErrNotFound = errors.New("session not found")

type Metadata struct {
	ID             string     `json:"id"`
	Name           string     `json:"name"`
	State          State      `json:"state"`
	CWD            string     `json:"cwd"`
	Agent          string     `json:"agent,omitempty"`
	AgentStatus    string     `json:"agentStatus,omitempty"`
	AgentTitle     string     `json:"agentTitle,omitempty"`
	AgentSessionID string     `json:"-"`
	ResumeAgent    string     `json:"-"`
	CreatedAt      time.Time  `json:"createdAt"`
	ExitedAt       *time.Time `json:"exitedAt,omitempty"`
	ExitCode       *int       `json:"exitCode,omitempty"`
	Message        string     `json:"message,omitempty"`
}

type HookConfig struct {
	URL   string
	Token string
}

type AgentUpdate struct {
	Agent          string
	ResumeAgent    string
	AgentSessionID string
	Status         string
	Title          string
	CWD            string
}

type entry struct {
	metadata Metadata
	session  *Session
}

type Manager struct {
	mu       sync.RWMutex
	shell    string
	hooks    HookConfig
	sessions map[string]*entry
	store    metadataStore
}

func NewPersistentManager(shell string, hooks HookConfig, path string) (*Manager, error) {
	store, err := OpenSQLiteStore(path)
	if err != nil {
		return nil, err
	}
	manager := NewManager(shell, hooks)
	manager.store = store
	items, err := store.Load(context.Background())
	if err != nil {
		_ = store.Close()
		return nil, err
	}
	for _, metadata := range items {
		if err := manager.restore(metadata); err != nil {
			_ = manager.Close(context.Background())
			return nil, fmt.Errorf("restore terminal %s: %w", metadata.ID, err)
		}
	}
	return manager, nil
}

func NewManager(shell string, hookConfigs ...HookConfig) *Manager {
	if shell == "" {
		shell = os.Getenv("SHELL")
	}
	if shell == "" {
		shell = "/bin/sh"
	}
	var hooks HookConfig
	if len(hookConfigs) > 0 {
		hooks = hookConfigs[0]
	}
	return &Manager{shell: shell, hooks: hooks, sessions: make(map[string]*entry)}
}

func (m *Manager) Create(_ context.Context, name string) (Metadata, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return Metadata{}, errors.New("session name is required")
	}
	if len(name) > 80 {
		return Metadata{}, errors.New("session name must be at most 80 characters")
	}

	id, err := randomID()
	if err != nil {
		return Metadata{}, err
	}
	cwd, err := os.Getwd()
	if err != nil {
		return Metadata{}, err
	}
	metadata := Metadata{
		ID:        id,
		Name:      name,
		State:     StateRunning,
		CWD:       cwd,
		CreatedAt: time.Now().UTC(),
	}
	item, err := m.start(metadata, exec.Command(m.shell))
	if err != nil {
		return Metadata{}, err
	}
	if m.store != nil {
		if err := m.store.Save(context.Background(), metadata); err != nil {
			item.session.terminate()
			return Metadata{}, err
		}
	}
	m.mu.Lock()
	m.sessions[id] = item
	m.mu.Unlock()

	go item.session.pump()
	go m.watch(item)
	return item.metadata, nil
}

func (m *Manager) restore(metadata Metadata) error {
	metadata.State = StateRunning
	metadata.ExitedAt = nil
	metadata.ExitCode = nil
	metadata.Message = ""
	command := restoredCommand(m.shell, metadata)
	item, err := m.start(metadata, command)
	if err != nil {
		return err
	}
	if err := m.store.Save(context.Background(), metadata); err != nil {
		item.session.terminate()
		return err
	}
	m.sessions[metadata.ID] = item
	go item.session.pump()
	go m.watch(item)
	return nil
}

func restoredCommand(shell string, metadata Metadata) *exec.Cmd {
	agent := metadata.ResumeAgent
	if agent == "" {
		agent = metadata.Agent
	}
	if metadata.AgentSessionID != "" {
		switch agent {
		case "codex":
			return exec.Command("codex", "resume", metadata.AgentSessionID)
		case "claude":
			return exec.Command("claude", "--resume", metadata.AgentSessionID)
		}
	}
	return exec.Command(shell)
}

func (m *Manager) start(metadata Metadata, command *exec.Cmd) (*entry, error) {
	command.Dir = metadata.CWD
	command.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"EUPHONY_TERMINAL_ID="+metadata.ID,
		"EUPHONY_HOOK_URL="+m.hooks.URL,
		"EUPHONY_TOKEN="+m.hooks.Token,
	)
	terminal, err := pty.StartWithSize(command, &pty.Winsize{Cols: 80, Rows: 24})
	if err != nil {
		return nil, err
	}
	return &entry{
		metadata: metadata,
		session: &Session{
			id:          metadata.ID,
			command:     command,
			terminal:    terminal,
			waitDone:    make(chan struct{}),
			pumpDone:    make(chan struct{}),
			subscribers: make(map[uint64]chan []byte),
		},
	}, nil
}

func (m *Manager) UpdateAgent(id string, update AgentUpdate) (Metadata, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	item, ok := m.sessions[id]
	if !ok {
		return Metadata{}, ErrNotFound
	}
	item.metadata.Agent = strings.TrimSpace(update.Agent)
	if resumeAgent := strings.TrimSpace(update.ResumeAgent); resumeAgent != "" {
		item.metadata.ResumeAgent = resumeAgent
	} else if item.metadata.Agent != "" {
		item.metadata.ResumeAgent = item.metadata.Agent
	}
	if sessionID := strings.TrimSpace(update.AgentSessionID); sessionID != "" {
		item.metadata.AgentSessionID = sessionID
	}
	item.metadata.AgentStatus = strings.TrimSpace(update.Status)
	item.metadata.AgentTitle = strings.TrimSpace(update.Title)
	if cwd := strings.TrimSpace(update.CWD); cwd != "" {
		item.metadata.CWD = cwd
	}
	if m.store != nil {
		if err := m.store.Save(context.Background(), item.metadata); err != nil {
			return Metadata{}, err
		}
	}
	return item.metadata, nil
}

func (m *Manager) watch(item *entry) {
	err := item.session.command.Wait()
	now := time.Now().UTC()
	exitCode := item.session.command.ProcessState.ExitCode()

	m.mu.Lock()
	if current, ok := m.sessions[item.metadata.ID]; ok && current == item {
		current.metadata.State = StateExited
		current.metadata.ExitedAt = &now
		current.metadata.ExitCode = &exitCode
		if err != nil {
			current.metadata.Message = err.Error()
		}
		if m.store != nil {
			_ = m.store.Save(context.Background(), current.metadata)
		}
	}
	m.mu.Unlock()
	close(item.session.waitDone)
}

func (m *Manager) List() []Metadata {
	m.mu.RLock()
	result := make([]Metadata, 0, len(m.sessions))
	for _, item := range m.sessions {
		result = append(result, item.metadata)
	}
	m.mu.RUnlock()
	sort.Slice(result, func(i, j int) bool {
		return result[i].CreatedAt.Before(result[j].CreatedAt)
	})
	return result
}

func (m *Manager) Get(id string) (*Session, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	item, ok := m.sessions[id]
	if !ok {
		return nil, false
	}
	return item.session, true
}

func (m *Manager) Delete(id string) error {
	m.mu.Lock()
	item, ok := m.sessions[id]
	if ok {
		delete(m.sessions, id)
	}
	m.mu.Unlock()
	if !ok {
		return ErrNotFound
	}
	if m.store != nil {
		if err := m.store.Delete(context.Background(), id); err != nil {
			m.mu.Lock()
			m.sessions[id] = item
			m.mu.Unlock()
			return err
		}
	}
	item.session.terminate()
	return nil
}

func (m *Manager) Close(ctx context.Context) error {
	m.mu.RLock()
	items := make([]*entry, 0, len(m.sessions))
	for _, item := range m.sessions {
		items = append(items, item)
	}
	m.mu.RUnlock()

	for _, item := range items {
		item.session.terminate()
	}
	for _, item := range items {
		select {
		case <-item.session.waitDone:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if m.store != nil {
		return m.store.Close()
	}
	return nil
}

func randomID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(value[:]), nil
}
