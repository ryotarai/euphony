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
	"unicode/utf8"

	"github.com/creack/pty"
	"github.com/ryotarai/euphony/internal/agentlog"
	"github.com/ryotarai/euphony/internal/selection"
	"golang.org/x/sys/unix"
)

var (
	ErrNotFound             = errors.New("session not found")
	ErrAgentSummaryNotFound = errors.New("agent summary not found")
	ErrManagerClosing       = errors.New("session manager is closing")
)

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
	CustomName          bool       `json:"customName,omitempty"`
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

type AgentSummary struct {
	TerminalID  string    `json:"terminalId"`
	Provider    string    `json:"provider"`
	Status      string    `json:"status"`
	Summary     string    `json:"summary"`
	Action      string    `json:"action,omitempty"`
	Unread      bool      `json:"unread"`
	GeneratedAt time.Time `json:"generatedAt"`
	Error       string    `json:"error,omitempty"`
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
	TerminalLineHeight        float64 `json:"terminalLineHeight"`
	TerminalCursorStyle       string  `json:"terminalCursorStyle"`
	TerminalCursorBlink       bool    `json:"terminalCursorBlink"`
	TerminalScrollSensitivity int     `json:"terminalScrollSensitivity"`
	TerminalOptionAsAlt       bool    `json:"terminalOptionAsAlt"`
	AgentSummaryProvider      string  `json:"agentSummaryProvider"`
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
	DefaultAgentSummaryProvider      = "codex"
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
		TerminalLineHeight:        DefaultTerminalLineHeight,
		TerminalCursorStyle:       DefaultTerminalCursorStyle,
		TerminalCursorBlink:       DefaultTerminalCursorBlink,
		TerminalScrollSensitivity: DefaultTerminalScrollSensitivity,
		TerminalOptionAsAlt:       DefaultTerminalOptionAsAlt,
		AgentSummaryProvider:      DefaultAgentSummaryProvider,
	}
}

type entry struct {
	metadata           Metadata
	session            *Session
	interruptWatch     *agentInterruptWatch
	codexActivityWatch *codexActivityWatch
	// metadataSaveMu keeps a terminal's in-memory mutation, persistence, and
	// rollback as one transaction without holding the manager lock during I/O.
	metadataSaveMu sync.Mutex
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
	claudeTitleSampledAt       time.Time
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

// defaultClaudeTitleSampleInterval bounds how often a Claude transcript is
// re-read for its title. `/rename` fires no hook, so nothing reports it; this
// backstop is what surfaces the new name. Lists happen in tight loops, and each
// sample tails a file that grows to tens of megabytes, so the reads are spaced.
const defaultClaudeTitleSampleInterval = 2 * time.Second

type Manager struct {
	mu                              sync.RWMutex
	refreshMu                       sync.Mutex
	refreshDone                     chan struct{}
	refreshLifecycleDone            chan struct{}
	storeOrderMu                    sync.Mutex
	storeTail                       chan struct{}
	storeSequence                   uint64
	storeSealed                     bool
	changeDeliveryMu                sync.Mutex
	changeCompletions               map[uint64]changeCompletion
	changeDeliverySequence          uint64
	changeDeliveryActive            bool
	agentSummaryMutationMu          sync.Mutex
	shell                           string
	hooks                           HookConfig
	sessions                        map[string]*entry
	store                           metadataStore
	agentSummaries                  map[string]AgentSummary
	closing                         bool
	activeCreates                   int
	createsDone                     chan struct{}
	closeDone                       chan struct{}
	closeResult                     error
	settings                        Settings
	onChange                        func(Change)
	changeSequence                  uint64
	cwdSampleInterval               time.Duration
	claudeTitleSampleInterval       time.Duration
	foregroundProcessSampleInterval time.Duration
	codexTitleResolver              func(string, string, bool) (string, error)
	repositoryRootResolver          func(string) string
	fileStat                        func(string) (os.FileInfo, error)
	beforeStoreOperation            func(uint64)

	workspaceSelection    selection.State
	hasWorkspaceSelection bool
}

type storeOperation struct {
	previous <-chan struct{}
	done     chan struct{}
	sequence uint64
	hook     func(uint64)
	err      error
}

type changeCompletion struct {
	change  Change
	deliver bool
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
	summaries, err := store.LoadAgentSummaries(context.Background())
	if err != nil {
		_ = store.Close()
		return nil, err
	}
	for _, summary := range summaries {
		manager.agentSummaries[summary.TerminalID] = summary
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
		agentSummaries: make(map[string]AgentSummary),
		settings:       DefaultSettings(), cwdSampleInterval: defaultCWDSampleInterval,
		foregroundProcessSampleInterval: defaultForegroundProcessSampleInterval,
		claudeTitleSampleInterval:       defaultClaudeTitleSampleInterval,
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
	if !m.beginCreate() {
		return Metadata{}, ErrManagerClosing
	}
	createLifecycleFinished := false
	defer func() {
		if !createLifecycleFinished {
			m.finishCreate()
		}
	}()
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
		if err := m.saveMetadata(m.store, metadata); err != nil {
			discardStartedSession(item.session)
			return Metadata{}, err
		}
	}
	if !m.registerSession(id, item) {
		if m.store != nil {
			operation := m.reserveStoreOperation()
			cleanupErr := m.runStoreOperation(operation, func() error {
				return m.store.Delete(context.Background(), id)
			})
			if cleanupErr != nil {
				discardStartedSession(item.session)
				return Metadata{}, fmt.Errorf(
					"%w: delete rejected terminal: %v",
					ErrManagerClosing,
					cleanupErr,
				)
			}
		}
		discardStartedSession(item.session)
		return Metadata{}, ErrManagerClosing
	}
	created := item.metadata
	m.mu.Lock()
	change := m.nextChangeLocked(ChangeCreated, nil, &created)
	m.mu.Unlock()

	go m.watch(item)
	m.finishCreate()
	createLifecycleFinished = true
	m.emitChange(change)
	return item.metadata, nil
}

func (m *Manager) beginCreate() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closing {
		return false
	}
	if m.activeCreates == 0 {
		m.createsDone = make(chan struct{})
	}
	m.activeCreates++
	return true
}

func (m *Manager) finishCreate() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.activeCreates--
	if m.activeCreates == 0 {
		close(m.createsDone)
		m.createsDone = nil
	}
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
	if err := m.saveMetadata(m.store, metadata); err != nil {
		discardStartedSession(item.session)
		return err
	}
	if !m.registerSession(metadata.ID, item) {
		discardStartedSession(item.session)
		return ErrManagerClosing
	}
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

func (m *Manager) registerSession(id string, item *entry) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closing {
		return false
	}
	item.session.setHistoryLimit(m.settings.TerminalHistoryLimit)
	m.sessions[id] = item
	return true
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

func (m *Manager) lockMetadataSaveEntry(id string) (*entry, func(), error) {
	m.mu.RLock()
	closing := m.closing
	item := m.sessions[id]
	m.mu.RUnlock()
	if closing {
		return nil, nil, ErrManagerClosing
	}
	if item == nil {
		return nil, nil, ErrNotFound
	}
	item.metadataSaveMu.Lock()
	locked := true
	release := func() {
		if locked {
			item.metadataSaveMu.Unlock()
			locked = false
		}
	}
	return item, release, nil
}

func (m *Manager) UpdateAgent(id string, update AgentUpdate) (Metadata, error) {
	requestedCWD := strings.TrimSpace(update.CWD)
	item, releaseMetadataSave, err := m.lockMetadataSaveEntry(id)
	if err != nil {
		return Metadata{}, err
	}
	defer releaseMetadataSave()
	requestedRepoRoot := ""
	if requestedCWD != "" {
		requestedRepoRoot = m.resolveRepositoryRoot(requestedCWD)
	}

	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return Metadata{}, ErrManagerClosing
	}
	current, ok := m.sessions[id]
	if !ok || current != item {
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
	if title := strings.TrimSpace(update.Title); title != "" {
		item.metadata.AgentTitle = title
	} else if item.metadata.Agent == "" && nextStatus == "" {
		item.metadata.AgentTitle = ""
	}
	if requestedCWD != "" {
		item.metadata.CWD = requestedCWD
		item.metadata.RepoRoot = requestedRepoRoot
		item.cwdFromAgent = true
	}
	after := item.metadata
	var change *Change
	if before != after {
		nextChange := m.nextChangeLocked(ChangeUpdated, &before, &after)
		change = &nextChange
	}
	store := m.store
	var operation storeOperation
	if store != nil {
		operation = m.reserveStoreOperation()
	}
	m.mu.Unlock()
	activityTarget := m.codexActivityTarget(after)
	if store != nil {
		if err := m.runStoreOperation(operation, func() error {
			return store.Save(context.Background(), after)
		}); err != nil {
			releaseMetadataSave()
			if change != nil {
				m.skipChange(*change)
			}
			return Metadata{}, err
		}
	}
	releaseMetadataSave()
	if change != nil {
		m.emitChange(*change)
	}
	if activityTarget.transcriptPath != "" {
		m.watchCodexActivity(id, activityTarget)
	}
	return after, nil
}

func (m *Manager) Rename(id, name string) (Metadata, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return Metadata{}, errors.New("session name is required")
	}
	if utf8.RuneCountInString(name) > 80 {
		return Metadata{}, errors.New("session name must be at most 80 characters")
	}

	item, releaseMetadataSave, err := m.lockMetadataSaveEntry(id)
	if err != nil {
		return Metadata{}, err
	}
	defer releaseMetadataSave()

	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return Metadata{}, ErrManagerClosing
	}
	current, ok := m.sessions[id]
	if !ok || current != item {
		m.mu.Unlock()
		return Metadata{}, ErrNotFound
	}
	before := item.metadata
	item.metadata.Name = name
	item.metadata.CustomName = true
	after := item.metadata
	var change *Change
	if before != after {
		nextChange := m.nextChangeLocked(ChangeUpdated, &before, &after)
		change = &nextChange
	}
	store := m.store
	var operation storeOperation
	if store != nil {
		operation = m.reserveStoreOperation()
	}
	m.mu.Unlock()
	if store != nil {
		if err := m.runStoreOperation(operation, func() error {
			return store.Save(context.Background(), after)
		}); err != nil {
			m.mu.Lock()
			if current, exists := m.sessions[id]; exists &&
				current == item && current.metadata.Name == after.Name &&
				current.metadata.CustomName == after.CustomName {
				item.metadata.Name = before.Name
				item.metadata.CustomName = before.CustomName
			}
			m.mu.Unlock()
			releaseMetadataSave()
			if change != nil {
				m.skipChange(*change)
			}
			return Metadata{}, err
		}
	}
	releaseMetadataSave()
	if change != nil {
		m.emitChange(*change)
	}
	return after, nil
}

func (m *Manager) codexActivityTarget(metadata Metadata) codexActivityTarget {
	if metadata.Agent != "codex" ||
		metadata.AgentStatus != "blocked" ||
		metadata.AgentSessionID == "" ||
		metadata.AgentTranscriptPath == "" {
		return codexActivityTarget{}
	}
	info, err := m.statFile(metadata.AgentTranscriptPath)
	if err != nil || !info.Mode().IsRegular() {
		return codexActivityTarget{}
	}
	return codexActivityTarget{
		sessionID:      metadata.AgentSessionID,
		transcriptPath: metadata.AgentTranscriptPath,
		offset:         info.Size(),
	}
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
	if m.closing || !ok || !matchesCodexActivity(item.metadata, target) {
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
	item, releaseMetadataSave, err := m.lockMetadataSaveEntry(id)
	if err != nil {
		return
	}
	defer releaseMetadataSave()
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return
	}
	current, ok := m.sessions[id]
	if !ok || current != item ||
		item.codexActivityWatch != watch ||
		!matchesCodexActivity(item.metadata, watch.target) {
		m.mu.Unlock()
		return
	}
	before := item.metadata
	item.codexActivityWatch = nil
	item.metadata.AgentStatus = activity
	after := item.metadata
	change := m.nextChangeLocked(ChangeUpdated, &before, &after)
	store := m.store
	var operation storeOperation
	if store != nil {
		operation = m.reserveStoreOperation()
	}
	m.mu.Unlock()
	if store != nil {
		if err := m.runStoreOperation(operation, func() error {
			return store.Save(context.Background(), after)
		}); err != nil {
			m.mu.Lock()
			if current, exists := m.sessions[id]; exists &&
				current == item && current.metadata == after {
				item.metadata = before
				item.codexActivityWatch = watch
			}
			m.mu.Unlock()
			releaseMetadataSave()
			m.skipChange(change)
			return
		}
	}
	watch.cancel()
	releaseMetadataSave()
	m.emitChange(change)
}

func (m *Manager) completeAgentInterrupt(id string, watch *agentInterruptWatch) {
	item, releaseMetadataSave, err := m.lockMetadataSaveEntry(id)
	if err != nil {
		return
	}
	defer releaseMetadataSave()
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return
	}
	current, ok := m.sessions[id]
	if !ok || current != item ||
		item.interruptWatch != watch ||
		!matchesAgentInterrupt(item.metadata, watch.target) {
		m.mu.Unlock()
		return
	}
	before := item.metadata
	item.interruptWatch = nil
	item.metadata.AgentStatus = "waiting"
	item.metadata.NeedsAttention = true
	after := item.metadata
	change := m.nextChangeLocked(ChangeUpdated, &before, &after)
	store := m.store
	var operation storeOperation
	if store != nil {
		operation = m.reserveStoreOperation()
	}
	m.mu.Unlock()
	if store != nil {
		if err := m.runStoreOperation(operation, func() error {
			return store.Save(context.Background(), after)
		}); err != nil {
			m.mu.Lock()
			if current, exists := m.sessions[id]; exists &&
				current == item && current.metadata == after {
				item.metadata = before
				item.interruptWatch = watch
			}
			m.mu.Unlock()
			releaseMetadataSave()
			m.skipChange(change)
			return
		}
	}
	watch.cancel()
	releaseMetadataSave()
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
	item, releaseMetadataSave, err := m.lockMetadataSaveEntry(id)
	if err != nil {
		return Metadata{}, err
	}
	defer releaseMetadataSave()
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return Metadata{}, ErrManagerClosing
	}
	current, ok := m.sessions[id]
	if !ok || current != item {
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
	after := item.metadata
	change := m.nextChangeLocked(ChangeUpdated, &before, &after)
	store := m.store
	var operation storeOperation
	if store != nil {
		operation = m.reserveStoreOperation()
	}
	m.mu.Unlock()
	if store != nil {
		if err := m.runStoreOperation(operation, func() error {
			return store.Save(context.Background(), after)
		}); err != nil {
			releaseMetadataSave()
			m.skipChange(change)
			return Metadata{}, err
		}
	}
	releaseMetadataSave()
	m.emitChange(change)
	return after, nil
}

func (m *Manager) UpdateCWD(id, cwd string) (Metadata, error) {
	cwd, err := normalizeReportedCWD(cwd)
	if err != nil {
		return Metadata{}, err
	}
	return m.updateCWDNotReportedSince(
		id, cwd, true, time.Time{}, time.Now(),
	)
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
	return m.updateCWDNotReportedSince(
		id, cwd, preserveEquivalentPath, time.Time{}, time.Time{},
	)
}

// updateCWDNotReportedSince drops the update when the terminal named its own
// directory after sampledAt. Reading a process directory takes milliseconds, and
// a report that arrives inside that window describes the later moment — so the
// window has to be re-checked here, under the lock, and not only before the
// sample was taken.
func (m *Manager) updateCWDNotReportedSince(
	id, cwd string,
	preserveEquivalentPath bool,
	sampledAt, reportedAt time.Time,
) (Metadata, error) {
	metadata, change, err := m.updateCWDNotReportedSinceDeferred(
		id, cwd, preserveEquivalentPath, sampledAt, reportedAt,
	)
	if change != nil {
		m.emitChange(*change)
	}
	return metadata, err
}

func (m *Manager) updateCWDNotReportedSinceDeferred(
	id, cwd string,
	preserveEquivalentPath bool,
	sampledAt, reportedAt time.Time,
) (Metadata, *Change, error) {
	item, releaseMetadataSave, err := m.lockMetadataSaveEntry(id)
	if err != nil {
		return Metadata{}, nil, err
	}
	defer releaseMetadataSave()

	for {
		m.mu.Lock()
		current, ok := m.sessions[id]
		if !ok || current != item {
			m.mu.Unlock()
			return Metadata{}, nil, ErrNotFound
		}
		if m.closing {
			m.mu.Unlock()
			return Metadata{}, nil, ErrManagerClosing
		}
		if !sampledAt.IsZero() && item.cwdReportedAt.After(sampledAt) {
			metadata := item.metadata
			m.mu.Unlock()
			return metadata, nil, nil
		}
		if item.metadata.CWD == cwd {
			if !reportedAt.IsZero() {
				item.cwdReportedAt = reportedAt
			}
			metadata := item.metadata
			m.mu.Unlock()
			return metadata, nil, nil
		}
		baseCWD := item.metadata.CWD
		m.mu.Unlock()

		equivalent := false
		if preserveEquivalentPath {
			currentInfo, currentErr := m.statFile(baseCWD)
			nextInfo, nextErr := m.statFile(cwd)
			equivalent = currentErr == nil &&
				nextErr == nil &&
				os.SameFile(currentInfo, nextInfo)
		}
		repoRoot := ""
		if !equivalent {
			repoRoot = m.resolveRepositoryRoot(cwd)
		}

		m.mu.Lock()
		current, ok = m.sessions[id]
		if !ok || current != item {
			m.mu.Unlock()
			return Metadata{}, nil, ErrNotFound
		}
		if m.closing {
			m.mu.Unlock()
			return Metadata{}, nil, ErrManagerClosing
		}
		if !sampledAt.IsZero() && item.cwdReportedAt.After(sampledAt) {
			metadata := item.metadata
			m.mu.Unlock()
			return metadata, nil, nil
		}
		if item.metadata.CWD != baseCWD {
			m.mu.Unlock()
			continue
		}
		if equivalent {
			if !reportedAt.IsZero() {
				item.cwdReportedAt = reportedAt
			}
			metadata := item.metadata
			m.mu.Unlock()
			return metadata, nil, nil
		}

		before := item.metadata
		beforeReportedAt := item.cwdReportedAt
		next := item.metadata
		next.CWD = cwd
		next.RepoRoot = repoRoot
		item.metadata = next
		if !reportedAt.IsZero() {
			item.cwdReportedAt = reportedAt
		}
		change := m.nextChangeLocked(ChangeUpdated, &before, &next)
		store := m.store
		var operation storeOperation
		if store != nil {
			operation = m.reserveStoreOperation()
		}
		m.mu.Unlock()
		if store != nil {
			if err := m.runStoreOperation(operation, func() error {
				return store.Save(context.Background(), next)
			}); err != nil {
				m.mu.Lock()
				if current, exists := m.sessions[id]; exists &&
					current == item &&
					current.metadata.CWD == next.CWD &&
					current.metadata.RepoRoot == next.RepoRoot &&
					(reportedAt.IsZero() || current.cwdReportedAt == reportedAt) {
					item.metadata.CWD = before.CWD
					item.metadata.RepoRoot = before.RepoRoot
					if !reportedAt.IsZero() {
						item.cwdReportedAt = beforeReportedAt
					}
				}
				m.mu.Unlock()
				releaseMetadataSave()
				m.skipChange(change)
				return Metadata{}, nil, err
			}
		}
		return next, &change, nil
	}
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

func (m *Manager) resolveRepositoryRoot(cwd string) string {
	if m.repositoryRootResolver != nil {
		return m.repositoryRootResolver(cwd)
	}
	return repositoryRoot(cwd)
}

func (m *Manager) statFile(path string) (os.FileInfo, error) {
	if m.fileStat != nil {
		return m.fileStat(path)
	}
	return os.Stat(path)
}

func (m *Manager) watch(item *entry) {
	_ = item.session.command.Wait()

	var deleted *Change
	var deleteOperation storeOperation
	var store metadataStore
	m.mu.Lock()
	if current, ok := m.sessions[item.metadata.ID]; ok && current == item {
		m.cancelAgentInterruptLocked(item)
		m.cancelCodexActivityLocked(item)
		if !m.closing {
			delete(m.sessions, item.metadata.ID)
			store = m.store
			if store != nil {
				deleteOperation = m.reserveStoreOperation()
			}
			before := item.metadata
			change := m.nextChangeLocked(ChangeDeleted, &before, nil)
			deleted = &change
		}
	}
	m.mu.Unlock()
	if store != nil {
		_ = m.runStoreOperation(deleteOperation, func() error {
			return store.Delete(context.Background(), item.metadata.ID)
		})
	}
	if deleted != nil {
		m.emitChange(*deleted)
	}
	close(item.session.waitDone)
}

func (m *Manager) List() []Metadata {
	done, started := m.beginMetadataRefresh()
	var changes []Change
	if started {
		changes = m.refreshMetadata()
		m.finishMetadataRefresh(done, changes)
	} else if done != nil {
		<-done
	}
	return m.ListCurrent()
}

// RefreshMetadata starts a best-effort metadata refresh without blocking the
// caller. An active synchronous or asynchronous refresh owns the single-flight
// slot, so repeated polling cannot accumulate refresh goroutines.
func (m *Manager) RefreshMetadata() {
	done, started := m.beginMetadataRefresh()
	if !started {
		return
	}
	go func() {
		changes := m.refreshMetadata()
		m.finishMetadataRefresh(done, changes)
	}()
}

func (m *Manager) beginMetadataRefresh() (chan struct{}, bool) {
	m.refreshMu.Lock()
	defer m.refreshMu.Unlock()
	m.mu.RLock()
	closing := m.closing
	m.mu.RUnlock()
	if closing {
		return nil, false
	}
	if m.refreshDone != nil {
		return m.refreshDone, false
	}
	done := make(chan struct{})
	m.refreshDone = done
	m.refreshLifecycleDone = make(chan struct{})
	return done, true
}

func (m *Manager) finishMetadataRefresh(done chan struct{}, changes []Change) {
	m.refreshMu.Lock()
	if m.refreshDone != done {
		m.refreshMu.Unlock()
		return
	}
	close(done)
	lifecycleDone := m.refreshLifecycleDone
	m.refreshLifecycleDone = nil
	close(lifecycleDone)
	m.refreshMu.Unlock()

	m.emitRefreshChanges(changes)

	m.refreshMu.Lock()
	if m.refreshDone == done {
		m.refreshDone = nil
	}
	m.refreshMu.Unlock()
}

func (m *Manager) refreshMetadata() []Change {
	var changes []Change
	changes = append(changes, m.refreshCodexTitles()...)
	changes = append(changes, m.refreshClaudeTitles()...)
	changes = append(changes, m.refreshWorkingDirectories()...)
	changes = append(changes, m.refreshForegroundProcessNames()...)
	return changes
}

// refreshWorkingDirectories re-derives each terminal's working directory from
// its live process. Sampling happens outside the lock: it shells out to lsof on
// macOS, and holding the lock across that would stall every reader.
func (m *Manager) refreshWorkingDirectories() []Change {
	type sample struct {
		id  string
		pid int
	}
	now := time.Now()
	var due []sample
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return nil
	}
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

	var changes []Change
	for _, candidate := range due {
		cwd, err := processWorkingDirectory(candidate.pid)
		if err != nil {
			continue
		}
		cwd, err = normalizeReportedCWD(cwd)
		if err != nil {
			continue
		}
		_, change, _ := m.updateCWDNotReportedSinceDeferred(
			candidate.id, cwd, true, now, time.Time{},
		)
		if change != nil {
			changes = append(changes, *change)
		}
	}
	return changes
}

func (m *Manager) refreshForegroundProcessNames() []Change {
	type sample struct {
		id      string
		session *Session
	}
	now := time.Now()
	var due []sample
	var changes []Change
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return nil
	}
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
	for _, candidate := range due {
		name, err := candidate.session.ForegroundCommandName()
		if err != nil || name == "" {
			continue
		}
		if change := m.updateForegroundProcessName(candidate.id, name); change != nil {
			changes = append(changes, *change)
		}
	}
	return changes
}

func (m *Manager) updateForegroundProcessName(id, name string) *Change {
	m.mu.Lock()
	item, ok := m.sessions[id]
	if m.closing || !ok || item.metadata.State != StateRunning || item.metadata.ProcessName == name {
		m.mu.Unlock()
		return nil
	}
	before := item.metadata
	item.metadata.ProcessName = name
	after := item.metadata
	change := m.nextChangeLocked(ChangeUpdated, &before, &after)
	m.mu.Unlock()
	return &change
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

func (m *Manager) refreshCodexTitles() []Change {
	titles := make(map[string]string)
	if m.hooks.CodexSessionIndex != "" {
		if loaded, err := loadCodexSessionTitles(m.hooks.CodexSessionIndex); err == nil {
			titles = loaded
		}
	}

	type candidate struct {
		id            string
		entry         *entry
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
			entry:         item,
			sessionID:     item.metadata.AgentSessionID,
			transcript:    item.metadata.AgentTranscriptPath,
			headerScanned: item.codexTitleHeaderScanned,
		})
	}
	m.mu.RUnlock()

	var changes []Change
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

		lockedItem, releaseMetadataSave, err := m.lockMetadataSaveEntry(candidate.id)
		if err != nil {
			continue
		}
		if lockedItem != candidate.entry {
			releaseMetadataSave()
			continue
		}
		m.mu.Lock()
		item, ok := m.sessions[candidate.id]
		if m.closing ||
			!ok ||
			item != candidate.entry ||
			item.metadata.Agent != "codex" ||
			item.metadata.AgentSessionID != candidate.sessionID ||
			item.metadata.AgentTranscriptPath != candidate.transcript {
			m.mu.Unlock()
			releaseMetadataSave()
			continue
		}
		item.codexTitleHeaderScanned = headerScanned
		if title == "" || title == item.metadata.AgentTitle {
			m.mu.Unlock()
			releaseMetadataSave()
			continue
		}
		before := item.metadata
		item.metadata.AgentTitle = title
		after := item.metadata
		change := m.nextChangeLocked(ChangeUpdated, &before, &after)
		store := m.store
		var operation storeOperation
		if store != nil {
			operation = m.reserveStoreOperation()
		}
		m.mu.Unlock()
		if store != nil {
			_ = m.runStoreOperation(operation, func() error {
				return store.Save(context.Background(), after)
			})
		}
		releaseMetadataSave()
		m.mu.RLock()
		closing := m.closing
		m.mu.RUnlock()
		if closing {
			m.skipChange(change)
			continue
		}
		changes = append(changes, change)
	}
	return changes
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

// refreshClaudeTitles re-derives each Claude terminal's title from the
// transcript the hooks pointed at. A `/rename` is recorded there without firing
// any hook, so a title that only ever arrives by report stays stale — sometimes
// forever, when the session was renamed before Claude Code guessed a title of
// its own. Reads happen outside the lock: each one tails a file that grows to
// tens of megabytes, and holding the lock across that would stall every reader.
func (m *Manager) refreshClaudeTitles() []Change {
	type sample struct {
		id             string
		entry          *entry
		transcriptPath string
	}
	now := time.Now()
	var due []sample
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return nil
	}
	for id, item := range m.sessions {
		if item.metadata.Agent != "claude" || item.metadata.AgentTranscriptPath == "" {
			continue
		}
		if !item.claudeTitleSampledAt.IsZero() &&
			now.Sub(item.claudeTitleSampledAt) < m.claudeTitleSampleInterval {
			continue
		}
		item.claudeTitleSampledAt = now
		due = append(due, sample{
			id: id, entry: item, transcriptPath: item.metadata.AgentTranscriptPath,
		})
	}
	m.mu.Unlock()

	var changes []Change
	for _, candidate := range due {
		title := agentlog.ClaudeTranscriptTitle(candidate.transcriptPath)
		if title == "" {
			continue
		}
		lockedItem, releaseMetadataSave, err := m.lockMetadataSaveEntry(candidate.id)
		if err != nil {
			continue
		}
		if lockedItem != candidate.entry {
			releaseMetadataSave()
			continue
		}
		m.mu.Lock()
		item, ok := m.sessions[candidate.id]
		if m.closing ||
			!ok ||
			item != candidate.entry ||
			item.metadata.Agent != "claude" ||
			item.metadata.AgentTranscriptPath != candidate.transcriptPath ||
			title == item.metadata.AgentTitle {
			m.mu.Unlock()
			releaseMetadataSave()
			continue
		}
		before := item.metadata
		item.metadata.AgentTitle = title
		after := item.metadata
		change := m.nextChangeLocked(ChangeUpdated, &before, &after)
		store := m.store
		var operation storeOperation
		if store != nil {
			operation = m.reserveStoreOperation()
		}
		m.mu.Unlock()
		if store != nil {
			_ = m.runStoreOperation(operation, func() error {
				return store.Save(context.Background(), after)
			})
		}
		releaseMetadataSave()
		m.mu.RLock()
		closing := m.closing
		m.mu.RUnlock()
		if closing {
			m.skipChange(change)
			continue
		}
		changes = append(changes, change)
	}
	return changes
}
func (m *Manager) Settings() Settings {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.settings
}

func (m *Manager) UpdateSettings(ctx context.Context, settings Settings) error {
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return ErrManagerClosing
	}
	before := m.settings
	m.settings = settings
	for _, item := range m.sessions {
		item.session.setHistoryLimit(settings.TerminalHistoryLimit)
	}
	store := m.store
	var operation storeOperation
	if store != nil {
		operation = m.reserveStoreOperation()
	}
	m.mu.Unlock()
	if store != nil {
		if err := m.runStoreOperation(operation, func() error {
			return store.SaveSettings(ctx, settings)
		}); err != nil {
			m.mu.Lock()
			if m.settings == settings {
				m.settings = before
				for _, item := range m.sessions {
					item.session.setHistoryLimit(before.TerminalHistoryLimit)
				}
			}
			m.mu.Unlock()
			return err
		}
	}
	return nil
}

func (m *Manager) AgentSummaries() []AgentSummary {
	m.mu.RLock()
	result := make([]AgentSummary, 0, len(m.agentSummaries))
	for _, summary := range m.agentSummaries {
		result = append(result, summary)
	}
	m.mu.RUnlock()
	sort.Slice(result, func(i, j int) bool {
		if result[i].GeneratedAt.Equal(result[j].GeneratedAt) {
			return result[i].TerminalID < result[j].TerminalID
		}
		return result[i].GeneratedAt.Before(result[j].GeneratedAt)
	})
	return result
}

func (m *Manager) SaveAgentSummary(ctx context.Context, summary AgentSummary) error {
	if strings.TrimSpace(summary.TerminalID) == "" {
		return errors.New("agent summary terminal ID is required")
	}
	m.agentSummaryMutationMu.Lock()
	defer m.agentSummaryMutationMu.Unlock()
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return ErrManagerClosing
	}
	previous, hadPrevious := m.agentSummaries[summary.TerminalID]
	if !hadPrevious || strings.TrimSpace(previous.Action) != strings.TrimSpace(summary.Action) {
		summary.Unread = true
	} else {
		summary.Unread = previous.Unread
	}
	store := m.store
	summaryStore, _ := store.(agentSummaryStore)
	var operation storeOperation
	if summaryStore != nil {
		operation = m.reserveStoreOperation()
	}
	m.mu.Unlock()
	if summaryStore == nil {
		m.mu.Lock()
		m.agentSummaries[summary.TerminalID] = summary
		m.mu.Unlock()
		return nil
	}
	if err := m.runStoreOperation(operation, func() error {
		return summaryStore.SaveAgentSummary(ctx, summary)
	}); err != nil {
		return err
	}
	m.mu.Lock()
	m.agentSummaries[summary.TerminalID] = summary
	m.mu.Unlock()
	return nil
}

func (m *Manager) MarkAgentSummaryRead(ctx context.Context, terminalID string) (AgentSummary, error) {
	m.agentSummaryMutationMu.Lock()
	defer m.agentSummaryMutationMu.Unlock()
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return AgentSummary{}, ErrManagerClosing
	}
	previous, ok := m.agentSummaries[terminalID]
	if !ok {
		m.mu.Unlock()
		return AgentSummary{}, ErrAgentSummaryNotFound
	}
	if !previous.Unread {
		m.mu.Unlock()
		return previous, nil
	}
	next := previous
	next.Unread = false
	store := m.store
	summaryStore, _ := store.(agentSummaryStore)
	var operation storeOperation
	if summaryStore != nil {
		operation = m.reserveStoreOperation()
	}
	m.mu.Unlock()
	if summaryStore == nil {
		m.mu.Lock()
		m.agentSummaries[terminalID] = next
		m.mu.Unlock()
		return next, nil
	}
	if err := m.runStoreOperation(operation, func() error {
		return summaryStore.MarkAgentSummaryRead(ctx, terminalID)
	}); err != nil {
		return AgentSummary{}, err
	}
	m.mu.Lock()
	m.agentSummaries[terminalID] = next
	m.mu.Unlock()
	return next, nil
}

func (m *Manager) DeleteAgentSummary(ctx context.Context, terminalID string) error {
	m.agentSummaryMutationMu.Lock()
	defer m.agentSummaryMutationMu.Unlock()
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return ErrManagerClosing
	}
	store := m.store
	summaryStore, _ := store.(agentSummaryStore)
	var operation storeOperation
	if summaryStore != nil {
		operation = m.reserveStoreOperation()
	}
	m.mu.Unlock()
	if summaryStore == nil {
		m.mu.Lock()
		delete(m.agentSummaries, terminalID)
		m.mu.Unlock()
		return nil
	}
	if err := m.runStoreOperation(operation, func() error {
		return summaryStore.DeleteAgentSummary(ctx, terminalID)
	}); err != nil {
		return err
	}
	m.mu.Lock()
	delete(m.agentSummaries, terminalID)
	m.mu.Unlock()
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
	if m.closing {
		m.mu.Unlock()
		return ErrManagerClosing
	}
	store := m.store
	if store == nil {
		m.workspaceSelection = cloneSelectionState(state)
		m.hasWorkspaceSelection = true
		m.mu.Unlock()
		return nil
	}
	operation := m.reserveStoreOperation()
	m.mu.Unlock()
	return m.runStoreOperation(operation, func() error {
		return store.SaveSelection(ctx, state)
	})
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
	if m.closing {
		m.mu.Unlock()
		return ErrManagerClosing
	}
	item, ok := m.sessions[id]
	var change Change
	store := m.store
	var operation storeOperation
	if ok {
		delete(m.sessions, id)
		before := item.metadata
		change = m.nextChangeLocked(ChangeDeleted, &before, nil)
		if store != nil {
			operation = m.reserveStoreOperation()
		}
	}
	m.mu.Unlock()
	if !ok {
		return ErrNotFound
	}
	m.mu.Lock()
	m.cancelAgentInterruptLocked(item)
	m.cancelCodexActivityLocked(item)
	m.mu.Unlock()
	if store != nil {
		if err := m.runStoreOperation(operation, func() error {
			persistErr := store.Delete(context.Background(), id)
			return m.completeDelete(item, id, persistErr)
		}); err != nil {
			m.skipChange(change)
			return err
		}
	} else {
		_ = m.completeDelete(item, id, nil)
	}
	m.emitChange(change)
	return nil
}

func (m *Manager) completeDelete(item *entry, id string, persistErr error) error {
	if persistErr != nil {
		restored := false
		m.mu.Lock()
		if !m.closing {
			if _, exists := m.sessions[id]; !exists {
				m.sessions[id] = item
				restored = true
			}
		}
		m.mu.Unlock()
		if restored {
			return persistErr
		}
	}
	item.session.terminate()
	<-item.session.waitDone
	return persistErr
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
	m.completeChange(change, true)
}

func (m *Manager) skipChange(change Change) {
	m.completeChange(change, false)
}

// completeChange lets concurrent mutations finish independently while keeping
// externally observed changes in their assigned order. A completed skip closes
// a failed mutation's sequence gap. Only one caller drains at a time, but it
// never holds the delivery mutex while invoking user code, so handlers may
// safely re-enter the manager.
func (m *Manager) completeChange(change Change, deliver bool) {
	m.changeDeliveryMu.Lock()
	if change.Sequence <= m.changeDeliverySequence {
		m.changeDeliveryMu.Unlock()
		return
	}
	if m.changeCompletions == nil {
		m.changeCompletions = make(map[uint64]changeCompletion)
	}
	m.changeCompletions[change.Sequence] = changeCompletion{
		change:  change,
		deliver: deliver,
	}
	if m.changeDeliveryActive {
		m.changeDeliveryMu.Unlock()
		return
	}
	m.changeDeliveryActive = true
	var handlerPanic any
	for {
		next := m.changeDeliverySequence + 1
		completion, ok := m.changeCompletions[next]
		if !ok {
			m.changeDeliveryActive = false
			m.changeDeliveryMu.Unlock()
			if handlerPanic != nil {
				panic(handlerPanic)
			}
			return
		}
		delete(m.changeCompletions, next)
		m.changeDeliverySequence = next
		m.changeDeliveryMu.Unlock()

		if completion.deliver {
			m.mu.RLock()
			handler := m.onChange
			m.mu.RUnlock()
			if handler != nil {
				if recovered := invokeChangeHandler(handler, completion.change); recovered != nil &&
					handlerPanic == nil {
					handlerPanic = recovered
				}
			}
		}

		m.changeDeliveryMu.Lock()
	}
}

func invokeChangeHandler(handler func(Change), change Change) (recovered any) {
	defer func() {
		recovered = recover()
	}()
	handler(change)
	return nil
}

func (m *Manager) emitRefreshChanges(changes []Change) {
	for index, change := range changes {
		m.mu.RLock()
		closing := m.closing
		m.mu.RUnlock()
		if closing {
			for _, skipped := range changes[index:] {
				m.skipChange(skipped)
			}
			return
		}
		m.emitChange(change)
	}
}

func (m *Manager) saveMetadata(store metadataStore, metadata Metadata) error {
	operation := m.reserveStoreOperation()
	return m.runStoreOperation(operation, func() error {
		return store.Save(context.Background(), metadata)
	})
}

func (m *Manager) reserveStoreOperation() storeOperation {
	m.storeOrderMu.Lock()
	defer m.storeOrderMu.Unlock()
	if m.storeSealed {
		return storeOperation{err: ErrManagerClosing}
	}
	return m.reserveStoreOperationLocked()
}

func (m *Manager) reserveStoreOperationLocked() storeOperation {
	m.storeSequence++
	done := make(chan struct{})
	operation := storeOperation{
		previous: m.storeTail,
		done:     done,
		sequence: m.storeSequence,
		hook:     m.beforeStoreOperation,
	}
	m.storeTail = done
	return operation
}

func (m *Manager) runStoreOperation(operation storeOperation, persist func() error) error {
	if operation.err != nil {
		return operation.err
	}
	defer close(operation.done)
	if operation.hook != nil {
		operation.hook(operation.sequence)
	}
	if operation.previous != nil {
		<-operation.previous
	}
	return persist()
}

func (m *Manager) Close(ctx context.Context) error {
	m.refreshMu.Lock()
	m.mu.Lock()
	if m.closeDone != nil {
		done := m.closeDone
		m.mu.Unlock()
		m.refreshMu.Unlock()
		return m.waitForClose(ctx, done)
	}
	m.closing = true
	m.closeDone = make(chan struct{})
	done := m.closeDone
	createsDone := m.createsDone
	refreshDone := m.refreshLifecycleDone
	store := m.store
	m.mu.Unlock()
	m.refreshMu.Unlock()

	go m.finishClose(createsDone, refreshDone, store, done)
	return m.waitForClose(ctx, done)
}

func (m *Manager) finishClose(
	createsDone <-chan struct{},
	refreshDone <-chan struct{},
	store metadataStore,
	done chan struct{},
) {
	if createsDone != nil {
		<-createsDone
	}

	m.mu.Lock()
	m.storeOrderMu.Lock()
	var closeOperation storeOperation
	if store != nil {
		closeOperation = m.reserveStoreOperationLocked()
	}
	m.storeSealed = true
	m.storeOrderMu.Unlock()
	items := make([]*entry, 0, len(m.sessions))
	for _, item := range m.sessions {
		items = append(items, item)
	}
	m.mu.Unlock()

	if refreshDone != nil {
		<-refreshDone
	}

	for _, item := range items {
		m.mu.Lock()
		m.cancelAgentInterruptLocked(item)
		m.cancelCodexActivityLocked(item)
		m.mu.Unlock()
		item.session.terminate()
	}
	for _, item := range items {
		<-item.session.waitDone
	}
	var result error
	if store != nil {
		result = m.runStoreOperation(closeOperation, store.Close)
	}
	m.mu.Lock()
	m.closeResult = result
	close(done)
	m.mu.Unlock()
}

func (m *Manager) waitForClose(ctx context.Context, done <-chan struct{}) error {
	select {
	case <-done:
		m.mu.RLock()
		result := m.closeResult
		m.mu.RUnlock()
		return result
	case <-ctx.Done():
		return ctx.Err()
	}
}

func randomID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(value[:]), nil
}
