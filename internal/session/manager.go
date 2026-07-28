package session

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
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
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	State     State      `json:"state"`
	CreatedAt time.Time  `json:"createdAt"`
	ExitedAt  *time.Time `json:"exitedAt,omitempty"`
	ExitCode  *int       `json:"exitCode,omitempty"`
	Message   string     `json:"message,omitempty"`
}

type entry struct {
	metadata Metadata
	session  *Session
}

type Manager struct {
	mu       sync.RWMutex
	shell    string
	sessions map[string]*entry
}

func NewManager(shell string) *Manager {
	if shell == "" {
		shell = os.Getenv("SHELL")
	}
	if shell == "" {
		shell = "/bin/sh"
	}
	return &Manager{shell: shell, sessions: make(map[string]*entry)}
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
	command := exec.Command(m.shell)
	command.Env = append(os.Environ(), "TERM=xterm-256color")
	terminal, err := pty.StartWithSize(command, &pty.Winsize{Cols: 80, Rows: 24})
	if err != nil {
		return Metadata{}, err
	}

	item := &entry{
		metadata: Metadata{
			ID:        id,
			Name:      name,
			State:     StateRunning,
			CreatedAt: time.Now().UTC(),
		},
		session: &Session{
			id:       id,
			command:  command,
			terminal: terminal,
			waitDone: make(chan struct{}),
		},
	}
	m.mu.Lock()
	m.sessions[id] = item
	m.mu.Unlock()

	go m.watch(item)
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
	return nil
}

func randomID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(value[:]), nil
}
