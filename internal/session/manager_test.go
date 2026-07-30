package session

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCreateRejectsBlankName(t *testing.T) {
	t.Parallel()

	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	if _, err := manager.Create(context.Background(), "   "); err == nil {
		t.Fatal("Create() error = nil, want validation error")
	}
}

func TestSessionExitRemovesTerminalFromManager(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	metadata, err := manager.Create(context.Background(), "Agent")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	running, ok := manager.Get(metadata.ID)
	if !ok {
		t.Fatalf("Get(%q) ok = false", metadata.ID)
	}

	_, outputStream, unsubscribe := running.Subscribe()
	defer unsubscribe()
	if _, err := running.Write([]byte("printf 'euphony-ready\\n'\n")); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	output := receiveUntilCount(t, outputStream, "euphony-ready", 2, 3*time.Second)
	if !strings.Contains(output, "euphony-ready") {
		t.Fatalf("PTY output = %q, want command output", output)
	}
	if _, err := running.Write([]byte("exit 7\n")); err != nil {
		t.Fatalf("Write(exit) error = %v", err)
	}

	waitFor(t, 3*time.Second, func() bool {
		return len(manager.List()) == 0
	})
}

func TestSessionsHaveUniqueIDsAndCreationOrder(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	first, err := manager.Create(context.Background(), "First")
	if err != nil {
		t.Fatalf("Create(first) error = %v", err)
	}
	second, err := manager.Create(context.Background(), "Second")
	if err != nil {
		t.Fatalf("Create(second) error = %v", err)
	}

	if first.ID == second.ID {
		t.Fatalf("session IDs are both %q", first.ID)
	}
	list := manager.List()
	if len(list) != 2 || list[0].ID != first.ID || list[1].ID != second.ID {
		t.Fatalf("List() = %#v, want creation order", list)
	}
}

func TestCreateRecordsCWDAndExposesTerminalHookEnvironment(t *testing.T) {
	manager := NewManager("/bin/sh", HookConfig{
		URL:   "http://127.0.0.1:8080/api/hooks/terminal",
		Token: "secret",
	})
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	metadata, err := manager.Create(context.Background(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	wantCWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd() error = %v", err)
	}
	if metadata.CWD != wantCWD {
		t.Fatalf("CWD = %q, want %q", metadata.CWD, wantCWD)
	}

	running, _ := manager.Get(metadata.ID)
	_, output, unsubscribe := running.Subscribe()
	defer unsubscribe()
	if _, err := running.Write([]byte("printf '%s|%s|%s\\n' \"$EUPHONY_TERMINAL_ID\" \"$EUPHONY_HOOK_URL\" \"$EUPHONY_TOKEN\"\n")); err != nil {
		t.Fatalf("Write(environment) error = %v", err)
	}
	result := receiveUntil(t, output, "secret", 3*time.Second)
	want := metadata.ID + "|http://127.0.0.1:8080/api/hooks/terminal|secret"
	if !strings.Contains(result, want) {
		t.Fatalf("environment output = %q, want %q", result, want)
	}
}

func TestUpdateAgentChangesTerminalActivity(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	updated, err := manager.UpdateAgent(metadata.ID, AgentUpdate{
		Agent: "codex", AgentSessionID: "019c43d4-95d9-7af0-92c4-d9f670ccaa32",
		TranscriptPath: "/home/me/.codex/sessions/2026/07/30/rollout-session.jsonl",
		Status:         "running", Title: "Implement v0.2", CWD: "/workspace/euphony",
	})
	if err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
	if updated.Agent != "codex" || updated.AgentStatus != "running" ||
		updated.AgentTitle != "Implement v0.2" ||
		updated.AgentSessionID != "019c43d4-95d9-7af0-92c4-d9f670ccaa32" ||
		updated.AgentTranscriptPath != "/home/me/.codex/sessions/2026/07/30/rollout-session.jsonl" ||
		updated.CWD != "/workspace/euphony" {
		t.Fatalf("updated metadata = %#v", updated)
	}
}

func TestMetadataReturnsHiddenAgentLinkage(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	created, err := manager.Create(context.Background(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	_, err = manager.UpdateAgent(created.ID, AgentUpdate{
		Agent: "claude", AgentSessionID: "session-1",
		TranscriptPath: "/home/me/.claude/projects/repo/session-1.jsonl",
	})
	if err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}

	got, ok := manager.Metadata(created.ID)
	if !ok || got.AgentSessionID != "session-1" ||
		got.AgentTranscriptPath != "/home/me/.claude/projects/repo/session-1.jsonl" {
		t.Fatalf("Metadata() = %#v, %v", got, ok)
	}
	if _, ok := manager.Metadata("missing"); ok {
		t.Fatal("Metadata(missing) ok = true, want false")
	}
}

func TestUpdateAgentClearsStaleTranscriptWhenSessionChanges(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	created, err := manager.Create(context.Background(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	_, err = manager.UpdateAgent(created.ID, AgentUpdate{
		Agent: "claude", AgentSessionID: "session-1",
		TranscriptPath: "/home/me/.claude/projects/repo/session-1.jsonl",
	})
	if err != nil {
		t.Fatalf("UpdateAgent(first session) error = %v", err)
	}

	updated, err := manager.UpdateAgent(created.ID, AgentUpdate{
		Agent: "claude", AgentSessionID: "session-2",
	})
	if err != nil {
		t.Fatalf("UpdateAgent(second session) error = %v", err)
	}
	if updated.AgentTranscriptPath != "" {
		t.Fatalf("AgentTranscriptPath = %q, want empty", updated.AgentTranscriptPath)
	}
}

func TestUpdateCWDExpandsHomeDirectoryTitle(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir() error = %v", err)
	}

	updated, err := manager.UpdateCWD(metadata.ID, "~")
	if err != nil {
		t.Fatalf("UpdateCWD() error = %v", err)
	}
	if updated.CWD != home {
		t.Fatalf("CWD = %q, want home %q", updated.CWD, home)
	}
}

func TestUpdateCWDKeepsMemoryUnchangedWhenPersistenceFails(t *testing.T) {
	store, err := OpenSQLiteStore(":memory:")
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	manager := NewManager("/bin/sh")
	manager.store = store
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close(store) error = %v", err)
	}

	if _, err := manager.UpdateCWD(metadata.ID, t.TempDir()); err == nil {
		t.Fatal("UpdateCWD() error = nil, want persistence error")
	}
	listed := manager.List()
	if len(listed) != 1 || listed[0].CWD != metadata.CWD {
		t.Fatalf("List() = %#v, want original cwd %q", listed, metadata.CWD)
	}
}

func TestRefreshCWDPreservesEquivalentLogicalPath(t *testing.T) {
	target := t.TempDir()
	link := filepath.Join(t.TempDir(), "linked")
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("Symlink() error = %v", err)
	}
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Terminal", link)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	updated, err := manager.RefreshCWD(metadata.ID)
	if err != nil {
		t.Fatalf("RefreshCWD() error = %v", err)
	}
	if updated.CWD != link {
		t.Fatalf("CWD = %q, want logical path %q", updated.CWD, link)
	}
}

func TestUpdateAgentMarksRunningToWaitingAsNeedingAttention(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := manager.UpdateAgent(metadata.ID, AgentUpdate{
		Agent: "claude", Status: "running", Title: "Fix terminal rendering",
	}); err != nil {
		t.Fatalf("UpdateAgent(running) error = %v", err)
	}

	updated, err := manager.UpdateAgent(metadata.ID, AgentUpdate{
		Agent: "claude", Status: "waiting",
	})
	if err != nil {
		t.Fatalf("UpdateAgent(waiting) error = %v", err)
	}
	if updated.AgentStatus != "waiting" {
		t.Fatalf("AgentStatus = %q, want waiting", updated.AgentStatus)
	}
	if !updated.NeedsAttention {
		t.Fatal("NeedsAttention = false, want true")
	}
	if updated.AgentTitle != "Fix terminal rendering" {
		t.Fatalf("AgentTitle = %q, want preserved title", updated.AgentTitle)
	}
}

func TestAcknowledgeAttentionClearsFlagAndPreservesCurrentStatus(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := manager.UpdateAgent(metadata.ID, AgentUpdate{
		Agent: "claude", Status: "running",
	}); err != nil {
		t.Fatalf("UpdateAgent(running) error = %v", err)
	}
	if _, err := manager.UpdateAgent(metadata.ID, AgentUpdate{
		Agent: "claude", Status: "waiting",
	}); err != nil {
		t.Fatalf("UpdateAgent(waiting) error = %v", err)
	}

	acknowledged, err := manager.AcknowledgeAttention(metadata.ID)
	if err != nil {
		t.Fatalf("AcknowledgeAttention() error = %v", err)
	}
	if acknowledged.AgentStatus != "waiting" {
		t.Fatalf("AgentStatus = %q, want waiting", acknowledged.AgentStatus)
	}
	if acknowledged.NeedsAttention {
		t.Fatal("NeedsAttention = true, want false")
	}

	if _, err := manager.UpdateAgent(metadata.ID, AgentUpdate{
		Agent: "claude", Status: "running",
	}); err != nil {
		t.Fatalf("UpdateAgent(running again) error = %v", err)
	}
	if _, err := manager.UpdateAgent(metadata.ID, AgentUpdate{
		Agent: "claude", Status: "waiting",
	}); err != nil {
		t.Fatalf("UpdateAgent(waiting again) error = %v", err)
	}
	current, err := manager.UpdateAgent(metadata.ID, AgentUpdate{
		Agent: "claude", Status: "running",
	})
	if err != nil {
		t.Fatalf("UpdateAgent(running after attention) error = %v", err)
	}
	if current.AgentStatus != "running" || !current.NeedsAttention {
		t.Fatalf("current metadata = %#v, want running with attention", current)
	}
	acknowledged, err = manager.AcknowledgeAttention(metadata.ID)
	if err != nil {
		t.Fatalf("AcknowledgeAttention(running) error = %v", err)
	}
	if acknowledged.AgentStatus != "running" {
		t.Fatalf("AgentStatus = %q, want running", acknowledged.AgentStatus)
	}
	if acknowledged.NeedsAttention {
		t.Fatal("NeedsAttention = true, want false")
	}
}

func TestCreateUsesRequestedWorkingDirectoryAndUTF8Locale(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	cwd := t.TempDir()

	metadata, err := manager.Create(context.Background(), "Terminal", cwd)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	resolvedCWD, _ := filepath.EvalSymlinks(cwd)
	if metadata.CWD != cwd || metadata.RepoRoot != resolvedCWD {
		t.Fatalf("created metadata = %#v, want cwd %q and repo root %q", metadata, cwd, resolvedCWD)
	}
	running, _ := manager.Get(metadata.ID)
	_, output, unsubscribe := running.Subscribe()
	defer unsubscribe()
	if _, err := running.Write([]byte("printf '%s|%s' \"$LANG\" \"$LC_CTYPE\"\n")); err != nil {
		t.Fatalf("Write(locale) error = %v", err)
	}
	got := receiveUntil(t, output, "UTF-8", 3*time.Second)
	if !strings.Contains(got, "UTF-8") {
		t.Fatalf("locale output = %q, want UTF-8", got)
	}
}

func TestRepositoryRootUsesMainCheckoutForLinkedWorktree(t *testing.T) {
	repository := t.TempDir()
	runGit := func(args ...string) {
		t.Helper()
		command := exec.Command("git", append([]string{"-C", repository}, args...)...)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, output)
		}
	}
	runGit("init")
	runGit("config", "user.email", "test@example.com")
	runGit("config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(repository, "README"), []byte("test"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit("add", "README")
	runGit("commit", "-m", "initial")
	worktree := filepath.Join(t.TempDir(), "linked")
	runGit("worktree", "add", worktree, "-b", "linked")

	got := repositoryRoot(worktree)
	resolvedRepository, _ := filepath.EvalSymlinks(repository)
	if got != resolvedRepository {
		t.Fatalf("repositoryRoot(%q) = %q, want %q", worktree, got, resolvedRepository)
	}
}

func TestListRefreshesCodexTitleFromSessionIndex(t *testing.T) {
	indexPath := filepath.Join(t.TempDir(), "session_index.jsonl")
	if err := os.WriteFile(indexPath, []byte(
		"{\"id\":\"codex-session\",\"thread_name\":\"Old title\"}\n"+
			"{\"id\":\"codex-session\",\"thread_name\":\"hello\"}\n",
	), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	manager := NewManager("/bin/sh", HookConfig{CodexSessionIndex: indexPath})
	manager.sessions["terminal-1"] = &entry{metadata: Metadata{
		ID: "terminal-1", Name: "Terminal", State: StateRunning,
		Agent: "codex", AgentSessionID: "codex-session",
		AgentTitle: "Old title", CreatedAt: time.Now().UTC(),
	}}

	items := manager.List()

	if len(items) != 1 || items[0].AgentTitle != "hello" {
		t.Fatalf("List() = %#v, want refreshed Codex title", items)
	}
}

func TestRestoredCommandResumesKnownAgents(t *testing.T) {
	tests := []struct {
		agent string
		id    string
		want  []string
	}{
		{agent: "codex", id: "codex-session", want: []string{"codex", "resume", "codex-session"}},
		{agent: "claude", id: "claude-session", want: []string{"claude", "--resume", "claude-session"}},
		{want: []string{"/bin/sh"}},
	}
	for _, test := range tests {
		command := restoredCommand("/bin/sh", Metadata{Agent: test.agent, AgentSessionID: test.id})
		if strings.Join(command.Args, "\x00") != strings.Join(test.want, "\x00") {
			t.Errorf("restoredCommand(%q) args = %#v, want %#v", test.agent, command.Args, test.want)
		}
	}
}

func TestPersistentManagerRestoresTerminalWithItsCWD(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "euphony.sqlite3")
	cwd := t.TempDir()
	store, err := OpenSQLiteStore(databasePath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	createdAt := time.Now().UTC()
	if err := store.Save(context.Background(), Metadata{
		ID: "restored-terminal", Name: "Terminal", State: StateRunning,
		CWD: cwd, CreatedAt: createdAt,
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	manager, err := NewPersistentManager("/bin/sh", HookConfig{}, databasePath)
	if err != nil {
		t.Fatalf("NewPersistentManager() error = %v", err)
	}
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	terminal, ok := manager.Get("restored-terminal")
	if !ok {
		t.Fatal("restored terminal is missing")
	}
	_, output, unsubscribe := terminal.Subscribe()
	defer unsubscribe()
	if _, err := terminal.Write([]byte("pwd\n")); err != nil {
		t.Fatalf("Write(pwd) error = %v", err)
	}
	got := receiveUntil(t, output, cwd, 3*time.Second)
	if !strings.Contains(got, cwd) {
		t.Fatalf("pwd output = %q, want %q", got, cwd)
	}
	metadata := manager.List()
	if len(metadata) != 1 || metadata[0].ID != "restored-terminal" ||
		metadata[0].State != StateRunning || !metadata[0].CreatedAt.Equal(createdAt) {
		t.Fatalf("restored metadata = %#v", metadata)
	}
}

func TestPersistentManagerRestoresTerminalAfterItsCWDWasRemoved(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "euphony.sqlite3")
	store, err := OpenSQLiteStore(databasePath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	missing := filepath.Join(t.TempDir(), "removed-worktree")
	if err := store.Save(context.Background(), Metadata{
		ID: "missing-cwd", Name: "Terminal", State: StateRunning,
		CWD: missing, CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	manager, err := NewPersistentManager("/bin/sh", HookConfig{}, databasePath)
	if err != nil {
		t.Fatalf("NewPersistentManager() error = %v, want cwd fallback", err)
	}
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	items := manager.List()
	current, _ := os.Getwd()
	if len(items) != 1 || items[0].CWD != current {
		t.Fatalf("restored metadata = %#v, want fallback cwd %q", items, current)
	}
}

func TestPersistentManagerDeletesExitedTerminalFromSQLite(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "euphony.sqlite3")
	manager, err := NewPersistentManager("/bin/sh", HookConfig{}, databasePath)
	if err != nil {
		t.Fatalf("NewPersistentManager() error = %v", err)
	}
	metadata, err := manager.Create(context.Background(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	terminal, ok := manager.Get(metadata.ID)
	if !ok {
		t.Fatal("created terminal is missing")
	}
	if _, err := terminal.Write([]byte("exit 0\n")); err != nil {
		t.Fatalf("Write(exit) error = %v", err)
	}
	waitFor(t, 3*time.Second, func() bool {
		return len(manager.List()) == 0
	})
	if err := manager.Close(context.Background()); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	store, err := OpenSQLiteStore(databasePath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	defer store.Close()
	items, err := store.Load(context.Background())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("persisted terminals = %#v, want none", items)
	}
}

func TestPersistentManagerPurgesPreviouslyExitedTerminal(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "euphony.sqlite3")
	store, err := OpenSQLiteStore(databasePath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	if err := store.Save(context.Background(), Metadata{
		ID: "exited-terminal", Name: "Terminal", State: StateExited,
		CWD: t.TempDir(), CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	manager, err := NewPersistentManager("/bin/sh", HookConfig{}, databasePath)
	if err != nil {
		t.Fatalf("NewPersistentManager() error = %v", err)
	}
	if got := manager.List(); len(got) != 0 {
		t.Fatalf("List() = %#v, want exited terminal purged", got)
	}
	if err := manager.Close(context.Background()); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	store, err = OpenSQLiteStore(databasePath)
	if err != nil {
		t.Fatalf("reopen SQLite: %v", err)
	}
	defer store.Close()
	items, err := store.Load(context.Background())
	if err != nil || len(items) != 0 {
		t.Fatalf("Load() = %#v, %v; want none", items, err)
	}
}

func TestPersistentManagerCloseKeepsTerminalForRestart(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "euphony.sqlite3")
	manager, err := NewPersistentManager("/bin/sh", HookConfig{}, databasePath)
	if err != nil {
		t.Fatalf("NewPersistentManager() error = %v", err)
	}
	created, err := manager.Create(context.Background(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := manager.Close(context.Background()); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	restarted, err := NewPersistentManager("/bin/sh", HookConfig{}, databasePath)
	if err != nil {
		t.Fatalf("restart manager: %v", err)
	}
	defer restarted.Close(context.Background())
	items := restarted.List()
	if len(items) != 1 || items[0].ID != created.ID || items[0].State != StateRunning {
		t.Fatalf("restored terminals = %#v, want %q running", items, created.ID)
	}
}

func TestResizeValidatesBounds(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Resize")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	running, _ := manager.Get(metadata.ID)

	if err := running.Resize(0, 24); err == nil {
		t.Fatal("Resize(0, 24) error = nil")
	}
	if err := running.Resize(80, 1001); err == nil {
		t.Fatal("Resize(80, 1001) error = nil")
	}
	if err := running.Resize(120, 40); err != nil {
		t.Fatalf("Resize(120, 40) error = %v", err)
	}
}

func TestDeleteTerminatesAndRemovesRunningSession(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Delete")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if err := manager.Delete(metadata.ID); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if _, ok := manager.Get(metadata.ID); ok {
		t.Fatalf("Get(%q) ok = true after delete", metadata.ID)
	}
}

func TestSubscribeReplaysHistoryAndContinuesWithLiveOutput(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Reload")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	running, ok := manager.Get(metadata.ID)
	if !ok {
		t.Fatalf("Get(%q) ok = false", metadata.ID)
	}

	initialHistory, initialOutput, unsubscribe := running.Subscribe()
	if len(initialHistory) != 0 {
		t.Fatalf("initial history = %q, want empty", initialHistory)
	}
	if _, err := running.Write([]byte("printf 'before-reload\\n'\n")); err != nil {
		t.Fatalf("Write(before reload) error = %v", err)
	}
	beforeReload := receiveUntil(t, initialOutput, "before-reload\r\n", 3*time.Second)
	unsubscribe()

	history, liveOutput, unsubscribeReloaded := running.Subscribe()
	defer unsubscribeReloaded()
	if !strings.Contains(string(history), "before-reload\r\n") {
		t.Fatalf("reloaded history = %q, want previous terminal output", history)
	}

	if _, err := running.Write([]byte("printf 'after-reload\\n'\n")); err != nil {
		t.Fatalf("Write(after reload) error = %v", err)
	}
	afterReload := receiveUntil(t, liveOutput, "after-reload\r\n", 3*time.Second)
	if !strings.Contains(afterReload, "after-reload\r\n") {
		t.Fatalf("live output = %q, want new terminal output", afterReload)
	}
	if !strings.Contains(beforeReload, "before-reload\r\n") {
		t.Fatalf("initial output = %q, want command output", beforeReload)
	}
}

func TestBurstOutputKeepsSubscriberAttachedWhileProcessRuns(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Burst")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	running, ok := manager.Get(metadata.ID)
	if !ok {
		t.Fatalf("Get(%q) ok = false", metadata.ID)
	}

	_, output, unsubscribe := running.Subscribe()
	defer unsubscribe()
	if _, err := running.Write([]byte("seq 1 100000; printf 'burst-done\\n'\n")); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	// Let the burst outrun the subscriber the way a browser tab does before
	// draining it, so a lagging reader must not look like a terminated process.
	time.Sleep(500 * time.Millisecond)

	received := receiveUntil(t, output, "burst-done\r\n", 10*time.Second)
	if !strings.Contains(received, "burst-done\r\n") {
		t.Fatalf("received output = %q, want burst completion marker", received)
	}
	if _, ok := manager.Get(metadata.ID); !ok {
		t.Fatalf("Get(%q) ok = false, want terminal still running", metadata.ID)
	}
}

func TestSubscribeAfterProcessExitReturnsHistoryAndClosedOutput(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Exited")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	running, _ := manager.Get(metadata.ID)
	_, output, unsubscribe := running.Subscribe()
	if _, err := running.Write([]byte("printf 'final-output\\n'; exit 0\n")); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	_ = receiveUntil(t, output, "final-output\r\n", 3*time.Second)
	unsubscribe()
	waitFor(t, 3*time.Second, func() bool {
		select {
		case <-running.pumpDone:
			return true
		default:
			return false
		}
	})

	history, exitedOutput, unsubscribeExited := running.Subscribe()
	defer unsubscribeExited()
	if !strings.Contains(string(history), "final-output\r\n") {
		t.Fatalf("history = %q, want final output", history)
	}
	select {
	case _, ok := <-exitedOutput:
		if ok {
			t.Fatal("exited output channel is open, want closed")
		}
	case <-time.After(time.Second):
		t.Fatal("exited output channel did not close")
	}
}

func receiveUntil(t *testing.T, output <-chan []byte, needle string, timeout time.Duration) string {
	t.Helper()
	var received strings.Builder
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case data, ok := <-output:
			if !ok {
				t.Fatalf("output closed while waiting for %q; received %q", needle, received.String())
			}
			received.Write(data)
			if strings.Contains(received.String(), needle) {
				return received.String()
			}
		case <-timer.C:
			t.Fatalf("timed out waiting for %q; received %q", needle, received.String())
		}
	}
}

func receiveUntilCount(t *testing.T, output <-chan []byte, needle string, count int, timeout time.Duration) string {
	t.Helper()
	var received strings.Builder
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case data, ok := <-output:
			if !ok {
				t.Fatalf("output closed while waiting for %q; received %q", needle, received.String())
			}
			received.Write(data)
			if strings.Count(received.String(), needle) >= count {
				return received.String()
			}
		case <-timer.C:
			t.Fatalf("timed out waiting for %q; received %q", needle, received.String())
		}
	}
}

func waitFor(t *testing.T, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition was not met before timeout")
}
