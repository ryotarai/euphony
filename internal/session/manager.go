package session

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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
	RepoRoot       string     `json:"repoRoot"`
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
	URL               string
	Token             string
	CodexSessionIndex string
}

type AgentUpdate struct {
	Agent          string
	ResumeAgent    string
	AgentSessionID string
	Status         string
	Title          string
	CWD            string
}

type Settings struct {
	Prefix           string `json:"prefix"`
	SidebarWidth     int    `json:"sidebarWidth"`
	SidebarCollapsed bool   `json:"sidebarCollapsed"`
}

func DefaultSettings() Settings {
	return Settings{Prefix: "Ctrl+B", SidebarWidth: 304}
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
	closing  bool
	settings Settings
}

func NewPersistentManager(shell string, hooks HookConfig, path string) (*Manager, error) {
	store, err := OpenSQLiteStore(path)
	if err != nil {
		return nil, err
	}
	manager := NewManager(shell, hooks)
	manager.store = store
	manager.settings, err = store.LoadSettings(context.Background())
	if err != nil {
		_ = store.Close()
		return nil, err
	}
	items, err := store.Load(context.Background())
	if err != nil {
		_ = store.Close()
		return nil, err
	}
	for _, metadata := range items {
		if metadata.State == StateExited {
			if err := store.Delete(context.Background(), metadata.ID); err != nil {
				_ = manager.Close(context.Background())
				return nil, fmt.Errorf("purge exited terminal %s: %w", metadata.ID, err)
			}
			continue
		}
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
	return &Manager{
		shell: shell, hooks: hooks, sessions: make(map[string]*entry),
		settings: DefaultSettings(),
	}
}

func (m *Manager) Create(_ context.Context, name string, requestedCWD ...string) (Metadata, error) {
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
	cwd := ""
	if len(requestedCWD) > 0 {
		cwd = strings.TrimSpace(requestedCWD[0])
	}
	if cwd == "" {
		var err error
		cwd, err = os.Getwd()
		if err != nil {
			return Metadata{}, err
		}
	}
	cwd, err = filepath.Abs(cwd)
	if err != nil {
		return Metadata{}, err
	}
	info, err := os.Stat(cwd)
	if err != nil || !info.IsDir() {
		return Metadata{}, errors.New("working directory must be an existing directory")
	}
	metadata := Metadata{
		ID:        id,
		Name:      name,
		State:     StateRunning,
		CWD:       cwd,
		RepoRoot:  repositoryRoot(cwd),
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
	if info, err := os.Stat(metadata.CWD); err != nil || !info.IsDir() {
		fallback, fallbackErr := os.Getwd()
		if fallbackErr != nil {
			return fallbackErr
		}
		metadata.CWD = fallback
	}
	if metadata.RepoRoot == "" {
		metadata.RepoRoot = repositoryRoot(metadata.CWD)
	}
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
		"LANG=en_US.UTF-8",
		"LC_CTYPE=en_US.UTF-8",
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
	nextStatus := strings.TrimSpace(update.Status)
	if item.metadata.AgentStatus == "running" && nextStatus == "waiting" {
		nextStatus = "attention"
	}
	item.metadata.AgentStatus = nextStatus
	if title := strings.TrimSpace(update.Title); title != "" {
		item.metadata.AgentTitle = title
	} else if item.metadata.Agent == "" && nextStatus == "" {
		item.metadata.AgentTitle = ""
	}
	if cwd := strings.TrimSpace(update.CWD); cwd != "" {
		item.metadata.CWD = cwd
		item.metadata.RepoRoot = repositoryRoot(cwd)
	}
	if m.store != nil {
		if err := m.store.Save(context.Background(), item.metadata); err != nil {
			return Metadata{}, err
		}
	}
	return item.metadata, nil
}

func (m *Manager) UpdateCWD(id, cwd string) (Metadata, error) {
	cwd, err := normalizeReportedCWD(cwd)
	if err != nil {
		return Metadata{}, err
	}
	return m.updateCWD(id, cwd, false)
}

func normalizeReportedCWD(cwd string) (string, error) {
	cwd = strings.TrimSpace(cwd)
	if len(cwd) > 4096 {
		return "", errors.New("working directory is too long")
	}
	if cwd == "~" || strings.HasPrefix(cwd, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		if cwd == "~" {
			cwd = home
		} else {
			cwd = filepath.Join(home, strings.TrimPrefix(cwd, "~/"))
		}
	}
	if !filepath.IsAbs(cwd) {
		return "", errors.New("working directory must be absolute")
	}
	cwd = filepath.Clean(cwd)
	info, err := os.Stat(cwd)
	if err != nil || !info.IsDir() {
		return "", errors.New("working directory must be an existing directory")
	}
	return cwd, nil
}

func (m *Manager) updateCWD(id, cwd string, preserveEquivalentPath bool) (Metadata, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	item, ok := m.sessions[id]
	if !ok {
		return Metadata{}, ErrNotFound
	}
	if item.metadata.CWD == cwd {
		return item.metadata, nil
	}
	if preserveEquivalentPath {
		currentInfo, currentErr := os.Stat(item.metadata.CWD)
		nextInfo, nextErr := os.Stat(cwd)
		if currentErr == nil && nextErr == nil && os.SameFile(currentInfo, nextInfo) {
			return item.metadata, nil
		}
	}
	next := item.metadata
	next.CWD = cwd
	next.RepoRoot = repositoryRoot(cwd)
	if m.store != nil {
		if err := m.store.Save(context.Background(), next); err != nil {
			return Metadata{}, err
		}
	}
	item.metadata = next
	return next, nil
}

func (m *Manager) RefreshCWD(id string) (Metadata, error) {
	m.mu.RLock()
	item, ok := m.sessions[id]
	m.mu.RUnlock()
	if !ok {
		return Metadata{}, ErrNotFound
	}
	cwd, err := item.session.WorkingDirectory()
	if err != nil {
		return Metadata{}, err
	}
	cwd, err = normalizeReportedCWD(cwd)
	if err != nil {
		return Metadata{}, err
	}
	return m.updateCWD(id, cwd, true)
}

func repositoryRoot(cwd string) string {
	resolved, err := filepath.EvalSymlinks(cwd)
	if err != nil {
		resolved = cwd
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return cwd
	}
	command := exec.Command("git", "-C", resolved, "rev-parse", "--path-format=absolute", "--git-common-dir")
	output, err := command.Output()
	if err != nil {
		return resolved
	}
	common := strings.TrimSpace(string(output))
	if filepath.Base(common) == ".git" {
		return filepath.Dir(common)
	}
	return resolved
}

func (m *Manager) watch(item *entry) {
	_ = item.session.command.Wait()

	m.mu.Lock()
	if current, ok := m.sessions[item.metadata.ID]; ok && current == item {
		if !m.closing {
			delete(m.sessions, item.metadata.ID)
			if m.store != nil {
				_ = m.store.Delete(context.Background(), item.metadata.ID)
			}
		}
	}
	m.mu.Unlock()
	close(item.session.waitDone)
}

func (m *Manager) List() []Metadata {
	m.refreshCodexTitles()
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

func (m *Manager) refreshCodexTitles() {
	if m.hooks.CodexSessionIndex == "" {
		return
	}
	titles, err := loadCodexSessionTitles(m.hooks.CodexSessionIndex)
	if err != nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, item := range m.sessions {
		if item.metadata.Agent != "codex" || item.metadata.AgentSessionID == "" {
			continue
		}
		title := titles[item.metadata.AgentSessionID]
		if title == "" || title == item.metadata.AgentTitle {
			continue
		}
		item.metadata.AgentTitle = title
		if m.store != nil {
			_ = m.store.Save(context.Background(), item.metadata)
		}
	}
}

func (m *Manager) Settings() Settings {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.settings
}

func (m *Manager) UpdateSettings(ctx context.Context, settings Settings) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.store != nil {
		if err := m.store.SaveSettings(ctx, settings); err != nil {
			return err
		}
	}
	m.settings = settings
	return nil
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

func (m *Manager) CurrentCWD(id string) (string, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	item, ok := m.sessions[id]
	if !ok {
		return "", false
	}
	return item.metadata.CWD, true
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
	m.mu.Lock()
	m.closing = true
	items := make([]*entry, 0, len(m.sessions))
	for _, item := range m.sessions {
		items = append(items, item)
	}
	m.mu.Unlock()

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
