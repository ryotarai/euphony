package session

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/ryotarai/euphony/internal/agentlog"
	"github.com/ryotarai/euphony/internal/selection"
	"golang.org/x/sys/unix"
)

var ErrNotFound = errors.New("session not found")

type ChangeKind string

const (
	ChangeCreated ChangeKind = "created"
	ChangeUpdated ChangeKind = "updated"
	ChangeDeleted ChangeKind = "deleted"
)

type Change struct {
	Sequence uint64
	Kind     ChangeKind
	Before   *Metadata
	After    *Metadata
}

type Metadata struct {
	ID                  string     `json:"id"`
	Name                string     `json:"name"`
	State               State      `json:"state"`
	CWD                 string     `json:"cwd"`
	RepoRoot            string     `json:"repoRoot"`
	ProcessName         string     `json:"processName,omitempty"`
	Agent               string     `json:"agent,omitempty"`
	AgentStatus         string     `json:"agentStatus,omitempty"`
	NeedsAttention      bool       `json:"needsAttention,omitempty"`
	AgentTitle          string     `json:"agentTitle,omitempty"`
	AgentSessionID      string     `json:"-"`
	AgentTranscriptPath string     `json:"-"`
	ResumeAgent         string     `json:"-"`
	CreatedAt           time.Time  `json:"createdAt"`
	ExitedAt            *time.Time `json:"exitedAt,omitempty"`
	ExitCode            *int       `json:"exitCode,omitempty"`
	Message             string     `json:"message,omitempty"`
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
	TranscriptPath string
	Status         string
	Title          string
	CWD            string
}

type Settings struct {
	Prefix                    string  `json:"prefix"`
	PaneTabShortcut           string  `json:"paneTabShortcut"`
	SidebarWidth              int     `json:"sidebarWidth"`
	SidebarCollapsed          bool    `json:"sidebarCollapsed"`
	InterfaceFontSize         int     `json:"interfaceFontSize"`
	TerminalFontSize          int     `json:"terminalFontSize"`
	TerminalFontFamily        string  `json:"terminalFontFamily"`
	AgentLogFontSize          int     `json:"agentLogFontSize"`
	TerminalHistoryLimit      int     `json:"terminalHistoryLimit"`
	AutoSelectAttention       bool    `json:"autoSelectAttention"`
	AutoDeselectRunning       bool    `json:"autoDeselectRunning"`
	TerminalLineHeight        float64 `json:"terminalLineHeight"`
	TerminalCursorStyle       string  `json:"terminalCursorStyle"`
	TerminalCursorBlink       bool    `json:"terminalCursorBlink"`
	TerminalScrollSensitivity int     `json:"terminalScrollSensitivity"`
	TerminalOptionAsAlt       bool    `json:"terminalOptionAsAlt"`
}

const (
	DefaultTerminalFontFamily        = `Menlo, Monaco, "Hiragino Sans", "Yu Gothic", "Noto Sans Mono CJK JP", monospace`
	DefaultTerminalHistoryLimit      = 1024 * 1024
	MinTerminalHistoryLimit          = 1024 * 1024
	MaxTerminalHistoryLimit          = 4095 * 1024 * 1024
	DefaultTerminalLineHeight        = 1.25
	DefaultTerminalCursorStyle       = "bar"
	DefaultTerminalCursorBlink       = false
	DefaultTerminalScrollSensitivity = 3
	DefaultTerminalOptionAsAlt       = true
)

func DefaultSettings() Settings {
	return Settings{
		Prefix:                    "Ctrl+B",
		PaneTabShortcut:           "Meta+L",
		SidebarWidth:              304,
		InterfaceFontSize:         16,
		TerminalFontSize:          14,
		TerminalFontFamily:        DefaultTerminalFontFamily,
		AgentLogFontSize:          14,
		TerminalHistoryLimit:      DefaultTerminalHistoryLimit,
		AutoSelectAttention:       true,
		AutoDeselectRunning:       true,
		TerminalLineHeight:        DefaultTerminalLineHeight,
		TerminalCursorStyle:       DefaultTerminalCursorStyle,
		TerminalCursorBlink:       DefaultTerminalCursorBlink,
		TerminalScrollSensitivity: DefaultTerminalScrollSensitivity,
		TerminalOptionAsAlt:       DefaultTerminalOptionAsAlt,
	}
}

type entry struct {
	metadata           Metadata
	session            *Session
	interruptWatch     *agentInterruptWatch
	codexActivityWatch *codexActivityWatch
	// cwdFromAgent records that an agent hook named this terminal's working
	// directory. An agent knows its project directory where its process only
	// knows where it happens to stand — a worktree it entered, say — so without
	// this the hook and the sampler would overwrite each other forever.
	cwdFromAgent bool
	cwdSampledAt time.Time
	// cwdReportedAt is when the terminal last named its own directory over the
	// WebSocket. That report is faster than a sample and describes the very
	// prompt the reader is looking at, so it wins for one sampling interval —
	// after which the process is asked again and either confirms it or corrects
	// a claim that has gone stale.
	cwdReportedAt              time.Time
	foregroundProcessSampledAt time.Time
	// codexTitleHeaderScanned records the one-time bounded header recovery for
	// Codex sessions whose automatic name predates the tail polling window.
	codexTitleHeaderScanned bool
}

type agentInterruptTarget struct {
	sessionID      string
	transcriptPath string
	turnID         string
	offset         int64
}

type agentInterruptWatch struct {
	target agentInterruptTarget
	cancel context.CancelFunc
}

type codexActivityTarget struct {
	sessionID      string
	transcriptPath string
	offset         int64
}

type codexActivityWatch struct {
	target codexActivityTarget
	cancel context.CancelFunc
}

// defaultCWDSampleInterval bounds how often a terminal's working directory is
// sampled from its live process. Keystrokes arriving over the terminal
// WebSocket sample on demand; this backstop is what corrects a terminal driven
// through the automation API, or restored after a restart, which would
// otherwise keep displaying a directory it left long ago.
const defaultCWDSampleInterval = 5 * time.Second
const defaultForegroundProcessSampleInterval = 500 * time.Millisecond

type Manager struct {
	mu                              sync.RWMutex
	refreshMu                       sync.Mutex
	shell                           string
	hooks                           HookConfig
	sessions                        map[string]*entry
	store                           metadataStore
	closing                         bool
	settings                        Settings
	onChange                        func(Change)
	changeSequence                  uint64
	cwdSampleInterval               time.Duration
	foregroundProcessSampleInterval time.Duration
	codexTitleResolver              func(string, string, bool) (string, error)

	workspaceSelection    selection.State
	hasWorkspaceSelection bool
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
		settings: DefaultSettings(), cwdSampleInterval: defaultCWDSampleInterval,
		foregroundProcessSampleInterval: defaultForegroundProcessSampleInterval,
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
		cwd, err = os.UserHomeDir()
		if err != nil {
			return Metadata{}, fmt.Errorf("resolve home directory: %w", err)
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
	go item.session.pump()
	if m.store != nil {
		if err := m.store.Save(context.Background(), metadata); err != nil {
			discardStartedSession(item.session)
			return Metadata{}, err
		}
	}
	m.registerSession(id, item)
	created := item.metadata
	m.mu.Lock()
	change := m.nextChangeLocked(ChangeCreated, nil, &created)
	m.mu.Unlock()
	m.emitChange(change)

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
	go item.session.pump()
	if err := m.store.Save(context.Background(), metadata); err != nil {
		discardStartedSession(item.session)
		return err
	}
	m.registerSession(metadata.ID, item)
	go m.watch(item)
	return nil
}

func discardStartedSession(running *Session) {
	running.terminate()
	_ = running.command.Wait()
	<-running.pumpDone
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
	if metadata.ProcessName == "" && len(command.Args) > 0 {
		metadata.ProcessName = foregroundProcessName(command.Args[0])
	}
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
	terminalFD := int(terminal.Fd())
	if err := unix.SetNonblock(terminalFD, true); err != nil {
		_ = command.Process.Kill()
		_ = terminal.Close()
		_ = command.Wait()
		return nil, err
	}
	resizeWake := []int{0, 0}
	if err := unix.Pipe(resizeWake); err != nil {
		_ = command.Process.Kill()
		_ = terminal.Close()
		_ = command.Wait()
		return nil, err
	}
	return &entry{
		metadata: metadata,
		session: &Session{
			id:              metadata.ID,
			command:         command,
			terminal:        terminal,
			terminalFD:      terminalFD,
			cols:            80,
			rows:            24,
			waitDone:        make(chan struct{}),
			pumpDone:        make(chan struct{}),
			resizeRequests:  make(chan resizeRequest, 1),
			resizeWakeRead:  resizeWake[0],
			resizeWakeWrite: resizeWake[1],
			subscribers:     make(map[uint64]*outputSubscriber),
		},
	}, nil
}

func (m *Manager) registerSession(id string, item *entry) {
	m.mu.Lock()
	item.session.setHistoryLimit(m.settings.TerminalHistoryLimit)
	m.sessions[id] = item
	m.mu.Unlock()
}

// WriteTerminal writes input to the PTY. A Ctrl-C only starts watching the
// linked Codex transcript after the complete input has been written; the
// agent remains running until Codex records that the turn was aborted.
func (m *Manager) WriteTerminal(id string, data []byte) (int, error) {
	m.mu.RLock()
	item, ok := m.sessions[id]
	if !ok {
		m.mu.RUnlock()
		return 0, ErrNotFound
	}
	metadata := item.metadata
	terminal := item.session
	m.mu.RUnlock()

	var target agentInterruptTarget
	if bytes.IndexByte(data, 0x03) >= 0 &&
		metadata.Agent == "codex" && metadata.AgentStatus == "running" &&
		metadata.AgentSessionID != "" && metadata.AgentTranscriptPath != "" {
		target = agentInterruptTarget{
			sessionID: metadata.AgentSessionID, transcriptPath: metadata.AgentTranscriptPath,
		}
		if info, err := os.Stat(target.transcriptPath); err == nil {
			if !info.Mode().IsRegular() {
				target = agentInterruptTarget{}
			} else {
				target.offset = info.Size()
				target.turnID, err = agentlog.CodexTurnIDAt(
					target.transcriptPath, target.offset,
				)
				if err != nil || target.turnID == "" {
					target = agentInterruptTarget{}
				}
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			target = agentInterruptTarget{}
		}
	}

	written, err := terminal.Write(data)
	if err != nil {
		return written, err
	}
	if written != len(data) {
		return written, io.ErrShortWrite
	}
	if target.transcriptPath != "" {
		m.watchAgentInterrupt(id, target)
	}
	return written, nil
}

func (m *Manager) UpdateAgent(id string, update AgentUpdate) (Metadata, error) {
	m.mu.Lock()
	item, ok := m.sessions[id]
	if !ok {
		m.mu.Unlock()
		return Metadata{}, ErrNotFound
	}
	m.cancelAgentInterruptLocked(item)
	m.cancelCodexActivityLocked(item)
	before := item.metadata
	item.metadata.Agent = strings.TrimSpace(update.Agent)
	if item.metadata.Agent != "codex" {
		item.codexTitleHeaderScanned = false
	}
	if resumeAgent := strings.TrimSpace(update.ResumeAgent); resumeAgent != "" {
		item.metadata.ResumeAgent = resumeAgent
	} else if item.metadata.Agent != "" {
		item.metadata.ResumeAgent = item.metadata.Agent
	}
	if sessionID := strings.TrimSpace(update.AgentSessionID); sessionID != "" {
		if sessionID != item.metadata.AgentSessionID {
			item.codexTitleHeaderScanned = false
		}
		if sessionID != item.metadata.AgentSessionID &&
			strings.TrimSpace(update.TranscriptPath) == "" {
			item.metadata.AgentTranscriptPath = ""
		}
		item.metadata.AgentSessionID = sessionID
	}
	if transcriptPath := strings.TrimSpace(update.TranscriptPath); transcriptPath != "" {
		if transcriptPath != item.metadata.AgentTranscriptPath {
			item.codexTitleHeaderScanned = false
		}
		item.metadata.AgentTranscriptPath = transcriptPath
	}
	nextStatus := strings.TrimSpace(update.Status)
	if (item.metadata.AgentStatus == "running" && nextStatus == "waiting") ||
		(item.metadata.AgentStatus != "blocked" && nextStatus == "blocked") {
		item.metadata.NeedsAttention = true
	}
	item.metadata.AgentStatus = nextStatus
	if item.metadata.Agent == "" && nextStatus == "" {
		item.metadata.NeedsAttention = false
	}
	var activityTarget codexActivityTarget
	if item.metadata.Agent == "codex" && item.metadata.AgentStatus == "blocked" &&
		item.metadata.AgentSessionID != "" && item.metadata.AgentTranscriptPath != "" {
		if info, err := os.Stat(item.metadata.AgentTranscriptPath); err == nil && info.Mode().IsRegular() {
			activityTarget = codexActivityTarget{
				sessionID: item.metadata.AgentSessionID, transcriptPath: item.metadata.AgentTranscriptPath,
				offset: info.Size(),
			}
		}
	}
	if title := strings.TrimSpace(update.Title); title != "" {
		item.metadata.AgentTitle = title
	} else if item.metadata.Agent == "" && nextStatus == "" {
		item.metadata.AgentTitle = ""
	}
	if cwd := strings.TrimSpace(update.CWD); cwd != "" {
		item.metadata.CWD = cwd
		item.metadata.RepoRoot = repositoryRoot(cwd)
		item.cwdFromAgent = true
	}
	if m.store != nil {
		if err := m.store.Save(context.Background(), item.metadata); err != nil {
			m.mu.Unlock()
			return Metadata{}, err
		}
	}
	after := item.metadata
	var change *Change
	if before != after {
		nextChange := m.nextChangeLocked(ChangeUpdated, &before, &after)
		change = &nextChange
	}
	m.mu.Unlock()
	if change != nil {
		m.emitChange(*change)
	}
	if activityTarget.transcriptPath != "" {
		m.watchCodexActivity(id, activityTarget)
	}
	return after, nil
}

func (m *Manager) watchAgentInterrupt(id string, target agentInterruptTarget) {
	ctx, cancel := context.WithCancel(context.Background())
	m.mu.Lock()
	item, ok := m.sessions[id]
	if !ok || !matchesAgentInterrupt(item.metadata, target) {
		m.mu.Unlock()
		cancel()
		return
	}
	m.cancelAgentInterruptLocked(item)
	watch := &agentInterruptWatch{target: target, cancel: cancel}
	item.interruptWatch = watch
	m.mu.Unlock()

	go m.awaitCodexAbort(ctx, id, watch)
}

func (m *Manager) awaitCodexAbort(ctx context.Context, id string, watch *agentInterruptWatch) {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		aborted, err := agentlog.CodexTurnAbortedSince(
			watch.target.transcriptPath, watch.target.offset, watch.target.turnID,
		)
		if err == nil && aborted {
			m.completeAgentInterrupt(id, watch)
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (m *Manager) watchCodexActivity(id string, target codexActivityTarget) {
	// PermissionRequest is emitted before Codex shows its approval UI. Keep the
	// hook's blocked state until the rollout records durable progress or a
	// completed turn, so a transient approval request cannot leave it stale.
	ctx, cancel := context.WithCancel(context.Background())
	m.mu.Lock()
	item, ok := m.sessions[id]
	if !ok || !matchesCodexActivity(item.metadata, target) {
		m.mu.Unlock()
		cancel()
		return
	}
	m.cancelCodexActivityLocked(item)
	watch := &codexActivityWatch{target: target, cancel: cancel}
	item.codexActivityWatch = watch
	m.mu.Unlock()

	go m.awaitCodexActivity(ctx, id, watch)
}

func (m *Manager) awaitCodexActivity(ctx context.Context, id string, watch *codexActivityWatch) {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		activity, err := agentlog.CodexActivitySince(
			watch.target.transcriptPath, watch.target.offset,
		)
		if err == nil && activity != "" {
			m.completeCodexActivity(id, watch, activity)
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (m *Manager) completeCodexActivity(id string, watch *codexActivityWatch, activity string) {
	if activity != agentlog.CodexActivityRunning && activity != agentlog.CodexActivityWaiting {
		return
	}
	m.mu.Lock()
	item, ok := m.sessions[id]
	if !ok || item.codexActivityWatch != watch || !matchesCodexActivity(item.metadata, watch.target) {
		m.mu.Unlock()
		return
	}
	before := item.metadata
	item.codexActivityWatch = nil
	item.metadata.AgentStatus = activity
	if m.store != nil {
		if err := m.store.Save(context.Background(), item.metadata); err != nil {
			item.metadata = before
			item.codexActivityWatch = watch
			m.mu.Unlock()
			return
		}
	}
	after := item.metadata
	change := m.nextChangeLocked(ChangeUpdated, &before, &after)
	m.mu.Unlock()
	watch.cancel()
	m.emitChange(change)
}

func (m *Manager) completeAgentInterrupt(id string, watch *agentInterruptWatch) {
	m.mu.Lock()
	item, ok := m.sessions[id]
	if !ok || item.interruptWatch != watch || !matchesAgentInterrupt(item.metadata, watch.target) {
		m.mu.Unlock()
		return
	}
	before := item.metadata
	item.interruptWatch = nil
	item.metadata.AgentStatus = "waiting"
	item.metadata.NeedsAttention = true
	if m.store != nil {
		if err := m.store.Save(context.Background(), item.metadata); err != nil {
			item.metadata = before
			item.interruptWatch = watch
			m.mu.Unlock()
			return
		}
	}
	after := item.metadata
	change := m.nextChangeLocked(ChangeUpdated, &before, &after)
	m.mu.Unlock()
	watch.cancel()
	m.emitChange(change)
}

func matchesAgentInterrupt(metadata Metadata, target agentInterruptTarget) bool {
	return metadata.Agent == "codex" && metadata.AgentStatus == "running" &&
		metadata.AgentSessionID == target.sessionID &&
		metadata.AgentTranscriptPath == target.transcriptPath
}

func (m *Manager) cancelAgentInterruptLocked(item *entry) {
	if item.interruptWatch == nil {
		return
	}
	item.interruptWatch.cancel()
	item.interruptWatch = nil
}

func (m *Manager) cancelCodexActivityLocked(item *entry) {
	if item.codexActivityWatch == nil {
		return
	}
	item.codexActivityWatch.cancel()
	item.codexActivityWatch = nil
}

func matchesCodexActivity(metadata Metadata, target codexActivityTarget) bool {
	return metadata.Agent == "codex" && metadata.AgentStatus == "blocked" &&
		metadata.AgentSessionID == target.sessionID &&
		metadata.AgentTranscriptPath == target.transcriptPath
}

func (m *Manager) AcknowledgeAttention(id string) (Metadata, error) {
	m.mu.Lock()
	item, ok := m.sessions[id]
	if !ok {
		m.mu.Unlock()
		return Metadata{}, ErrNotFound
	}
	if !item.metadata.NeedsAttention {
		metadata := item.metadata
		m.mu.Unlock()
		return metadata, nil
	}
	before := item.metadata
	item.metadata.NeedsAttention = false
	if m.store != nil {
		if err := m.store.Save(context.Background(), item.metadata); err != nil {
			m.mu.Unlock()
			return Metadata{}, err
		}
	}
	after := item.metadata
	change := m.nextChangeLocked(ChangeUpdated, &before, &after)
	m.mu.Unlock()
	m.emitChange(change)
	return after, nil
}

func (m *Manager) UpdateCWD(id, cwd string) (Metadata, error) {
	cwd, err := normalizeReportedCWD(cwd)
	if err != nil {
		return Metadata{}, err
	}
	metadata, err := m.updateCWD(id, cwd, true)
	if err != nil {
		return Metadata{}, err
	}
	m.noteCWDReport(id)
	return metadata, nil
}

func (m *Manager) noteCWDReport(id string) {
	m.mu.Lock()
	if item, ok := m.sessions[id]; ok {
		item.cwdReportedAt = time.Now()
	}
	m.mu.Unlock()
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
	return m.updateCWDNotReportedSince(id, cwd, preserveEquivalentPath, time.Time{})
}

// updateCWDNotReportedSince drops the update when the terminal named its own
// directory after sampledAt. Reading a process directory takes milliseconds, and
// a report that arrives inside that window describes the later moment — so the
// window has to be re-checked here, under the lock, and not only before the
// sample was taken.
func (m *Manager) updateCWDNotReportedSince(
	id, cwd string, preserveEquivalentPath bool, sampledAt time.Time,
) (Metadata, error) {
	m.mu.Lock()
	item, ok := m.sessions[id]
	if !ok {
		m.mu.Unlock()
		return Metadata{}, ErrNotFound
	}
	if !sampledAt.IsZero() && item.cwdReportedAt.After(sampledAt) {
		metadata := item.metadata
		m.mu.Unlock()
		return metadata, nil
	}
	if item.metadata.CWD == cwd {
		metadata := item.metadata
		m.mu.Unlock()
		return metadata, nil
	}
	if preserveEquivalentPath {
		currentInfo, currentErr := os.Stat(item.metadata.CWD)
		nextInfo, nextErr := os.Stat(cwd)
		if currentErr == nil && nextErr == nil && os.SameFile(currentInfo, nextInfo) {
			metadata := item.metadata
			m.mu.Unlock()
			return metadata, nil
		}
	}
	before := item.metadata
	next := item.metadata
	next.CWD = cwd
	next.RepoRoot = repositoryRoot(cwd)
	if m.store != nil {
		if err := m.store.Save(context.Background(), next); err != nil {
			m.mu.Unlock()
			return Metadata{}, err
		}
	}
	item.metadata = next
	change := m.nextChangeLocked(ChangeUpdated, &before, &next)
	m.mu.Unlock()
	m.emitChange(change)
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

	var deleted *Change
	m.mu.Lock()
	if current, ok := m.sessions[item.metadata.ID]; ok && current == item {
		m.cancelAgentInterruptLocked(item)
		m.cancelCodexActivityLocked(item)
		if !m.closing {
			delete(m.sessions, item.metadata.ID)
			if m.store != nil {
				_ = m.store.Delete(context.Background(), item.metadata.ID)
			}
			before := item.metadata
			change := m.nextChangeLocked(ChangeDeleted, &before, nil)
			deleted = &change
		}
	}
	m.mu.Unlock()
	if deleted != nil {
		m.emitChange(*deleted)
	}
	close(item.session.waitDone)
}

func (m *Manager) List() []Metadata {
	if m.refreshMu.TryLock() {
		func() {
			defer m.refreshMu.Unlock()
			m.refreshMetadata()
		}()
	}
	return m.ListCurrent()
}

// RefreshMetadata starts a best-effort metadata refresh without blocking the
// caller. An active synchronous or asynchronous refresh owns the single-flight
// slot, so repeated polling cannot accumulate refresh goroutines.
func (m *Manager) RefreshMetadata() {
	if !m.refreshMu.TryLock() {
		return
	}
	go func() {
		defer m.refreshMu.Unlock()
		m.refreshMetadata()
	}()
}

func (m *Manager) refreshMetadata() {
	m.refreshCodexTitles()
	m.refreshWorkingDirectories()
	m.refreshForegroundProcessNames()
}

// refreshWorkingDirectories re-derives each terminal's working directory from
// its live process. Sampling happens outside the lock: it shells out to lsof on
// macOS, and holding the lock across that would stall every reader.
func (m *Manager) refreshWorkingDirectories() {
	type sample struct {
		id  string
		pid int
	}
	now := time.Now()
	var due []sample
	m.mu.Lock()
	for id, item := range m.sessions {
		if item.metadata.State != StateRunning || item.cwdFromAgent {
			continue
		}
		if !item.cwdSampledAt.IsZero() && now.Sub(item.cwdSampledAt) < m.cwdSampleInterval {
			continue
		}
		if !item.cwdReportedAt.IsZero() && now.Sub(item.cwdReportedAt) < m.cwdSampleInterval {
			continue
		}
		if item.session == nil || item.session.command == nil {
			continue
		}
		process := item.session.command.Process
		if process == nil {
			continue
		}
		item.cwdSampledAt = now
		due = append(due, sample{id: id, pid: process.Pid})
	}
	m.mu.Unlock()

	for _, candidate := range due {
		cwd, err := processWorkingDirectory(candidate.pid)
		if err != nil {
			continue
		}
		cwd, err = normalizeReportedCWD(cwd)
		if err != nil {
			continue
		}
		_, _ = m.updateCWDNotReportedSince(candidate.id, cwd, true, now)
	}
}

func (m *Manager) refreshForegroundProcessNames() {
	type sample struct {
		id      string
		session *Session
	}
	now := time.Now()
	var due []sample
	var changes []Change
	m.mu.Lock()
	for id, item := range m.sessions {
		if item.metadata.State != StateRunning {
			if item.metadata.ProcessName == "" {
				continue
			}
			before := item.metadata
			item.metadata.ProcessName = ""
			after := item.metadata
			changes = append(changes, m.nextChangeLocked(ChangeUpdated, &before, &after))
			continue
		}
		if !item.foregroundProcessSampledAt.IsZero() &&
			now.Sub(item.foregroundProcessSampledAt) < m.foregroundProcessSampleInterval {
			continue
		}
		if item.session == nil {
			continue
		}
		item.foregroundProcessSampledAt = now
		due = append(due, sample{id: id, session: item.session})
	}
	m.mu.Unlock()
	for _, change := range changes {
		m.emitChange(change)
	}
	for _, candidate := range due {
		name, err := candidate.session.ForegroundCommandName()
		if err != nil || name == "" {
			continue
		}
		m.updateForegroundProcessName(candidate.id, name)
	}
}

func (m *Manager) updateForegroundProcessName(id, name string) {
	m.mu.Lock()
	item, ok := m.sessions[id]
	if !ok || item.metadata.State != StateRunning || item.metadata.ProcessName == name {
		m.mu.Unlock()
		return
	}
	before := item.metadata
	item.metadata.ProcessName = name
	after := item.metadata
	change := m.nextChangeLocked(ChangeUpdated, &before, &after)
	m.mu.Unlock()
	m.emitChange(change)
}

// ListCurrent returns the current metadata without running refresh hooks.
// Control reconciliation uses this method so a change handler cannot recursively
// trigger another change while it is serializing event publication.
func (m *Manager) ListCurrent() []Metadata {
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
	titles := make(map[string]string)
	if m.hooks.CodexSessionIndex != "" {
		if loaded, err := loadCodexSessionTitles(m.hooks.CodexSessionIndex); err == nil {
			titles = loaded
		}
	}

	type candidate struct {
		id            string
		sessionID     string
		transcript    string
		headerScanned bool
	}
	m.mu.RLock()
	candidates := make([]candidate, 0, len(m.sessions))
	for id, item := range m.sessions {
		if item.metadata.Agent != "codex" || item.metadata.AgentSessionID == "" {
			continue
		}
		candidates = append(candidates, candidate{
			id:            id,
			sessionID:     item.metadata.AgentSessionID,
			transcript:    item.metadata.AgentTranscriptPath,
			headerScanned: item.codexTitleHeaderScanned,
		})
	}
	m.mu.RUnlock()

	for _, candidate := range candidates {
		title := titles[candidate.sessionID]
		headerScanned := candidate.headerScanned
		if title == "" {
			tailTitle, tailErr := m.resolveCodexTitle(
				candidate.transcript, candidate.sessionID, false,
			)
			title = tailTitle
			if title == "" && !headerScanned {
				headerTitle, headerErr := m.resolveCodexTitle(
					candidate.transcript, candidate.sessionID, true,
				)
				if headerErr == nil {
					headerScanned = true
				}
				title = headerTitle
			} else if tailErr == nil {
				headerScanned = true
			}
		}

		m.mu.Lock()
		item, ok := m.sessions[candidate.id]
		if !ok ||
			item.metadata.Agent != "codex" ||
			item.metadata.AgentSessionID != candidate.sessionID ||
			item.metadata.AgentTranscriptPath != candidate.transcript {
			m.mu.Unlock()
			continue
		}
		item.codexTitleHeaderScanned = headerScanned
		if title == "" || title == item.metadata.AgentTitle {
			m.mu.Unlock()
			continue
		}
		before := item.metadata
		item.metadata.AgentTitle = title
		if m.store != nil {
			_ = m.store.Save(context.Background(), item.metadata)
		}
		after := item.metadata
		change := m.nextChangeLocked(ChangeUpdated, &before, &after)
		m.mu.Unlock()
		m.emitChange(change)
	}
}

func (m *Manager) resolveCodexTitle(path, sessionID string, fromStart bool) (string, error) {
	if m.codexTitleResolver != nil {
		return m.codexTitleResolver(path, sessionID, fromStart)
	}
	if fromStart {
		return agentlog.CodexThreadTitleFromStart(path, sessionID)
	}
	return agentlog.CodexThreadTitle(path, sessionID)
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
	for _, item := range m.sessions {
		item.session.setHistoryLimit(settings.TerminalHistoryLimit)
	}
	return nil
}

func (m *Manager) LoadSelection(ctx context.Context) (selection.State, bool, error) {
	m.mu.RLock()
	store := m.store
	if store == nil {
		state := cloneSelectionState(m.workspaceSelection)
		found := m.hasWorkspaceSelection
		m.mu.RUnlock()
		return state, found, nil
	}
	m.mu.RUnlock()
	return store.LoadSelection(ctx)
}

func (m *Manager) SaveSelection(ctx context.Context, state selection.State) error {
	m.mu.Lock()
	store := m.store
	if store == nil {
		m.workspaceSelection = cloneSelectionState(state)
		m.hasWorkspaceSelection = true
		m.mu.Unlock()
		return nil
	}
	m.mu.Unlock()
	return store.SaveSelection(ctx, state)
}

func cloneSelectionState(state selection.State) selection.State {
	return selection.State{
		ManualTerminalIDs: append([]string{}, state.ManualTerminalIDs...),
		PinnedTerminalIDs: append([]string{}, state.PinnedTerminalIDs...),
		FocusedTerminalID: state.FocusedTerminalID,
		StatusFilters:     append([]string{}, state.StatusFilters...),
		CWDFilters:        append([]selection.CWDFilter{}, state.CWDFilters...),
		Revision:          state.Revision,
	}
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

func (m *Manager) Metadata(id string) (Metadata, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	item, ok := m.sessions[id]
	if !ok {
		return Metadata{}, false
	}
	return item.metadata, true
}

func (m *Manager) Delete(id string) error {
	m.mu.Lock()
	item, ok := m.sessions[id]
	var change Change
	if ok {
		delete(m.sessions, id)
		before := item.metadata
		change = m.nextChangeLocked(ChangeDeleted, &before, nil)
	}
	m.mu.Unlock()
	if !ok {
		return ErrNotFound
	}
	m.mu.Lock()
	m.cancelAgentInterruptLocked(item)
	m.cancelCodexActivityLocked(item)
	m.mu.Unlock()
	if m.store != nil {
		if err := m.store.Delete(context.Background(), id); err != nil {
			m.mu.Lock()
			m.sessions[id] = item
			m.mu.Unlock()
			return err
		}
	}
	item.session.terminate()
	m.emitChange(change)
	return nil
}

func (m *Manager) SetChangeHandler(handler func(Change)) {
	m.mu.Lock()
	m.onChange = handler
	m.mu.Unlock()
}

func (m *Manager) nextChangeLocked(
	kind ChangeKind,
	before, after *Metadata,
) Change {
	m.changeSequence++
	return Change{
		Sequence: m.changeSequence,
		Kind:     kind,
		Before:   before,
		After:    after,
	}
}

func (m *Manager) emitChange(change Change) {
	m.mu.RLock()
	handler := m.onChange
	m.mu.RUnlock()
	if handler != nil {
		handler(change)
	}
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
		m.mu.Lock()
		m.cancelAgentInterruptLocked(item)
		m.cancelCodexActivityLocked(item)
		m.mu.Unlock()
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
