package session

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/creack/pty"
	"github.com/ryotarai/euphony/internal/selection"
	"golang.org/x/sys/unix"
)

func TestCreateRejectsBlankName(t *testing.T) {
	t.Parallel()

	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	if _, err := manager.Create(context.Background(), "   "); err == nil {
		t.Fatal("Create() error = nil, want validation error")
	}
}

func TestManagerRenameTrimsNameAndPreservesDynamicMetadata(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	created, err := manager.Create(context.Background(), "Terminal", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	before, err := manager.UpdateAgent(created.ID, AgentUpdate{
		Agent: "codex", Status: "waiting", Title: "Dynamic title",
	})
	if err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
	changes := make(chan Change, 1)
	manager.SetChangeHandler(func(change Change) { changes <- change })

	renamed, err := manager.Rename(created.ID, "  Manual terminal  ")
	if err != nil {
		t.Fatalf("Rename() error = %v", err)
	}
	if renamed.Name != "Manual terminal" || !renamed.CustomName {
		t.Fatalf("renamed metadata = %#v, want trimmed custom name", renamed)
	}
	if renamed.Agent != before.Agent || renamed.AgentStatus != before.AgentStatus ||
		renamed.AgentTitle != before.AgentTitle || renamed.ProcessName != before.ProcessName {
		t.Fatalf("dynamic metadata changed by Rename(): before=%#v after=%#v", before, renamed)
	}

	select {
	case change := <-changes:
		if change.Kind != ChangeUpdated || change.After == nil ||
			change.After.Name != "Manual terminal" || !change.After.CustomName {
			t.Fatalf("rename change = %#v, want ChangeUpdated with renamed metadata", change)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for rename change")
	}
}

func TestManagerRenameValidatesNameWithoutMutatingMetadata(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	created, err := manager.Create(context.Background(), "Terminal", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	for _, name := range []string{"   ", strings.Repeat("あ", 81)} {
		if _, err := manager.Rename(created.ID, name); err == nil {
			t.Fatalf("Rename(%q) error = nil, want validation error", name)
		}
		current, ok := manager.Metadata(created.ID)
		if !ok {
			t.Fatal("renamed terminal disappeared after validation error")
		}
		if current.Name != created.Name || current.CustomName {
			t.Fatalf("metadata after invalid Rename(%q) = %#v, want unchanged", name, current)
		}
	}
}

func TestManagerRenameRollsBackWhenPersistenceFails(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	created, err := manager.Create(context.Background(), "Terminal", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	store := &failFirstSaveMetadataStore{
		recordingMetadataStore: recordingMetadataStore{},
		err:                    errors.New("save failed"),
	}
	manager.store = store

	if _, err := manager.Rename(created.ID, "Renamed terminal"); !errors.Is(err, store.err) {
		t.Fatalf("Rename() error = %v, want %v", err, store.err)
	}
	current, ok := manager.Metadata(created.ID)
	if !ok {
		t.Fatal("terminal disappeared after failed Rename()")
	}
	if current != created {
		t.Fatalf("metadata after failed Rename() = %#v, want %#v", current, created)
	}
}

func TestManagerRenameRollsBackOwnedFieldsAfterConcurrentProcessRefresh(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	created, err := manager.Create(context.Background(), "Terminal", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	storeErr := errors.New("save failed")
	store := &gatedResultMetadataStore{
		recordingMetadataStore: recordingMetadataStore{},
		entered:                make(chan int, 1),
		releaseFirst:           make(chan struct{}),
		saveErrors:             []error{storeErr},
	}
	manager.store = store

	renameDone := make(chan error, 1)
	go func() {
		_, err := manager.Rename(created.ID, "Renamed terminal")
		renameDone <- err
	}()
	if call := <-store.entered; call != 1 {
		t.Fatalf("Rename() Save() call = %d, want 1", call)
	}
	if change := manager.updateForegroundProcessName(created.ID, "vim"); change == nil {
		t.Fatal("concurrent process refresh did not update metadata")
	}
	close(store.releaseFirst)

	if err := <-renameDone; !errors.Is(err, storeErr) {
		t.Fatalf("Rename() error = %v, want %v", err, storeErr)
	}
	current, ok := manager.Metadata(created.ID)
	if !ok {
		t.Fatal("terminal disappeared after failed Rename()")
	}
	if current.Name != created.Name || current.CustomName {
		t.Fatalf("rename-owned metadata after failed Rename() = %#v, want original name", current)
	}
	if current.ProcessName != "vim" {
		t.Fatalf("concurrent process name after failed Rename() = %q, want vim", current.ProcessName)
	}
}

func TestInMemoryManagerRetainsSelectionState(t *testing.T) {
	manager := NewManager("/bin/sh")
	want := selection.State{
		ManualTerminalIDs: []string{"terminal"},
		PinnedTerminalIDs: []string{},
		FocusedTerminalID: "terminal",
		StatusFilters:     []string{},
		CWDFilters:        []selection.CWDFilter{},
		Revision:          3,
	}
	if err := manager.SaveSelection(context.Background(), want); err != nil {
		t.Fatalf("SaveSelection() error = %v", err)
	}
	got, found, err := manager.LoadSelection(context.Background())
	if err != nil || !found || !reflect.DeepEqual(got, want) {
		t.Fatalf("LoadSelection() = %#v, %t, %v; want %#v", got, found, err, want)
	}
	got.ManualTerminalIDs[0] = "mutated"
	again, _, _ := manager.LoadSelection(context.Background())
	if again.ManualTerminalIDs[0] != "terminal" {
		t.Fatalf("LoadSelection() returned aliased state: %#v", again)
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
	wantCWD := t.TempDir()

	metadata, err := manager.Create(context.Background(), "Terminal", wantCWD)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
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

func TestUpdateAgentRepositoryResolutionDoesNotBlockManager(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	targetCWD := t.TempDir()
	entered := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseResolver := func() {
		releaseOnce.Do(func() { close(release) })
	}
	defer releaseResolver()
	manager.repositoryRootResolver = func(cwd string) string {
		if cwd != targetCWD {
			t.Errorf("repository root CWD = %q, want %q", cwd, targetCWD)
		}
		close(entered)
		<-release
		return targetCWD
	}

	updateDone := make(chan error, 1)
	go func() {
		_, err := manager.UpdateAgent(metadata.ID, AgentUpdate{CWD: targetCWD})
		updateDone <- err
	}()
	<-entered
	assertManagerReadsAndWritesPromptly(t, manager, metadata.ID)
	releaseResolver()
	if err := <-updateDone; err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
}

func TestUpdateAgentTranscriptStatDoesNotBlockManager(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	transcript := filepath.Join(t.TempDir(), "rollout.jsonl")
	if err := os.WriteFile(transcript, nil, 0o600); err != nil {
		t.Fatalf("write transcript: %v", err)
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseStat := func() {
		releaseOnce.Do(func() { close(release) })
	}
	defer releaseStat()
	manager.fileStat = func(path string) (os.FileInfo, error) {
		if path != transcript {
			t.Errorf("stat path = %q, want %q", path, transcript)
		}
		close(entered)
		<-release
		return os.Stat(path)
	}

	updateDone := make(chan error, 1)
	go func() {
		_, err := manager.UpdateAgent(metadata.ID, AgentUpdate{
			Agent:          "codex",
			AgentSessionID: "session-1",
			TranscriptPath: transcript,
			Status:         "blocked",
		})
		updateDone <- err
	}()
	<-entered
	assertManagerReadsAndWritesPromptly(t, manager, metadata.ID)
	releaseStat()
	if err := <-updateDone; err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
}

func TestChangeHandlersObserveAssignedSequenceOrder(t *testing.T) {
	manager := NewManager("/bin/sh")
	manager.sessions["first"] = &entry{
		metadata: Metadata{
			ID:             "first",
			Name:           "First",
			State:          StateRunning,
			NeedsAttention: true,
			CreatedAt:      time.Now().UTC(),
		},
	}
	manager.sessions["second"] = &entry{
		metadata: Metadata{
			ID:             "second",
			Name:           "Second",
			State:          StateRunning,
			NeedsAttention: true,
			CreatedAt:      time.Now().UTC(),
		},
	}

	firstEntered := make(chan struct{})
	releaseFirst := make(chan struct{})
	var observedMu sync.Mutex
	var observed []uint64
	manager.SetChangeHandler(func(change Change) {
		if change.Sequence == 1 {
			close(firstEntered)
			<-releaseFirst
		}
		observedMu.Lock()
		observed = append(observed, change.Sequence)
		observedMu.Unlock()
	})

	firstDone := make(chan error, 1)
	go func() {
		_, err := manager.AcknowledgeAttention("first")
		firstDone <- err
	}()
	<-firstEntered

	secondDone := make(chan error, 1)
	go func() {
		_, err := manager.AcknowledgeAttention("second")
		secondDone <- err
	}()
	select {
	case err := <-secondDone:
		if err != nil {
			t.Fatalf("second AcknowledgeAttention() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("second change did not complete while the first handler was gated")
	}

	close(releaseFirst)
	if err := <-firstDone; err != nil {
		t.Fatalf("first AcknowledgeAttention() error = %v", err)
	}
	waitFor(t, time.Second, func() bool {
		observedMu.Lock()
		defer observedMu.Unlock()
		return len(observed) == 2
	})
	observedMu.Lock()
	defer observedMu.Unlock()
	if !reflect.DeepEqual(observed, []uint64{1, 2}) {
		t.Fatalf("observed change sequences = %v, want [1 2]", observed)
	}
}

func TestChangeHandlerPanicDoesNotStopLaterDeliveries(t *testing.T) {
	manager := NewManager("/bin/sh")
	manager.sessions["first"] = &entry{
		metadata: Metadata{
			ID:             "first",
			Name:           "First",
			State:          StateRunning,
			NeedsAttention: true,
			CreatedAt:      time.Now().UTC(),
		},
	}
	manager.sessions["second"] = &entry{
		metadata: Metadata{
			ID:             "second",
			Name:           "Second",
			State:          StateRunning,
			NeedsAttention: true,
			CreatedAt:      time.Now().UTC(),
		},
	}
	manager.SetChangeHandler(func(change Change) {
		if change.Sequence == 1 {
			panic("handler failed")
		}
	})

	func() {
		defer func() {
			if recovered := recover(); recovered != "handler failed" {
				t.Fatalf("recovered panic = %v, want handler failed", recovered)
			}
		}()
		_, _ = manager.AcknowledgeAttention("first")
	}()

	delivered := make(chan Change, 1)
	manager.SetChangeHandler(func(change Change) {
		delivered <- change
	})
	if _, err := manager.AcknowledgeAttention("second"); err != nil {
		t.Fatalf("second AcknowledgeAttention() error = %v", err)
	}
	select {
	case change := <-delivered:
		if change.Sequence != 2 {
			t.Fatalf("delivered sequence = %d, want 2", change.Sequence)
		}
	case <-time.After(time.Second):
		t.Fatal("later change was stranded after a handler panic")
	}
}

func TestChangeHandlerPanicDrainsCompletedLaterChange(t *testing.T) {
	manager := NewManager("/bin/sh")
	for _, id := range []string{"first", "second"} {
		manager.sessions[id] = &entry{
			metadata: Metadata{
				ID:             id,
				Name:           id,
				State:          StateRunning,
				NeedsAttention: true,
				CreatedAt:      time.Now().UTC(),
			},
		}
	}

	firstEntered := make(chan struct{})
	releaseFirst := make(chan struct{})
	deliveredSecond := make(chan struct{})
	manager.SetChangeHandler(func(change Change) {
		switch change.Sequence {
		case 1:
			close(firstEntered)
			<-releaseFirst
			panic("handler failed")
		case 2:
			close(deliveredSecond)
		}
	})

	firstDone := make(chan any, 1)
	go func() {
		defer func() {
			firstDone <- recover()
		}()
		_, _ = manager.AcknowledgeAttention("first")
	}()
	<-firstEntered

	if _, err := manager.AcknowledgeAttention("second"); err != nil {
		t.Fatalf("second AcknowledgeAttention() error = %v", err)
	}
	close(releaseFirst)
	if recovered := <-firstDone; recovered != "handler failed" {
		t.Fatalf("recovered panic = %v, want handler failed", recovered)
	}
	select {
	case <-deliveredSecond:
	case <-time.After(time.Second):
		t.Fatal("completed later change was stranded by an earlier handler panic")
	}
}

func TestFailedPersistenceSkipsChangeSequenceGap(t *testing.T) {
	manager := NewManager("/bin/sh")
	manager.sessions["first"] = &entry{
		metadata: Metadata{
			ID:             "first",
			Name:           "First",
			State:          StateRunning,
			NeedsAttention: true,
			CreatedAt:      time.Now().UTC(),
		},
	}
	manager.sessions["second"] = &entry{
		metadata: Metadata{
			ID:             "second",
			Name:           "Second",
			State:          StateRunning,
			NeedsAttention: true,
			CreatedAt:      time.Now().UTC(),
		},
	}
	store := &failFirstSaveMetadataStore{
		recordingMetadataStore: recordingMetadataStore{},
		err:                    errors.New("save failed"),
	}
	manager.store = store

	var observed []uint64
	manager.SetChangeHandler(func(change Change) {
		observed = append(observed, change.Sequence)
	})

	if _, err := manager.AcknowledgeAttention("first"); !errors.Is(err, store.err) {
		t.Fatalf("first AcknowledgeAttention() error = %v, want %v", err, store.err)
	}
	if _, err := manager.AcknowledgeAttention("second"); err != nil {
		t.Fatalf("second AcknowledgeAttention() error = %v", err)
	}
	if !reflect.DeepEqual(observed, []uint64{2}) {
		t.Fatalf("observed change sequences = %v, want [2]", observed)
	}
}

func TestUpdateAgentDoesNotInstallCodexActivityWatcherAfterCloseStarts(t *testing.T) {
	transcript := filepath.Join(t.TempDir(), "rollout.jsonl")
	if err := os.WriteFile(transcript, nil, 0o600); err != nil {
		t.Fatalf("write transcript: %v", err)
	}

	manager := NewManager("/bin/sh")
	item := &entry{
		metadata: Metadata{
			ID:        "terminal",
			Name:      "Terminal",
			State:     StateRunning,
			CreatedAt: time.Now().UTC(),
		},
		session: &Session{
			command:  exec.Command("/bin/sh"),
			waitDone: closedTestChannel(),
		},
	}
	manager.sessions[item.metadata.ID] = item
	store := &gatedSaveMetadataStore{
		metadataStore: &recordingMetadataStore{},
		saveEntered:   make(chan struct{}),
		saveRelease:   make(chan struct{}),
	}
	manager.store = store

	refreshRelease := make(chan struct{})
	manager.refreshMu.Lock()
	manager.refreshLifecycleDone = refreshRelease
	manager.refreshMu.Unlock()

	updateDone := make(chan error, 1)
	go func() {
		_, err := manager.UpdateAgent(item.metadata.ID, AgentUpdate{
			Agent:          "codex",
			AgentSessionID: "session-1",
			TranscriptPath: transcript,
			Status:         "blocked",
		})
		updateDone <- err
	}()
	<-store.saveEntered

	closeDone := make(chan error, 1)
	go func() {
		closeDone <- manager.Close(context.Background())
	}()
	waitFor(t, time.Second, func() bool {
		manager.mu.RLock()
		defer manager.mu.RUnlock()
		return manager.closing
	})

	close(store.saveRelease)
	if err := <-updateDone; err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
	manager.mu.RLock()
	watch := item.codexActivityWatch
	manager.mu.RUnlock()
	if watch != nil {
		close(refreshRelease)
		<-closeDone
		t.Fatal("UpdateAgent() installed a Codex activity watcher after Close() started")
	}

	close(refreshRelease)
	if err := <-closeDone; err != nil {
		t.Fatalf("Close() error = %v", err)
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

func TestUpdateCWDRepositoryResolutionDoesNotBlockManager(t *testing.T) {
	initialCWD := t.TempDir()
	targetCWD := t.TempDir()
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Terminal", initialCWD)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseResolver := func() {
		releaseOnce.Do(func() { close(release) })
	}
	defer releaseResolver()
	manager.repositoryRootResolver = func(cwd string) string {
		close(entered)
		<-release
		return cwd
	}

	updateDone := make(chan error, 1)
	go func() {
		_, err := manager.UpdateCWD(metadata.ID, targetCWD)
		updateDone <- err
	}()
	<-entered
	assertManagerReadsAndWritesPromptly(t, manager, metadata.ID)
	releaseResolver()
	if err := <-updateDone; err != nil {
		t.Fatalf("UpdateCWD() error = %v", err)
	}
}

func TestUpdateCWDEquivalenceStatDoesNotBlockManager(t *testing.T) {
	initialCWD := t.TempDir()
	targetCWD := t.TempDir()
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Terminal", initialCWD)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	var enterOnce sync.Once
	var releaseOnce sync.Once
	releaseStat := func() {
		releaseOnce.Do(func() { close(release) })
	}
	defer releaseStat()
	manager.fileStat = func(path string) (os.FileInfo, error) {
		enterOnce.Do(func() { close(entered) })
		<-release
		return os.Stat(path)
	}

	updateDone := make(chan error, 1)
	go func() {
		_, err := manager.UpdateCWD(metadata.ID, targetCWD)
		updateDone <- err
	}()
	<-entered
	assertManagerReadsAndWritesPromptly(t, manager, metadata.ID)
	releaseStat()
	if err := <-updateDone; err != nil {
		t.Fatalf("UpdateCWD() error = %v", err)
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
	manager.mu.RLock()
	reportedAt := manager.sessions[metadata.ID].cwdReportedAt
	manager.mu.RUnlock()
	if !reportedAt.IsZero() {
		t.Fatalf("cwdReportedAt = %v, want zero after persistence failure", reportedAt)
	}
}

func TestReportedCWDAtomicallySupersedesInFlightProcessSample(t *testing.T) {
	processCWD := t.TempDir()
	reportedCWD := t.TempDir()
	manager := NewManager("/bin/sh")
	manager.sessions["terminal"] = &entry{
		metadata: Metadata{
			ID:        "terminal",
			Name:      "Terminal",
			State:     StateRunning,
			CWD:       processCWD,
			RepoRoot:  processCWD,
			CreatedAt: time.Now().UTC(),
		},
	}
	store := &gatedSaveMetadataStore{
		metadataStore: &recordingMetadataStore{},
		saveEntered:   make(chan struct{}),
		saveRelease:   make(chan struct{}),
	}
	manager.store = store

	sampledAt := time.Now()
	reportDone := make(chan error, 1)
	go func() {
		_, err := manager.UpdateCWD("terminal", reportedCWD)
		reportDone <- err
	}()
	<-store.saveEntered

	refreshStarted := make(chan struct{})
	refreshDone := make(chan error, 1)
	go func() {
		close(refreshStarted)
		_, err := manager.updateCWDNotReportedSince(
			"terminal", processCWD, true, sampledAt, time.Time{},
		)
		refreshDone <- err
	}()
	<-refreshStarted
	time.Sleep(100 * time.Millisecond)

	close(store.saveRelease)
	if err := <-reportDone; err != nil {
		t.Fatalf("UpdateCWD() error = %v", err)
	}
	if err := <-refreshDone; err != nil {
		t.Fatalf("sampled CWD update error = %v", err)
	}

	metadata, _ := manager.Metadata("terminal")
	if metadata.CWD != reportedCWD {
		t.Fatalf("CWD = %q, want reported CWD %q", metadata.CWD, reportedCWD)
	}
	manager.mu.RLock()
	reportedAt := manager.sessions["terminal"].cwdReportedAt
	manager.mu.RUnlock()
	if !reportedAt.After(sampledAt) {
		t.Fatalf("cwdReportedAt = %v, want after sample time %v", reportedAt, sampledAt)
	}
}

func TestConcurrentEquivalentCWDReportsWaitForPersistenceOutcome(t *testing.T) {
	for _, test := range []struct {
		name             string
		equivalentSecond bool
		secondErr        error
	}{
		{name: "same path then succeeds"},
		{
			name:             "equivalent path then succeeds",
			equivalentSecond: true,
		},
		{
			name:      "same path both fail",
			secondErr: errors.New("second save failed"),
		},
		{
			name:             "equivalent path both fail",
			equivalentSecond: true,
			secondErr:        errors.New("second save failed"),
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			initialCWD := t.TempDir()
			targetCWD := t.TempDir()
			secondCWD := targetCWD
			if test.equivalentSecond {
				secondCWD = filepath.Join(t.TempDir(), "target-link")
				if err := os.Symlink(targetCWD, secondCWD); err != nil {
					t.Fatalf("Symlink() error = %v", err)
				}
			}
			manager := NewManager("/bin/sh")
			manager.sessions["terminal"] = &entry{
				metadata: Metadata{
					ID:        "terminal",
					Name:      "Terminal",
					State:     StateRunning,
					CWD:       initialCWD,
					RepoRoot:  initialCWD,
					CreatedAt: time.Now().UTC(),
				},
			}
			firstErr := errors.New("first save failed")
			store := &gatedResultMetadataStore{
				recordingMetadataStore: recordingMetadataStore{},
				entered:                make(chan int, 2),
				releaseFirst:           make(chan struct{}),
				saveErrors:             []error{firstErr, test.secondErr},
			}
			manager.store = store

			firstDone := make(chan error, 1)
			go func() {
				_, err := manager.UpdateCWD("terminal", targetCWD)
				firstDone <- err
			}()
			if call := <-store.entered; call != 1 {
				t.Fatalf("first Save() call = %d, want 1", call)
			}

			secondStarted := make(chan struct{})
			secondDone := make(chan error, 1)
			go func() {
				close(secondStarted)
				_, err := manager.UpdateCWD("terminal", secondCWD)
				secondDone <- err
			}()
			<-secondStarted
			select {
			case err := <-secondDone:
				close(store.releaseFirst)
				<-firstDone
				t.Fatalf(
					"second UpdateCWD() returned before first persistence outcome: %v",
					err,
				)
			case <-time.After(100 * time.Millisecond):
			}

			close(store.releaseFirst)
			if err := <-firstDone; !errors.Is(err, firstErr) {
				t.Fatalf("first UpdateCWD() error = %v, want %v", err, firstErr)
			}
			if call := <-store.entered; call != 2 {
				t.Fatalf("second Save() call = %d, want 2", call)
			}
			if err := <-secondDone; !errors.Is(err, test.secondErr) {
				t.Fatalf("second UpdateCWD() error = %v, want %v", err, test.secondErr)
			}

			metadata, _ := manager.Metadata("terminal")
			wantCWD := secondCWD
			if test.secondErr != nil {
				wantCWD = initialCWD
			}
			if metadata.CWD != wantCWD {
				t.Fatalf("CWD = %q, want %q", metadata.CWD, wantCWD)
			}
			manager.mu.RLock()
			reportedAt := manager.sessions["terminal"].cwdReportedAt
			manager.mu.RUnlock()
			if test.secondErr == nil && reportedAt.IsZero() {
				t.Fatal("cwdReportedAt is zero after the successful second report")
			}
			if test.secondErr != nil && !reportedAt.IsZero() {
				t.Fatalf("cwdReportedAt = %v, want zero after both reports failed", reportedAt)
			}
		})
	}
}

func TestAgentCWDWaitsForFailedBrowserCWDOutcome(t *testing.T) {
	initialCWD := t.TempDir()
	targetCWD := t.TempDir()
	manager := NewManager("/bin/sh")
	item := &entry{
		metadata: Metadata{
			ID:        "terminal",
			Name:      "Terminal",
			State:     StateRunning,
			CWD:       initialCWD,
			RepoRoot:  initialCWD,
			CreatedAt: time.Now().UTC(),
		},
	}
	manager.sessions[item.metadata.ID] = item
	firstErr := errors.New("browser save failed")
	store := &gatedResultMetadataStore{
		recordingMetadataStore: recordingMetadataStore{},
		entered:                make(chan int, 2),
		releaseFirst:           make(chan struct{}),
		saveErrors:             []error{firstErr, nil},
	}
	manager.store = store

	browserDone := make(chan error, 1)
	go func() {
		_, err := manager.UpdateCWD(item.metadata.ID, targetCWD)
		browserDone <- err
	}()
	if call := <-store.entered; call != 1 {
		t.Fatalf("browser Save() call = %d, want 1", call)
	}

	agentStarted := make(chan struct{})
	agentDone := make(chan error, 1)
	go func() {
		close(agentStarted)
		_, err := manager.UpdateAgent(item.metadata.ID, AgentUpdate{CWD: targetCWD})
		agentDone <- err
	}()
	<-agentStarted
	time.Sleep(100 * time.Millisecond)
	close(store.releaseFirst)
	if err := <-browserDone; !errors.Is(err, firstErr) {
		t.Fatalf("UpdateCWD() error = %v, want %v", err, firstErr)
	}
	if call := <-store.entered; call != 2 {
		t.Fatalf("agent Save() call = %d, want 2", call)
	}
	if err := <-agentDone; err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}

	metadata, _ := manager.Metadata(item.metadata.ID)
	if metadata.CWD != targetCWD {
		t.Fatalf("CWD = %q, want agent CWD %q", metadata.CWD, targetCWD)
	}
	manager.mu.RLock()
	cwdFromAgent := item.cwdFromAgent
	manager.mu.RUnlock()
	if !cwdFromAgent {
		t.Fatal("cwdFromAgent = false after successful agent update")
	}
}

func TestStatusUpdatePersistsRolledBackCWD(t *testing.T) {
	initialCWD := t.TempDir()
	failedCWD := t.TempDir()
	manager := NewManager("/bin/sh")
	item := &entry{
		metadata: Metadata{
			ID:        "terminal",
			Name:      "Terminal",
			State:     StateRunning,
			CWD:       initialCWD,
			RepoRoot:  initialCWD,
			CreatedAt: time.Now().UTC(),
		},
	}
	manager.sessions[item.metadata.ID] = item
	firstErr := errors.New("cwd save failed")
	store := &gatedResultMetadataStore{
		recordingMetadataStore: recordingMetadataStore{},
		entered:                make(chan int, 2),
		releaseFirst:           make(chan struct{}),
		saveErrors:             []error{firstErr, nil},
	}
	manager.store = store

	cwdDone := make(chan error, 1)
	go func() {
		_, err := manager.UpdateCWD(item.metadata.ID, failedCWD)
		cwdDone <- err
	}()
	if call := <-store.entered; call != 1 {
		t.Fatalf("CWD Save() call = %d, want 1", call)
	}

	statusStarted := make(chan struct{})
	statusDone := make(chan error, 1)
	go func() {
		close(statusStarted)
		_, err := manager.UpdateAgent(item.metadata.ID, AgentUpdate{
			Agent:  "codex",
			Status: "running",
		})
		statusDone <- err
	}()
	<-statusStarted
	time.Sleep(100 * time.Millisecond)
	close(store.releaseFirst)

	if err := <-cwdDone; !errors.Is(err, firstErr) {
		t.Fatalf("UpdateCWD() error = %v, want %v", err, firstErr)
	}
	if call := <-store.entered; call != 2 {
		t.Fatalf("status Save() call = %d, want 2", call)
	}
	if err := <-statusDone; err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}

	metadata, _ := manager.Metadata(item.metadata.ID)
	if metadata.CWD != initialCWD || metadata.AgentStatus != "running" {
		t.Fatalf(
			"metadata = %#v, want CWD %q and running status",
			metadata,
			initialCWD,
		)
	}
	saves := store.Saves()
	if len(saves) != 1 ||
		saves[0].CWD != initialCWD ||
		saves[0].AgentStatus != "running" {
		t.Fatalf(
			"successful saves = %#v, want stable CWD %q and running status",
			saves,
			initialCWD,
		)
	}
}

func TestFailedCWDChangeUnlocksBeforeDrainingLaterHandler(t *testing.T) {
	initialCWD := t.TempDir()
	failedCWD := t.TempDir()
	handlerCWD := t.TempDir()
	manager := NewManager("/bin/sh")
	manager.sessions["terminal"] = &entry{
		metadata: Metadata{
			ID:             "terminal",
			Name:           "Terminal",
			State:          StateRunning,
			CWD:            initialCWD,
			RepoRoot:       initialCWD,
			NeedsAttention: true,
			CreatedAt:      time.Now().UTC(),
		},
	}
	firstErr := errors.New("cwd save failed")
	store := &gatedResultMetadataStore{
		recordingMetadataStore: recordingMetadataStore{},
		entered:                make(chan int, 2),
		releaseFirst:           make(chan struct{}),
		saveErrors:             []error{firstErr, nil},
	}
	manager.store = store

	handlerDone := make(chan error, 1)
	manager.SetChangeHandler(func(change Change) {
		if change.Sequence != 2 {
			return
		}
		_, err := manager.UpdateCWD("terminal", handlerCWD)
		handlerDone <- err
	})

	failedDone := make(chan error, 1)
	go func() {
		_, err := manager.UpdateCWD("terminal", failedCWD)
		failedDone <- err
	}()
	if call := <-store.entered; call != 1 {
		t.Fatalf("failed CWD Save() call = %d, want 1", call)
	}

	later := manager.updateForegroundProcessName("terminal", "vim")
	if later == nil || later.Sequence != 2 {
		t.Fatalf("later change = %#v, want sequence 2", later)
	}
	manager.emitChange(*later)
	close(store.releaseFirst)

	select {
	case err := <-failedDone:
		if !errors.Is(err, firstErr) {
			t.Fatalf("failed UpdateCWD() error = %v, want %v", err, firstErr)
		}
	case <-time.After(time.Second):
		t.Fatal("failed CWD skip deadlocked while draining a reentrant change handler")
	}
	if call := <-store.entered; call != 2 {
		t.Fatalf("handler CWD Save() call = %d, want 2", call)
	}
	if err := <-handlerDone; err != nil {
		t.Fatalf("handler UpdateCWD() error = %v", err)
	}
	metadata, _ := manager.Metadata("terminal")
	if metadata.CWD != handlerCWD {
		t.Fatalf("CWD = %q, want handler CWD %q", metadata.CWD, handlerCWD)
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

func TestUpdateCWDPreservesEquivalentLogicalPath(t *testing.T) {
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

	updated, err := manager.UpdateCWD(metadata.ID, target)
	if err != nil {
		t.Fatalf("UpdateCWD() error = %v", err)
	}
	if updated.CWD != link {
		t.Fatalf("CWD = %q, want logical path %q", updated.CWD, link)
	}
}

func TestListSamplesTheWorkingDirectoryOfALiveProcess(t *testing.T) {
	start := t.TempDir()
	moved := t.TempDir()
	manager := NewManager("/bin/sh")
	manager.cwdSampleInterval = 0
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Terminal", start)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	running, ok := manager.Get(metadata.ID)
	if !ok {
		t.Fatal("Get() ok = false, want the created terminal")
	}
	if _, err := running.Write([]byte("cd " + moved + "\n")); err != nil {
		t.Fatalf("Write(cd) error = %v", err)
	}

	waitFor(t, 5*time.Second, func() bool {
		listed := manager.List()
		return len(listed) == 1 && sameDirectory(t, listed[0].CWD, moved)
	})
}

func TestListLeavesAFreshlyReportedWorkingDirectoryAlone(t *testing.T) {
	start := t.TempDir()
	reported := t.TempDir()
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Terminal", start)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := manager.UpdateCWD(metadata.ID, reported); err != nil {
		t.Fatalf("UpdateCWD() error = %v", err)
	}

	listed := manager.List()
	if len(listed) != 1 || listed[0].CWD != reported {
		t.Fatalf("List() cwd = %#v, want the reported %q", listed, reported)
	}
}

func TestListKeepsTheWorkingDirectoryAnAgentReported(t *testing.T) {
	start := t.TempDir()
	reported := t.TempDir()
	manager := NewManager("/bin/sh")
	manager.cwdSampleInterval = 0
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Terminal", start)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := manager.UpdateAgent(metadata.ID, AgentUpdate{
		Agent: "claude", Status: "running", CWD: reported,
	}); err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}

	listed := manager.List()
	if len(listed) != 1 || listed[0].CWD != reported {
		t.Fatalf("List() cwd = %#v, want the agent's %q", listed, reported)
	}
}

// sameDirectory compares two paths that may disagree on symlink spelling: a
// shell keeps the logical path it was handed while the kernel reports the
// physical one, and macOS temporary directories differ by exactly that.
func sameDirectory(t *testing.T, left, right string) bool {
	t.Helper()
	if left == right {
		return true
	}
	leftInfo, leftErr := os.Stat(left)
	rightInfo, rightErr := os.Stat(right)
	return leftErr == nil && rightErr == nil && os.SameFile(leftInfo, rightInfo)
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

func TestUpdateAgentMarksEnteringBlockedAsNeedingAttention(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	updated, err := manager.UpdateAgent(metadata.ID, AgentUpdate{
		Agent: "codex", Status: "blocked", Title: "Request permission",
	})
	if err != nil {
		t.Fatalf("UpdateAgent(blocked) error = %v", err)
	}
	if updated.AgentStatus != "blocked" || !updated.NeedsAttention {
		t.Fatalf("updated metadata = %#v, want blocked with attention", updated)
	}

	acknowledged, err := manager.AcknowledgeAttention(metadata.ID)
	if err != nil {
		t.Fatalf("AcknowledgeAttention() error = %v", err)
	}
	if acknowledged.NeedsAttention {
		t.Fatal("NeedsAttention = true after acknowledgement, want false")
	}

	repeated, err := manager.UpdateAgent(metadata.ID, AgentUpdate{
		Agent: "codex", Status: "blocked",
	})
	if err != nil {
		t.Fatalf("UpdateAgent(blocked again) error = %v", err)
	}
	if repeated.NeedsAttention {
		t.Fatal("NeedsAttention = true for repeated blocked status, want false")
	}
}

func TestCodexBlockedStatusReconcilesFromTranscript(t *testing.T) {
	transcriptPath := filepath.Join(t.TempDir(), "rollout-session-1.jsonl")
	initial := `{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}` + "\n"
	if err := os.WriteFile(transcriptPath, []byte(initial), 0o600); err != nil {
		t.Fatalf("WriteFile(transcript) error = %v", err)
	}

	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Codex")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := manager.UpdateAgent(metadata.ID, AgentUpdate{
		Agent: "codex", AgentSessionID: "session-1", TranscriptPath: transcriptPath,
		Status: "running",
	}); err != nil {
		t.Fatalf("UpdateAgent(running) error = %v", err)
	}
	blocked, err := manager.UpdateAgent(metadata.ID, AgentUpdate{Agent: "codex", Status: "blocked"})
	if err != nil {
		t.Fatalf("UpdateAgent(blocked) error = %v", err)
	}
	if blocked.AgentStatus != "blocked" {
		t.Fatalf("blocked status = %q, want blocked", blocked.AgentStatus)
	}
	if err := appendSessionTestTranscript(transcriptPath,
		`{"type":"event_msg","payload":{"type":"exec_approval_request","call_id":"call-1"}}`+"\n"+
			`{"type":"response_item","payload":{"type":"function_call","call_id":"call-1","name":"shell","arguments":"{}"}}`+"\n",
	); err != nil {
		t.Fatalf("append transient events: %v", err)
	}
	time.Sleep(200 * time.Millisecond)
	current, ok := manager.Metadata(metadata.ID)
	if !ok || current.AgentStatus != "blocked" {
		t.Fatalf("status after transient events = %#v, want blocked", current)
	}

	if err := appendSessionTestTranscript(transcriptPath,
		`{"type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"ok"}}`+"\n",
	); err != nil {
		t.Fatalf("append progress: %v", err)
	}
	waitFor(t, 2*time.Second, func() bool {
		current, ok := manager.Metadata(metadata.ID)
		return ok && current.AgentStatus == "running"
	})
	current, ok = manager.Metadata(metadata.ID)
	if !ok || !current.NeedsAttention {
		t.Fatalf("metadata after activity = %#v, want attention preserved", current)
	}
}

func appendSessionTestTranscript(path, content string) error {
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.WriteString(content); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
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

func TestCreateWithoutWorkingDirectoryUsesHomeDirectory(t *testing.T) {
	home := t.TempDir()
	processCWD := t.TempDir()
	t.Setenv("HOME", home)
	t.Chdir(processCWD)

	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	metadata, err := manager.Create(context.Background(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if metadata.CWD != home {
		t.Fatalf("CWD = %q, want home %q", metadata.CWD, home)
	}

	running, _ := manager.Get(metadata.ID)
	_, output, unsubscribe := running.Subscribe()
	defer unsubscribe()
	if _, err := running.Write([]byte("pwd\n")); err != nil {
		t.Fatalf("Write(pwd) error = %v", err)
	}
	got := receiveUntil(t, output, home, 3*time.Second)
	if !strings.Contains(got, home) {
		t.Fatalf("pwd output = %q, want home %q", got, home)
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

func TestListRefreshesCodexTitleFromTranscript(t *testing.T) {
	root := t.TempDir()
	indexPath := filepath.Join(root, "session_index.jsonl")
	transcriptPath := filepath.Join(root, "rollout-session.jsonl")
	if err := os.WriteFile(transcriptPath, []byte(
		`{"type":"event_msg","payload":{"type":"thread_name_updated","thread_id":"codex-session","thread_name":"Generated from prompt"}}`+"\n",
	), 0o600); err != nil {
		t.Fatalf("WriteFile(transcript) error = %v", err)
	}
	manager := NewManager("/bin/sh", HookConfig{CodexSessionIndex: indexPath})
	manager.sessions["terminal-1"] = &entry{metadata: Metadata{
		ID: "terminal-1", Name: "Terminal", State: StateRunning,
		Agent: "codex", AgentSessionID: "codex-session",
		AgentTranscriptPath: transcriptPath, CreatedAt: time.Now().UTC(),
	}}

	items := manager.List()

	if len(items) != 1 || items[0].AgentTitle != "Generated from prompt" {
		t.Fatalf("List() = %#v, want Codex transcript title", items)
	}
}

func TestListRefreshesCodexTitleFromLargeTranscriptHeader(t *testing.T) {
	root := t.TempDir()
	indexPath := filepath.Join(root, "session_index.jsonl")
	transcriptPath := filepath.Join(root, "rollout-session.jsonl")
	transcript := `{"type":"event_msg","payload":{"type":"thread_name_updated","thread_id":"codex-session","thread_name":"Generated early"}}` +
		"\n" + strings.Repeat("x", 2<<20)
	if err := os.WriteFile(transcriptPath, []byte(transcript), 0o600); err != nil {
		t.Fatalf("WriteFile(transcript) error = %v", err)
	}
	manager := NewManager("/bin/sh", HookConfig{CodexSessionIndex: indexPath})
	manager.sessions["terminal-1"] = &entry{metadata: Metadata{
		ID: "terminal-1", Name: "Terminal", State: StateRunning,
		Agent: "codex", AgentSessionID: "codex-session",
		AgentTranscriptPath: transcriptPath, CreatedAt: time.Now().UTC(),
	}}

	items := manager.List()

	if len(items) != 1 || items[0].AgentTitle != "Generated early" {
		t.Fatalf("List() = %#v, want Codex header title", items)
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

func TestRefreshCodexTitlesDoesNotBlockMetadata(t *testing.T) {
	manager := NewManager("/bin/sh")
	manager.sessions["terminal"] = &entry{
		metadata: Metadata{
			ID:                  "terminal",
			Name:                "Terminal",
			State:               StateRunning,
			Agent:               "codex",
			AgentSessionID:      "session-1",
			AgentTranscriptPath: "/transcripts/session-1.jsonl",
			CreatedAt:           time.Now().UTC(),
		},
		codexTitleHeaderScanned: true,
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	manager.codexTitleResolver = func(path, sessionID string, fromStart bool) (string, error) {
		if path != "/transcripts/session-1.jsonl" || sessionID != "session-1" || fromStart {
			t.Errorf("resolver arguments = %q, %q, %t", path, sessionID, fromStart)
		}
		close(entered)
		<-release
		return "Resolved title", nil
	}

	refreshDone := make(chan struct{})
	go func() {
		manager.refreshCodexTitles()
		close(refreshDone)
	}()
	<-entered

	metadataDone := make(chan Metadata, 1)
	go func() {
		metadata, _ := manager.Metadata("terminal")
		metadataDone <- metadata
	}()
	select {
	case metadata := <-metadataDone:
		if metadata.AgentTitle != "" {
			t.Fatalf("AgentTitle during refresh = %q, want current snapshot", metadata.AgentTitle)
		}
	case <-time.After(250 * time.Millisecond):
		close(release)
		<-refreshDone
		t.Fatal("Metadata() blocked while Codex title resolution was active")
	}

	close(release)
	<-refreshDone
	metadata, _ := manager.Metadata("terminal")
	if metadata.AgentTitle != "Resolved title" {
		t.Fatalf("AgentTitle after refresh = %q, want %q", metadata.AgentTitle, "Resolved title")
	}
}

func TestRefreshCodexTitlesDiscardsStaleResolution(t *testing.T) {
	manager := NewManager("/bin/sh")
	manager.sessions["terminal"] = &entry{
		metadata: Metadata{
			ID:                  "terminal",
			Name:                "Terminal",
			State:               StateRunning,
			Agent:               "codex",
			AgentSessionID:      "session-1",
			AgentTranscriptPath: "/transcripts/session-1.jsonl",
			CreatedAt:           time.Now().UTC(),
		},
		codexTitleHeaderScanned: true,
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	manager.codexTitleResolver = func(string, string, bool) (string, error) {
		close(entered)
		<-release
		return "Stale title", nil
	}

	refreshDone := make(chan struct{})
	go func() {
		manager.refreshCodexTitles()
		close(refreshDone)
	}()
	<-entered

	metadataDone := make(chan struct{})
	go func() {
		_, _ = manager.Metadata("terminal")
		close(metadataDone)
	}()
	select {
	case <-metadataDone:
	case <-time.After(250 * time.Millisecond):
		close(release)
		<-refreshDone
		t.Fatal("Metadata() blocked while stale title resolution was active")
	}

	manager.mu.Lock()
	manager.sessions["terminal"].metadata.AgentSessionID = "session-2"
	manager.sessions["terminal"].metadata.AgentTranscriptPath = "/transcripts/session-2.jsonl"
	manager.mu.Unlock()
	close(release)
	<-refreshDone

	metadata, _ := manager.Metadata("terminal")
	if metadata.AgentTitle != "" {
		t.Fatalf("AgentTitle = %q, want stale resolution discarded", metadata.AgentTitle)
	}
}

func TestRefreshCodexTitlesDiscardsResolutionForReplacedEntry(t *testing.T) {
	manager := NewManager("/bin/sh")
	metadata := Metadata{
		ID:                  "terminal",
		Name:                "Terminal",
		State:               StateRunning,
		Agent:               "codex",
		AgentSessionID:      "session-1",
		AgentTranscriptPath: "/transcripts/session-1.jsonl",
		CreatedAt:           time.Now().UTC(),
	}
	original := &entry{
		metadata:                metadata,
		codexTitleHeaderScanned: true,
	}
	manager.sessions[metadata.ID] = original
	entered := make(chan struct{})
	release := make(chan struct{})
	manager.codexTitleResolver = func(string, string, bool) (string, error) {
		close(entered)
		<-release
		return "Old entry title", nil
	}

	refreshDone := make(chan struct{})
	go func() {
		manager.refreshCodexTitles()
		close(refreshDone)
	}()
	<-entered
	manager.mu.Lock()
	replacement := &entry{
		metadata:                metadata,
		codexTitleHeaderScanned: true,
	}
	manager.sessions[metadata.ID] = replacement
	manager.mu.Unlock()
	close(release)
	<-refreshDone

	current, ok := manager.Metadata(metadata.ID)
	if !ok || current.AgentTitle != "" {
		t.Fatalf("replacement metadata = %#v, %t; want old resolution discarded", current, ok)
	}
}

func TestListWaitsForInFlightMetadataRefresh(t *testing.T) {
	manager := NewManager("/bin/sh")
	manager.sessions["terminal"] = &entry{
		metadata: Metadata{
			ID:                  "terminal",
			Name:                "Terminal",
			State:               StateRunning,
			Agent:               "codex",
			AgentSessionID:      "session-1",
			AgentTranscriptPath: "/transcripts/session-1.jsonl",
			CreatedAt:           time.Now().UTC(),
		},
		codexTitleHeaderScanned: true,
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	manager.codexTitleResolver = func(string, string, bool) (string, error) {
		close(entered)
		<-release
		return "Refreshed title", nil
	}

	manager.RefreshMetadata()
	<-entered
	listDone := make(chan []Metadata, 1)
	go func() {
		listDone <- manager.List()
	}()
	select {
	case items := <-listDone:
		close(release)
		t.Fatalf("List() returned before active refresh: %#v", items)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	select {
	case items := <-listDone:
		if len(items) != 1 || items[0].AgentTitle != "Refreshed title" {
			t.Fatalf("List() after refresh = %#v", items)
		}
	case <-time.After(time.Second):
		t.Fatal("List() did not return after active refresh completed")
	}
}

func TestMetadataRefreshChangeHandlerCanCallList(t *testing.T) {
	manager := NewManager("/bin/sh")
	manager.sessions["terminal"] = &entry{
		metadata: Metadata{
			ID:                  "terminal",
			Name:                "Terminal",
			State:               StateRunning,
			Agent:               "codex",
			AgentSessionID:      "session-1",
			AgentTranscriptPath: "/transcripts/session-1.jsonl",
			CreatedAt:           time.Now().UTC(),
		},
		codexTitleHeaderScanned: true,
	}
	manager.codexTitleResolver = func(string, string, bool) (string, error) {
		return "Refreshed title", nil
	}
	handlerDone := make(chan []Metadata, 1)
	manager.SetChangeHandler(func(Change) {
		handlerDone <- manager.List()
	})

	manager.RefreshMetadata()
	select {
	case items := <-handlerDone:
		if len(items) != 1 || items[0].AgentTitle != "Refreshed title" {
			t.Fatalf("List() from change handler = %#v", items)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("change handler deadlocked when it called List() during refresh")
	}
}

func TestCloseWaitsForMetadataRefreshAndPreventsLateEffects(t *testing.T) {
	manager := NewManager("/bin/sh")
	metadata, err := manager.Create(context.Background(), "Terminal", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := manager.UpdateAgent(metadata.ID, AgentUpdate{
		Agent:          "codex",
		AgentSessionID: "session-1",
		TranscriptPath: "/transcripts/session-1.jsonl",
		Status:         "running",
	}); err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
	store := &recordingMetadataStore{}
	manager.store = store
	entered := make(chan struct{})
	release := make(chan struct{})
	var resolverMu sync.Mutex
	resolverCalls := 0
	manager.codexTitleResolver = func(string, string, bool) (string, error) {
		resolverMu.Lock()
		resolverCalls++
		call := resolverCalls
		resolverMu.Unlock()
		if call == 1 {
			close(entered)
		}
		<-release
		return "Late title", nil
	}
	var changeMu sync.Mutex
	changeCount := 0
	manager.SetChangeHandler(func(Change) {
		changeMu.Lock()
		changeCount++
		changeMu.Unlock()
	})

	manager.RefreshMetadata()
	<-entered
	closeContext, cancelClose := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancelClose()
	closeDone := make(chan error, 1)
	go func() {
		closeDone <- manager.Close(closeContext)
	}()
	waitFor(t, time.Second, func() bool {
		manager.mu.RLock()
		closing := manager.closing
		manager.mu.RUnlock()
		return closing
	})
	select {
	case err := <-closeDone:
		close(release)
		t.Fatalf("Close() returned before active refresh was released: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	select {
	case err := <-closeDone:
		if err != nil {
			t.Fatalf("Close() error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Close() did not join active metadata refresh")
	}

	current, ok := manager.Metadata(metadata.ID)
	if !ok || current.AgentTitle != "" {
		t.Fatalf("metadata after Close() = %#v, %t; want no late title", current, ok)
	}
	if got := store.SaveCount(); got != 0 {
		t.Fatalf("store saves after Close() = %d, want 0", got)
	}
	changeMu.Lock()
	defer changeMu.Unlock()
	if changeCount != 0 {
		t.Fatalf("emitted changes after Close() = %d, want 0", changeCount)
	}
	manager.RefreshMetadata()
	time.Sleep(50 * time.Millisecond)
	resolverMu.Lock()
	defer resolverMu.Unlock()
	if resolverCalls != 1 {
		t.Fatalf("resolver calls after Close() = %d, want 1", resolverCalls)
	}
}

func TestRefreshCodexTitlesDoesNotBlockListCurrentDuringStoreSave(t *testing.T) {
	manager := NewManager("/bin/sh")
	manager.sessions["terminal"] = &entry{
		metadata: Metadata{
			ID:                  "terminal",
			Name:                "Terminal",
			State:               StateRunning,
			Agent:               "codex",
			AgentSessionID:      "session-1",
			AgentTranscriptPath: "/transcripts/session-1.jsonl",
			CreatedAt:           time.Now().UTC(),
		},
		codexTitleHeaderScanned: true,
	}
	storeStarted := make(chan struct{})
	storeRelease := make(chan struct{})
	manager.store = &recordingMetadataStore{
		started: storeStarted,
		release: storeRelease,
	}
	manager.codexTitleResolver = func(string, string, bool) (string, error) {
		return "Persisted title", nil
	}

	manager.RefreshMetadata()
	<-storeStarted
	listDone := make(chan []Metadata, 1)
	go func() {
		listDone <- manager.ListCurrent()
	}()
	select {
	case items := <-listDone:
		if len(items) != 1 || items[0].AgentTitle != "Persisted title" {
			close(storeRelease)
			t.Fatalf("ListCurrent() during Save() = %#v", items)
		}
	case <-time.After(100 * time.Millisecond):
		close(storeRelease)
		<-listDone
		t.Fatal("ListCurrent() blocked while metadata Save() was active")
	}
	close(storeRelease)
	waitFor(t, time.Second, func() bool {
		manager.refreshMu.Lock()
		done := manager.refreshDone
		manager.refreshMu.Unlock()
		return done == nil
	})
}

func TestMetadataPersistencePreservesUpdateOrder(t *testing.T) {
	manager := NewManager("/bin/sh")
	manager.sessions["terminal"] = &entry{
		metadata: Metadata{
			ID:                  "terminal",
			Name:                "Terminal",
			State:               StateRunning,
			Agent:               "codex",
			AgentSessionID:      "session-1",
			AgentTranscriptPath: "/transcripts/session-1.jsonl",
			CreatedAt:           time.Now().UTC(),
		},
		codexTitleHeaderScanned: true,
	}
	store := &orderedMetadataStore{
		entered:      make(chan int, 2),
		releaseFirst: make(chan struct{}),
	}
	manager.store = store
	manager.codexTitleResolver = func(string, string, bool) (string, error) {
		return "Resolved title", nil
	}

	manager.RefreshMetadata()
	if call := <-store.entered; call != 1 {
		t.Fatalf("first Save() call = %d", call)
	}
	updateDone := make(chan error, 1)
	go func() {
		_, err := manager.UpdateAgent("terminal", AgentUpdate{
			Agent:          "codex",
			AgentSessionID: "session-1",
			TranscriptPath: "/transcripts/session-1.jsonl",
			Status:         "waiting",
		})
		updateDone <- err
	}()
	select {
	case call := <-store.entered:
		close(store.releaseFirst)
		<-updateDone
		t.Fatalf("Save() call %d entered before the older title Save() completed", call)
	case <-time.After(100 * time.Millisecond):
	}

	close(store.releaseFirst)
	select {
	case err := <-updateDone:
		if err != nil {
			t.Fatalf("UpdateAgent() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("UpdateAgent() did not complete after persistence was released")
	}
	if call := <-store.entered; call != 2 {
		t.Fatalf("second Save() call = %d", call)
	}
	saves := store.Saves()
	if len(saves) != 2 ||
		saves[0].AgentTitle != "Resolved title" ||
		saves[1].AgentTitle != "Resolved title" ||
		saves[1].AgentStatus != "waiting" {
		t.Fatalf("persisted metadata order = %#v", saves)
	}
}

func TestMetadataPersistenceSerializesTitleBeforeNewerUpdate(t *testing.T) {
	manager := NewManager("/bin/sh")
	manager.sessions["terminal"] = codexTitleTestEntry()
	store := newGapMetadataStore()
	manager.store = store
	manager.codexTitleResolver = func(string, string, bool) (string, error) {
		return "Resolved title", nil
	}
	reserved := make(chan uint64, 2)
	releaseFirst := make(chan struct{})
	manager.beforeStoreOperation = func(sequence uint64) {
		reserved <- sequence
		if sequence == 1 {
			<-releaseFirst
		}
	}

	manager.RefreshMetadata()
	requireStoreReservation(t, reserved, 1)
	updateDone := make(chan error, 1)
	go func() {
		_, err := manager.UpdateAgent("terminal", AgentUpdate{
			Agent:          "codex",
			AgentSessionID: "session-1",
			TranscriptPath: "/transcripts/session-1.jsonl",
			Status:         "waiting",
		})
		updateDone <- err
	}()
	select {
	case sequence := <-reserved:
		close(releaseFirst)
		<-updateDone
		t.Fatalf(
			"store operation %d was reserved before the older metadata Save completed",
			sequence,
		)
	case <-time.After(100 * time.Millisecond):
	}
	listDone := make(chan []Metadata, 1)
	go func() {
		listDone <- manager.ListCurrent()
	}()
	select {
	case items := <-listDone:
		if len(items) != 1 ||
			items[0].AgentTitle != "Resolved title" ||
			items[0].AgentStatus != "" {
			close(releaseFirst)
			t.Fatalf("ListCurrent() during older metadata Save = %#v", items)
		}
	case <-time.After(100 * time.Millisecond):
		close(releaseFirst)
		<-updateDone
		t.Fatal("ListCurrent() blocked while a newer persistence job waited")
	}
	close(releaseFirst)
	requireStoreReservation(t, reserved, 2)
	if err := <-updateDone; err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
	waitFor(t, time.Second, func() bool {
		return len(store.Operations()) == 2
	})

	operations := store.Operations()
	if operations[0] != "save:Resolved title:" ||
		operations[1] != "save:Resolved title:waiting" {
		t.Fatalf("persistence operations = %#v, want title save before update", operations)
	}
}

func TestMetadataPersistenceReservesTitleBeforeNewerDelete(t *testing.T) {
	manager := NewManager("/bin/sh")
	item := codexTitleTestEntry()
	item.session = &Session{
		command:  exec.Command("/bin/sh"),
		waitDone: closedTestChannel(),
	}
	manager.sessions["terminal"] = item
	store := newGapMetadataStore()
	manager.store = store
	manager.codexTitleResolver = func(string, string, bool) (string, error) {
		return "Resolved title", nil
	}
	reserved := make(chan uint64, 2)
	releaseFirst := make(chan struct{})
	manager.beforeStoreOperation = func(sequence uint64) {
		reserved <- sequence
		if sequence == 1 {
			<-releaseFirst
		}
	}

	manager.RefreshMetadata()
	requireStoreReservation(t, reserved, 1)
	deleteDone := make(chan error, 1)
	go func() {
		deleteDone <- manager.Delete("terminal")
	}()
	requireStoreReservation(t, reserved, 2)
	close(releaseFirst)
	if err := <-deleteDone; err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	waitFor(t, time.Second, func() bool {
		return len(store.Operations()) == 2
	})

	operations := store.Operations()
	if operations[0] != "save:Resolved title:" || operations[1] != "delete:terminal" {
		t.Fatalf("persistence operations = %#v, want title save before delete", operations)
	}
	if store.Has("terminal") {
		t.Fatal("deleted terminal was resurrected by an older title save")
	}
}

func TestCloseCleansUpCreateBlockedInPersistence(t *testing.T) {
	pidPath := filepath.Join(t.TempDir(), "shell.pid")
	shellPath := filepath.Join(t.TempDir(), "blocked-create-shell")
	databasePath := filepath.Join(t.TempDir(), "euphony.sqlite3")
	script := fmt.Sprintf(
		"#!/bin/sh\nprintf '%%s\\n' \"$$\" > %q\nwhile :; do sleep 1; done\n",
		pidPath,
	)
	if err := os.WriteFile(shellPath, []byte(script), 0o700); err != nil {
		t.Fatalf("write shell script: %v", err)
	}
	sqliteStore, err := OpenSQLiteStore(databasePath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	store := &gatedSaveMetadataStore{
		metadataStore: sqliteStore,
		saveEntered:   make(chan struct{}),
		saveRelease:   make(chan struct{}),
	}
	manager := NewManager(shellPath)
	manager.store = store

	createDone := make(chan error, 1)
	go func() {
		_, err := manager.Create(context.Background(), "Blocked create")
		createDone <- err
	}()
	select {
	case <-store.saveEntered:
	case <-time.After(time.Second):
		t.Fatal("Create() did not enter persistence")
	}
	var pid int
	waitFor(t, time.Second, func() bool {
		data, err := os.ReadFile(pidPath)
		if err != nil {
			return false
		}
		_, err = fmt.Sscanf(strings.TrimSpace(string(data)), "%d", &pid)
		return err == nil && pid > 0
	})

	closeDone := make(chan error, 1)
	go func() {
		closeDone <- manager.Close(context.Background())
	}()
	select {
	case err := <-closeDone:
		t.Fatalf("Close() returned while Create persistence was blocked: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(store.saveRelease)
	if err := <-createDone; !errors.Is(err, ErrManagerClosing) {
		t.Fatalf("Create() error = %v, want ErrManagerClosing", err)
	}
	if err := <-closeDone; err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	reopened, err := OpenSQLiteStore(databasePath)
	if err != nil {
		t.Fatalf("reopen SQLite store: %v", err)
	}
	defer reopened.Close()
	persisted, err := reopened.Load(context.Background())
	if err != nil {
		t.Fatalf("load persisted terminals: %v", err)
	}
	if len(persisted) != 0 {
		t.Fatalf("persisted terminals = %#v, want none after rejected Create", persisted)
	}
	waitFor(t, time.Second, func() bool {
		return errors.Is(unix.Kill(pid, 0), unix.ESRCH)
	})
}

func TestDeleteFailureDuringCloseDoesNotRestoreSession(t *testing.T) {
	manager := NewManager("/bin/sh")
	metadata, err := manager.Create(context.Background(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	running, ok := manager.Get(metadata.ID)
	if !ok {
		t.Fatal("created terminal is missing")
	}
	deleteErr := errors.New("delete failed")
	store := newLifecycleMetadataStore()
	store.deleteEntered = make(chan struct{})
	store.deleteRelease = make(chan struct{})
	store.deleteErr = deleteErr
	manager.store = store

	deleteDone := make(chan error, 1)
	go func() {
		deleteDone <- manager.Delete(metadata.ID)
	}()
	select {
	case <-store.deleteEntered:
	case <-time.After(time.Second):
		t.Fatal("Delete() did not enter persistence")
	}
	closeDone := make(chan error, 1)
	go func() {
		closeDone <- manager.Close(context.Background())
	}()
	waitFor(t, time.Second, func() bool {
		manager.mu.RLock()
		defer manager.mu.RUnlock()
		return manager.closing
	})
	close(store.deleteRelease)
	if err := <-deleteDone; !errors.Is(err, deleteErr) {
		t.Fatalf("Delete() error = %v, want %v", err, deleteErr)
	}
	if err := <-closeDone; err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if _, ok := manager.Metadata(metadata.ID); ok {
		t.Fatal("failed Delete() restored the session after Close() began")
	}
	select {
	case <-running.waitDone:
	case <-time.After(time.Second):
		t.Fatal("session process survived failed Delete() and Close()")
	}
}

func TestCloseWaitsForDeleteProcessCleanup(t *testing.T) {
	for _, test := range []struct {
		name      string
		deleteErr error
	}{
		{name: "success"},
		{name: "persistence failure", deleteErr: errors.New("delete failed")},
	} {
		t.Run(test.name, func(t *testing.T) {
			manager := NewManager("/bin/sh")
			metadata, err := manager.Create(context.Background(), "Terminal")
			if err != nil {
				t.Fatalf("Create() error = %v", err)
			}
			running, ok := manager.Get(metadata.ID)
			if !ok {
				t.Fatal("created terminal is missing")
			}
			store := newLifecycleMetadataStore()
			store.deleteEntered = make(chan struct{})
			store.deleteRelease = make(chan struct{})
			store.deleteErr = test.deleteErr
			manager.store = store

			running.fileMu.Lock()
			fileLocked := true
			defer func() {
				if fileLocked {
					running.fileMu.Unlock()
				}
			}()
			deleteDone := make(chan error, 1)
			go func() {
				deleteDone <- manager.Delete(metadata.ID)
			}()
			<-store.deleteEntered
			closeDone := make(chan error, 1)
			go func() {
				closeDone <- manager.Close(context.Background())
			}()
			waitFor(t, time.Second, func() bool {
				manager.mu.RLock()
				defer manager.mu.RUnlock()
				return manager.closing
			})
			close(store.deleteRelease)
			select {
			case err := <-closeDone:
				running.fileMu.Unlock()
				fileLocked = false
				<-deleteDone
				t.Fatalf("Close() returned before Delete process cleanup completed: %v", err)
			case <-time.After(100 * time.Millisecond):
			}

			running.fileMu.Unlock()
			fileLocked = false
			if err := <-deleteDone; !errors.Is(err, test.deleteErr) {
				t.Fatalf("Delete() error = %v, want %v", err, test.deleteErr)
			}
			if err := <-closeDone; err != nil {
				t.Fatalf("Close() error = %v", err)
			}
			select {
			case <-running.waitDone:
			default:
				t.Fatal("session process was not joined before Close() returned")
			}
		})
	}
}

func TestCloseRetryWaitsForShutdownAfterFirstCallerTimesOut(t *testing.T) {
	manager := NewManager("/bin/sh")
	metadata, err := manager.Create(context.Background(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	manager.mu.Lock()
	item := manager.sessions[metadata.ID]
	item.metadata.Agent = "codex"
	item.metadata.AgentSessionID = "session-1"
	item.metadata.AgentTranscriptPath = "/transcripts/session-1.jsonl"
	item.codexTitleHeaderScanned = true
	manager.mu.Unlock()
	refreshEntered := make(chan struct{})
	refreshRelease := make(chan struct{})
	manager.codexTitleResolver = func(string, string, bool) (string, error) {
		close(refreshEntered)
		<-refreshRelease
		return "", nil
	}
	store := newLifecycleMetadataStore()
	manager.store = store
	barrierEntered := make(chan struct{})
	barrierRelease := make(chan struct{})
	manager.beforeStoreOperation = func(sequence uint64) {
		if sequence == 1 {
			close(barrierEntered)
			<-barrierRelease
		}
	}
	manager.RefreshMetadata()
	<-refreshEntered

	firstContext, cancelFirst := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancelFirst()
	if err := manager.Close(firstContext); !errors.Is(err, context.DeadlineExceeded) {
		close(refreshRelease)
		t.Fatalf("first Close() error = %v, want context deadline exceeded", err)
	}
	secondDone := make(chan error, 1)
	go func() {
		secondDone <- manager.Close(context.Background())
	}()
	select {
	case err := <-secondDone:
		close(refreshRelease)
		t.Fatalf("second Close() returned before refresh completed: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(refreshRelease)
	select {
	case <-barrierEntered:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not reach the persistence barrier")
	}
	select {
	case err := <-secondDone:
		close(barrierRelease)
		t.Fatalf("second Close() returned before persistence barrier completed: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(barrierRelease)
	if err := <-secondDone; err != nil {
		t.Fatalf("second Close() error = %v", err)
	}
}

func TestConcurrentCloseWaitsForSharedShutdownResult(t *testing.T) {
	manager := NewManager("/bin/sh")
	closeErr := errors.New("close failed")
	store := newLifecycleMetadataStore()
	store.closeErr = closeErr
	manager.store = store
	barrierEntered := make(chan struct{})
	barrierRelease := make(chan struct{})
	manager.beforeStoreOperation = func(sequence uint64) {
		if sequence == 1 {
			close(barrierEntered)
			<-barrierRelease
		}
	}
	firstDone := make(chan error, 1)
	go func() {
		firstDone <- manager.Close(context.Background())
	}()
	<-barrierEntered
	secondDone := make(chan error, 1)
	go func() {
		secondDone <- manager.Close(context.Background())
	}()
	select {
	case err := <-secondDone:
		close(barrierRelease)
		t.Fatalf("concurrent Close() returned before shared shutdown completed: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(barrierRelease)
	if err := <-firstDone; !errors.Is(err, closeErr) {
		t.Fatalf("first Close() error = %v, want %v", err, closeErr)
	}
	if err := <-secondDone; !errors.Is(err, closeErr) {
		t.Fatalf("second Close() error = %v, want %v", err, closeErr)
	}
}

func TestCreateChangeHandlerCanCloseManager(t *testing.T) {
	manager := NewManager("/bin/sh")
	store := newLifecycleMetadataStore()
	store.closeCalled = make(chan struct{})
	manager.store = store
	var running *Session
	closeResult := make(chan error, 1)
	manager.SetChangeHandler(func(change Change) {
		if change.Kind != ChangeCreated {
			return
		}
		running, _ = manager.Get(change.After.ID)
		closeResult <- manager.Close(context.Background())
	})

	createResult := make(chan error, 1)
	go func() {
		_, err := manager.Create(context.Background(), "Terminal")
		createResult <- err
	}()
	select {
	case err := <-createResult:
		if err != nil {
			t.Fatalf("Create() error = %v", err)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("Create change handler deadlocked when it called Close()")
	}
	if err := <-closeResult; err != nil {
		t.Fatalf("change-handler Close() error = %v", err)
	}
	if running == nil {
		t.Fatal("created session was not registered before the change callback")
	}
	select {
	case <-running.waitDone:
	default:
		t.Fatal("created process was not joined before callback Close() returned")
	}
	select {
	case <-store.closeCalled:
	default:
		t.Fatal("store was not closed before callback Close() returned")
	}
}

func TestRefreshChangeHandlerCanCloseManager(t *testing.T) {
	manager := NewManager("/bin/sh")
	manager.sessions["terminal"] = &entry{
		metadata: Metadata{
			ID:                  "terminal",
			Name:                "Terminal",
			State:               StateRunning,
			Agent:               "codex",
			AgentSessionID:      "session-1",
			AgentTranscriptPath: "/transcripts/session-1.jsonl",
			CreatedAt:           time.Now().UTC(),
		},
		session: &Session{
			command:  exec.Command("/bin/sh"),
			waitDone: closedTestChannel(),
		},
		codexTitleHeaderScanned: true,
	}
	manager.sessions["terminal-2"] = &entry{
		metadata: Metadata{
			ID:                  "terminal-2",
			Name:                "Terminal 2",
			State:               StateRunning,
			Agent:               "codex",
			AgentSessionID:      "session-2",
			AgentTranscriptPath: "/transcripts/session-2.jsonl",
			CreatedAt:           time.Now().UTC(),
		},
		session: &Session{
			command:  exec.Command("/bin/sh"),
			waitDone: closedTestChannel(),
		},
		codexTitleHeaderScanned: true,
	}
	manager.codexTitleResolver = func(string, string, bool) (string, error) {
		return "Resolved title", nil
	}
	closeResult := make(chan error, 1)
	var changedIDs []string
	manager.SetChangeHandler(func(change Change) {
		if change.Kind == ChangeUpdated {
			changedIDs = append(changedIDs, change.After.ID)
			closeResult <- manager.Close(context.Background())
		}
	})

	manager.RefreshMetadata()
	select {
	case err := <-closeResult:
		if err != nil {
			t.Fatalf("refresh change-handler Close() error = %v", err)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("refresh change handler deadlocked when it called Close()")
	}
	waitFor(t, time.Second, func() bool {
		manager.refreshMu.Lock()
		defer manager.refreshMu.Unlock()
		return manager.refreshDone == nil
	})
	if len(changedIDs) != 1 {
		t.Fatalf("refresh changes after callback Close() = %#v, want only the initiating change", changedIDs)
	}
}

func TestCloseSealsPersistenceQueueBeforeRejectingMutations(t *testing.T) {
	manager := NewManager("/bin/sh")
	item := codexTitleTestEntry()
	item.session = &Session{
		command:  exec.Command("/bin/sh"),
		waitDone: closedTestChannel(),
	}
	manager.sessions["terminal"] = item
	manager.store = newGapMetadataStore()
	reserved := make(chan uint64, 3)
	releaseClose := make(chan struct{})
	manager.beforeStoreOperation = func(sequence uint64) {
		reserved <- sequence
		if sequence == 1 {
			<-releaseClose
		}
	}

	closeDone := make(chan error, 1)
	go func() {
		closeDone <- manager.Close(context.Background())
	}()
	requireStoreReservation(t, reserved, 1)
	before, _ := manager.Metadata("terminal")

	updateDone := make(chan error, 1)
	go func() {
		_, err := manager.UpdateAgent("terminal", AgentUpdate{
			Agent:          "codex",
			AgentSessionID: "session-1",
			TranscriptPath: "/transcripts/session-1.jsonl",
			Status:         "waiting",
		})
		updateDone <- err
	}()
	select {
	case err := <-updateDone:
		if err == nil {
			close(releaseClose)
			<-closeDone
			t.Fatal("UpdateAgent() after Close() began error = nil")
		}
	case <-time.After(100 * time.Millisecond):
		close(releaseClose)
		<-closeDone
		<-updateDone
		t.Fatal("UpdateAgent() joined the queue after the close barrier")
	}

	if err := manager.SaveSelection(context.Background(), selection.State{Revision: 1}); err == nil {
		close(releaseClose)
		<-closeDone
		t.Fatal("SaveSelection() after Close() began error = nil")
	}
	after, _ := manager.Metadata("terminal")
	if after != before {
		close(releaseClose)
		<-closeDone
		t.Fatalf("metadata changed after Close() began: before %#v, after %#v", before, after)
	}
	select {
	case sequence := <-reserved:
		close(releaseClose)
		<-closeDone
		t.Fatalf("store operation %d reserved after close barrier", sequence)
	default:
	}
	close(releaseClose)
	if err := <-closeDone; err != nil {
		t.Fatalf("Close() error = %v", err)
	}
}

func TestStoreOperationHookPanicReleasesSuccessor(t *testing.T) {
	manager := NewManager("/bin/sh")
	manager.beforeStoreOperation = func(sequence uint64) {
		if sequence == 1 {
			panic("test hook panic")
		}
	}
	first := manager.reserveStoreOperation()
	second := manager.reserveStoreOperation()
	func() {
		defer func() {
			if recovered := recover(); recovered == nil {
				t.Fatal("runStoreOperation() did not propagate hook panic")
			}
		}()
		_ = manager.runStoreOperation(first, func() error {
			t.Fatal("persist ran after hook panic")
			return nil
		})
	}()

	secondDone := make(chan error, 1)
	go func() {
		secondDone <- manager.runStoreOperation(second, func() error {
			return nil
		})
	}()
	select {
	case err := <-secondDone:
		if err != nil {
			t.Fatalf("successor store operation error = %v", err)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("successor remained blocked after predecessor hook panic")
	}
}

func closedTestChannel() chan struct{} {
	done := make(chan struct{})
	close(done)
	return done
}

func codexTitleTestEntry() *entry {
	return &entry{
		metadata: Metadata{
			ID:                  "terminal",
			Name:                "Terminal",
			State:               StateRunning,
			Agent:               "codex",
			AgentSessionID:      "session-1",
			AgentTranscriptPath: "/transcripts/session-1.jsonl",
			CreatedAt:           time.Now().UTC(),
		},
		codexTitleHeaderScanned: true,
	}
}

func requireStoreReservation(t *testing.T, reserved <-chan uint64, want uint64) {
	t.Helper()
	select {
	case got := <-reserved:
		if got != want {
			t.Fatalf("store reservation = %d, want %d", got, want)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatalf("store operation %d was not reserved before I/O", want)
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
	if cols, rows := running.Dimensions(); cols != 80 || rows != 24 {
		t.Fatalf("initial Dimensions() = %dx%d, want 80x24", cols, rows)
	}
	if err := running.Resize(120, 40); err != nil {
		t.Fatalf("Resize(120, 40) error = %v", err)
	}
	if cols, rows := running.Dimensions(); cols != 120 || rows != 40 {
		t.Fatalf("Dimensions() after resize = %dx%d, want 120x40", cols, rows)
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
	if !strings.Contains(historyString(history), "before-reload\r\n") {
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

func TestSessionHistoryLimitRetainsNewestBytes(t *testing.T) {
	running := &Session{
		historyLimit: 5,
		subscribers:  make(map[uint64]*outputSubscriber),
	}

	running.publish([]byte("abc"))
	running.publish([]byte("def"))

	history, _, unsubscribe := running.Subscribe()
	defer unsubscribe()
	if got := historyString(history); got != "bcdef" {
		t.Fatalf("history = %q, want %q", got, "bcdef")
	}
}

func TestSessionHistorySnapshotUsesBoundedChunks(t *testing.T) {
	running := &Session{
		historyLimit: 128 * 1024,
		subscribers:  make(map[uint64]*outputSubscriber),
	}

	running.publish(make([]byte, 70*1024))

	history, _, unsubscribe := running.Subscribe()
	defer unsubscribe()
	if len(history) != 3 {
		t.Fatalf("history chunks = %d, want 3", len(history))
	}
	for index, chunk := range history {
		if len(chunk) > 32*1024 {
			t.Fatalf("history chunk %d length = %d, want at most 32768", index, len(chunk))
		}
	}
}

func TestHistorySnapshotReturnsLosslessTailWithoutAliasing(t *testing.T) {
	running := &Session{
		historyLimit: 16,
		subscribers:  make(map[uint64]*outputSubscriber),
	}
	running.publish([]byte{0xff, 0x00, 'a'})
	running.publish([]byte{'b', 'c'})

	got, truncated := running.HistorySnapshot(4)
	if !truncated || !reflect.DeepEqual(got, []byte{0x00, 'a', 'b', 'c'}) {
		t.Fatalf("HistorySnapshot() = %x, %t", got, truncated)
	}
	got[0] = 'x'
	again, _ := running.HistorySnapshot(4)
	if !reflect.DeepEqual(again, []byte{0x00, 'a', 'b', 'c'}) {
		t.Fatalf("HistorySnapshot() returned aliased bytes: %x", again)
	}
}

func TestForegroundIsShellTracksPTYForegroundProcessGroup(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Foreground", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	running, _ := manager.Get(metadata.ID)
	waitFor(t, time.Second, func() bool {
		available, checkErr := running.ForegroundIsShell()
		return checkErr == nil && available
	})
	if _, err := running.Write([]byte("sleep 2\n")); err != nil {
		t.Fatalf("Write(sleep) error = %v", err)
	}
	waitFor(t, time.Second, func() bool {
		available, checkErr := running.ForegroundIsShell()
		return checkErr == nil && !available
	})
}

func TestSessionWritePreservesBytesAcrossPTYBackpressure(t *testing.T) {
	directory := t.TempDir()
	ready := filepath.Join(directory, "ready")
	release := filepath.Join(directory, "release")
	output := filepath.Join(directory, "output")
	const payloadSize = 4 * 1024 * 1024
	command := exec.Command("/bin/sh", "-c",
		"stty raw -echo; touch \"$PTY_READY\"; "+
			"while [ ! -e \"$PTY_RELEASE\" ]; do sleep 0.01; done; "+
			"exec cat > \"$PTY_OUTPUT\"",
	)
	command.Env = append(os.Environ(),
		"PTY_READY="+ready,
		"PTY_RELEASE="+release,
		"PTY_OUTPUT="+output,
	)
	terminal, err := pty.Start(command)
	if err != nil {
		t.Fatalf("pty.Start() error = %v", err)
	}
	t.Cleanup(func() {
		_ = os.WriteFile(release, nil, 0o600)
		if command.Process != nil {
			_ = command.Process.Kill()
		}
		_ = terminal.Close()
		_ = command.Wait()
	})
	if err := unix.SetNonblock(int(terminal.Fd()), true); err != nil {
		t.Fatalf("SetNonblock() error = %v", err)
	}
	waitFor(t, time.Second, func() bool {
		_, statErr := os.Stat(ready)
		return statErr == nil
	})

	running := &Session{
		terminal:   terminal,
		terminalFD: int(terminal.Fd()),
		pumpDone:   make(chan struct{}),
	}
	payload := bytes.Repeat([]byte("0123456789abcdef"), payloadSize/16)
	type writeResult struct {
		n   int
		err error
	}
	writeDone := make(chan writeResult, 1)
	go func() {
		n, writeErr := running.Write(payload)
		writeDone <- writeResult{n: n, err: writeErr}
	}()

	select {
	case result := <-writeDone:
		t.Fatalf("Write() completed before backpressure release: n=%d, err=%v", result.n, result.err)
	case <-time.After(100 * time.Millisecond):
	}
	if err := os.WriteFile(release, nil, 0o600); err != nil {
		t.Fatalf("release PTY reader: %v", err)
	}
	var result writeResult
	select {
	case result = <-writeDone:
	case <-time.After(10 * time.Second):
		t.Fatal("Write() did not resume after the PTY reader was released")
	}
	if result.err != nil || result.n != len(payload) {
		t.Fatalf("Write() = %d, %v; want %d bytes", result.n, result.err, len(payload))
	}
	if err := terminal.Close(); err != nil {
		t.Fatalf("close PTY master: %v", err)
	}
	_ = command.Wait()
	got, err := os.ReadFile(output)
	if err != nil {
		t.Fatalf("read PTY output: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("PTY output mismatch: got %d bytes, want %d in original order", len(got), len(payload))
	}
}

func TestForegroundCommandDoesNotBlockTerminalWrite(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Foreground", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	running, _ := manager.Get(metadata.ID)

	runnerEntered := make(chan struct{})
	releaseRunner := make(chan struct{})
	var releaseOnce sync.Once
	release := func() {
		releaseOnce.Do(func() {
			close(releaseRunner)
		})
	}
	defer release()

	foregroundDone := make(chan error, 1)
	go func() {
		_, commandErr := running.foregroundCommand(func(int) ([]byte, error) {
			close(runnerEntered)
			<-releaseRunner
			return []byte("/bin/sh\n"), nil
		})
		foregroundDone <- commandErr
	}()
	<-runnerEntered

	writeDone := make(chan error, 1)
	go func() {
		_, writeErr := running.Write([]byte("x"))
		writeDone <- writeErr
	}()
	select {
	case writeErr := <-writeDone:
		if writeErr != nil {
			t.Fatalf("Write() error = %v", writeErr)
		}
	case <-time.After(250 * time.Millisecond):
		release()
		<-foregroundDone
		t.Fatal("terminal write blocked while foreground command runner was active")
	}

	release()
	if err := <-foregroundDone; err != nil {
		t.Fatalf("ForegroundCommand() error = %v", err)
	}
}

func TestForegroundProcessNameNormalizesCommand(t *testing.T) {

	tests := []struct {
		command string
		want    string
	}{
		{command: "/usr/bin/ps -ef", want: "ps"},
		{command: "codex resume abc", want: "codex"},
		{command: "-zsh", want: "zsh"},
		{command: "   ", want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.command, func(t *testing.T) {
			if got := foregroundProcessName(tt.command); got != tt.want {
				t.Fatalf("foregroundProcessName(%q) = %q, want %q", tt.command, got, tt.want)
			}
		})
	}
}

func TestListRefreshesForegroundProcessName(t *testing.T) {
	manager := NewManager("/bin/sh")
	manager.foregroundProcessSampleInterval = 0
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	metadata, err := manager.Create(context.Background(), "Terminal", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	running, ok := manager.Get(metadata.ID)
	if !ok {
		t.Fatal("Get() did not return the created terminal")
	}
	if _, err := running.Write([]byte("sleep 2\n")); err != nil {
		t.Fatalf("Write(sleep) error = %v", err)
	}

	waitFor(t, time.Second, func() bool {
		items := manager.List()
		return len(items) == 1 && items[0].ProcessName == "sleep"
	})
}

func TestSessionUnlimitedHistoryRetainsAllBytes(t *testing.T) {
	running := &Session{
		historyLimit: 0,
		subscribers:  make(map[uint64]*outputSubscriber),
	}

	running.publish([]byte("abc"))
	running.publish([]byte("def"))

	history, _, unsubscribe := running.Subscribe()
	defer unsubscribe()
	if got := historyString(history); got != "abcdef" {
		t.Fatalf("history = %q, want %q", got, "abcdef")
	}
}

func TestSubscriberBuffersLiveOutputWhileHistoryReplays(t *testing.T) {
	running := &Session{subscribers: make(map[uint64]*outputSubscriber)}
	_, output, unsubscribe := running.Subscribe()
	defer unsubscribe()

	const chunkCount = 80
	for index := range chunkCount {
		running.publish([]byte{byte(index)})
	}

	for index := range chunkCount {
		select {
		case chunk, ok := <-output:
			if !ok {
				t.Fatalf("output closed after %d chunks, want %d", index, chunkCount)
			}
			if len(chunk) != 1 || chunk[0] != byte(index) {
				t.Fatalf("chunk %d = %v, want [%d]", index, chunk, index)
			}
		case <-time.After(time.Second):
			t.Fatalf("timed out after %d chunks, want %d", index, chunkCount)
		}
	}
}

func TestTerminalEventSubscriberKeepsOutputAndResizeInCausalOrder(t *testing.T) {
	running := &Session{subscribers: make(map[uint64]*outputSubscriber)}
	_, events, _, enqueueResize, unsubscribe := running.SubscribeTerminalEventsWithStatus()
	defer unsubscribe()

	running.publish([]byte("before"))
	enqueueResize(80, 24)
	running.publish([]byte("after"))

	want := []TerminalEvent{
		{Data: []byte("before")},
		{Cols: 80, Rows: 24},
		{Data: []byte("after")},
	}
	for index, expected := range want {
		select {
		case event, ok := <-events:
			if !ok {
				t.Fatalf("events closed after %d events, want %d", index, len(want))
			}
			if !reflect.DeepEqual(event, expected) {
				t.Fatalf("event %d = %#v, want %#v", index, event, expected)
			}
		case <-time.After(time.Second):
			t.Fatalf("timed out after %d events, want %d", index, len(want))
		}
	}
}

func TestResizeOrdersCompletedPTYReadBeforeItsBoundary(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Ordered resize")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	running, _ := manager.Get(metadata.ID)
	_, events, _, enqueueResize, unsubscribe := running.SubscribeTerminalEventsWithStatus()
	defer unsubscribe()

	if _, err := running.Write([]byte("stty -echo; printf 'configured\\n'\n")); err != nil {
		t.Fatalf("Write(configure) error = %v", err)
	}
	for {
		select {
		case event := <-events:
			if bytes.Contains(event.Data, []byte("configured")) {
				goto configured
			}
		case <-time.After(3 * time.Second):
			t.Fatal("timed out configuring terminal")
		}
	}

configured:
	readPaused := make(chan struct{})
	resumeRead := make(chan struct{})
	var pauseOnce sync.Once
	running.setAfterReadHook(func(data []byte) {
		if bytes.Contains(data, []byte("X")) {
			pauseOnce.Do(func() {
				close(readPaused)
				<-resumeRead
			})
		}
	})
	defer running.setAfterReadHook(nil)
	if _, err := running.Write([]byte("printf X\n")); err != nil {
		t.Fatalf("Write(output) error = %v", err)
	}
	select {
	case <-readPaused:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for the PTY read to pause")
	}

	resizeDone := make(chan error, 1)
	go func() {
		resizeDone <- running.ResizeWithNotification(100, 30, func() {
			enqueueResize(100, 30)
		})
	}()
	waitFor(t, time.Second, func() bool {
		return len(running.resizeRequests) == 1
	})
	close(resumeRead)

	sawOutput := false
	for {
		select {
		case event := <-events:
			if bytes.Contains(event.Data, []byte("X")) {
				sawOutput = true
			}
			if event.Cols > 0 && event.Rows > 0 {
				if !sawOutput {
					t.Fatal("resize boundary arrived before the completed PTY read")
				}
				if event.Cols != 100 || event.Rows != 30 {
					t.Fatalf("resize = %dx%d, want 100x30", event.Cols, event.Rows)
				}
				goto resized
			}
		case <-time.After(3 * time.Second):
			t.Fatal("timed out waiting for ordered resize events")
		}
	}

resized:
	if err := <-resizeDone; err != nil {
		t.Fatalf("ResizeWithNotification() error = %v", err)
	}
}

func TestResizeWithNotificationContextCancelsPendingRequest(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Cancelable resize")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	running, _ := manager.Get(metadata.ID)

	readPaused := make(chan struct{})
	resumeRead := make(chan struct{})
	var pauseOnce sync.Once
	running.setAfterReadHook(func(data []byte) {
		if bytes.Contains(data, []byte("resize-cancel-marker")) {
			pauseOnce.Do(func() {
				close(readPaused)
				<-resumeRead
			})
		}
	})
	defer running.setAfterReadHook(nil)

	if _, err := running.Write([]byte("printf resize-cancel-marker\\n\n")); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	select {
	case <-readPaused:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for the PTY read to pause")
	}

	resizeContext, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	if err := running.ResizeWithNotificationContext(resizeContext, 100, 30, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("ResizeWithNotificationContext() error = %v, want deadline exceeded", err)
	}

	close(resumeRead)
	if err := running.Resize(90, 25); err != nil {
		t.Fatalf("Resize() after canceled request error = %v", err)
	}
}

func TestPTYDrainDoesNotBlockResizeAfterReadableData(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Nonblocking PTY")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	running, _ := manager.Get(metadata.ID)

	flags, err := unix.FcntlInt(uintptr(running.terminalFD), unix.F_GETFL, 0)
	if err != nil {
		t.Fatalf("F_GETFL error = %v", err)
	}
	if flags&unix.O_NONBLOCK == 0 {
		t.Fatal("PTY descriptor is blocking; drain can stall after readiness changes")
	}

	_, output, unsubscribe := running.Subscribe()
	defer unsubscribe()
	if _, err := running.Write([]byte("printf pty-drained\\n\n")); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	receiveUntil(t, output, "pty-drained", 3*time.Second)

	resizeContext, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := running.ResizeWithNotificationContext(resizeContext, 90, 25, nil); err != nil {
		t.Fatalf("Resize() after readable data error = %v", err)
	}
}

func TestDrainTerminalOutputTreatsWouldBlockAsDrained(t *testing.T) {
	pipe := []int{0, 0}
	if err := unix.Pipe(pipe); err != nil {
		t.Fatalf("Pipe() error = %v", err)
	}
	defer unix.Close(pipe[0])
	defer unix.Close(pipe[1])
	if err := unix.SetNonblock(pipe[0], true); err != nil {
		t.Fatalf("SetNonblock() error = %v", err)
	}
	running := &Session{
		terminalFD:  pipe[0],
		subscribers: make(map[uint64]*outputSubscriber),
	}

	closed, err := running.drainTerminalOutput(make([]byte, 32))
	if err != nil || closed {
		t.Fatalf("drainTerminalOutput() = closed %t, error %v; want drained and open", closed, err)
	}
}

func TestDuplicateTerminalFDIsCloseOnExec(t *testing.T) {
	pipe := []int{0, 0}
	if err := unix.Pipe(pipe); err != nil {
		t.Fatalf("Pipe() error = %v", err)
	}
	defer unix.Close(pipe[0])
	defer unix.Close(pipe[1])

	duplicate, err := duplicateTerminalFD(pipe[0])
	if err != nil {
		t.Fatalf("duplicateTerminalFD() error = %v", err)
	}
	defer unix.Close(duplicate)
	flags, err := unix.FcntlInt(uintptr(duplicate), unix.F_GETFD, 0)
	if err != nil {
		t.Fatalf("F_GETFD error = %v", err)
	}
	if flags&unix.FD_CLOEXEC == 0 {
		t.Fatal("duplicated terminal fd is inherited across exec")
	}
}

func TestContinuousPTYOutputDoesNotStarveResize(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Continuous output")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	running, _ := manager.Get(metadata.ID)
	if _, err := running.Write([]byte("yes x\n")); err != nil {
		t.Fatalf("Write(yes) error = %v", err)
	}
	time.Sleep(20 * time.Millisecond)

	resizeDone := make(chan error, 1)
	go func() {
		resizeDone <- running.Resize(100, 30)
	}()
	select {
	case err := <-resizeDone:
		if err != nil {
			t.Fatalf("Resize() error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("continuous PTY output starved resize")
	}
}

func TestSubscriberDisconnectsWhenLiveOutputQueueExceedsLimit(t *testing.T) {
	running := &Session{subscribers: make(map[uint64]*outputSubscriber)}
	_, output, lagged, unsubscribe := running.SubscribeWithStatus()
	defer unsubscribe()

	chunk := make([]byte, historyChunkSize)
	for range 80 {
		running.publish(chunk)
	}

	select {
	case <-lagged:
	case <-time.After(time.Second):
		t.Fatal("lagged signal was not closed after the queue exceeded its limit")
	}
	select {
	case _, ok := <-output:
		if ok {
			t.Fatal("output remained open after the subscriber fell behind")
		}
	case <-time.After(time.Second):
		t.Fatal("output did not close after the subscriber fell behind")
	}
}

func TestUnsubscribeAbortsSubscriberAfterProcessFinishes(t *testing.T) {
	running := &Session{subscribers: make(map[uint64]*outputSubscriber)}
	_, _, unsubscribe := running.Subscribe()
	subscriber := running.subscribers[0]

	running.outputMu.Lock()
	delete(running.subscribers, 0)
	subscriber.finish()
	running.outputMu.Unlock()
	unsubscribe()

	subscriber.mu.Lock()
	defer subscriber.mu.Unlock()
	if !subscriber.aborted {
		t.Fatal("subscriber was not aborted after it had been removed by process exit")
	}
}

func TestRegisterSessionAppliesLatestHistoryLimit(t *testing.T) {
	manager := NewManager("/bin/sh")
	settings := DefaultSettings()
	settings.TerminalHistoryLimit = 8 * 1024 * 1024
	if err := manager.UpdateSettings(context.Background(), settings); err != nil {
		t.Fatalf("UpdateSettings() error = %v", err)
	}
	running := &Session{subscribers: make(map[uint64]*outputSubscriber)}

	manager.registerSession("one", &entry{session: running})

	if running.historyLimit != settings.TerminalHistoryLimit {
		t.Fatalf(
			"history limit = %d, want latest setting %d",
			running.historyLimit,
			settings.TerminalHistoryLimit,
		)
	}
}

func TestUpdateSettingsTrimsHistoryForRunningSessions(t *testing.T) {
	manager := NewManager("/bin/sh")
	running := &Session{
		historyLimit: 10,
		history:      [][]byte{[]byte("0123456789")},
		historySize:  10,
		subscribers:  make(map[uint64]*outputSubscriber),
	}
	manager.sessions["one"] = &entry{session: running}
	settings := DefaultSettings()
	settings.TerminalHistoryLimit = 4

	if err := manager.UpdateSettings(context.Background(), settings); err != nil {
		t.Fatalf("UpdateSettings() error = %v", err)
	}

	history, _, unsubscribe := running.Subscribe()
	defer unsubscribe()
	if got := historyString(history); got != "6789" {
		t.Fatalf("history = %q, want %q", got, "6789")
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
	if !strings.Contains(historyString(history), "final-output\r\n") {
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

func historyString(history [][]byte) string {
	var result strings.Builder
	for _, chunk := range history {
		result.Write(chunk)
	}
	return result.String()
}

type recordingMetadataStore struct {
	mu      sync.Mutex
	saves   []Metadata
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

type orderedMetadataStore struct {
	recordingMetadataStore
	callMu       sync.Mutex
	calls        int
	entered      chan int
	releaseFirst chan struct{}
}

type gapMetadataStore struct {
	recordingMetadataStore
	operations []string
	records    map[string]Metadata
}

type lifecycleMetadataStore struct {
	recordingMetadataStore
	deleteEntered chan struct{}
	deleteRelease chan struct{}
	deleteErr     error
	closeErr      error
	closeCalled   chan struct{}
	deleteOnce    sync.Once
	closeOnce     sync.Once
}

type gatedSaveMetadataStore struct {
	metadataStore
	saveEntered chan struct{}
	saveRelease chan struct{}
	saveOnce    sync.Once
}

type failFirstSaveMetadataStore struct {
	recordingMetadataStore
	err   error
	calls int
}

type gatedResultMetadataStore struct {
	recordingMetadataStore
	entered      chan int
	releaseFirst chan struct{}
	saveErrors   []error
	callMu       sync.Mutex
	calls        int
}

func (s *gatedResultMetadataStore) Save(
	ctx context.Context,
	metadata Metadata,
) error {
	s.callMu.Lock()
	s.calls++
	call := s.calls
	var result error
	if call <= len(s.saveErrors) {
		result = s.saveErrors[call-1]
	}
	s.callMu.Unlock()
	s.entered <- call
	if call == 1 {
		<-s.releaseFirst
	}
	if result != nil {
		return result
	}
	return s.recordingMetadataStore.Save(ctx, metadata)
}

func (s *gatedResultMetadataStore) Saves() []Metadata {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Metadata(nil), s.saves...)
}

func (s *failFirstSaveMetadataStore) Save(
	ctx context.Context,
	metadata Metadata,
) error {
	s.calls++
	if s.calls == 1 {
		return s.err
	}
	return s.recordingMetadataStore.Save(ctx, metadata)
}

func (s *gatedSaveMetadataStore) Save(ctx context.Context, metadata Metadata) error {
	s.saveOnce.Do(func() { close(s.saveEntered) })
	<-s.saveRelease
	return s.metadataStore.Save(ctx, metadata)
}

func newLifecycleMetadataStore() *lifecycleMetadataStore {
	return &lifecycleMetadataStore{}
}

func (s *lifecycleMetadataStore) Delete(_ context.Context, id string) error {
	if s.deleteEntered != nil {
		s.deleteOnce.Do(func() { close(s.deleteEntered) })
	}
	if s.deleteRelease != nil {
		<-s.deleteRelease
	}
	if s.deleteErr != nil {
		return s.deleteErr
	}
	return nil
}

func (s *lifecycleMetadataStore) Close() error {
	if s.closeCalled != nil {
		s.closeOnce.Do(func() { close(s.closeCalled) })
	}
	return s.closeErr
}

func newGapMetadataStore() *gapMetadataStore {
	return &gapMetadataStore{records: make(map[string]Metadata)}
}

func (s *gapMetadataStore) Save(_ context.Context, metadata Metadata) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.operations = append(
		s.operations,
		"save:"+metadata.AgentTitle+":"+metadata.AgentStatus,
	)
	s.records[metadata.ID] = metadata
	return nil
}

func (s *gapMetadataStore) Delete(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.operations = append(s.operations, "delete:"+id)
	delete(s.records, id)
	return nil
}

func (s *gapMetadataStore) Operations() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.operations...)
}

func (s *gapMetadataStore) Has(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.records[id]
	return ok
}

func (s *orderedMetadataStore) Save(_ context.Context, metadata Metadata) error {
	s.callMu.Lock()
	s.calls++
	call := s.calls
	s.callMu.Unlock()
	s.entered <- call
	if call == 1 {
		<-s.releaseFirst
	}
	s.mu.Lock()
	s.saves = append(s.saves, metadata)
	s.mu.Unlock()
	return nil
}

func (s *orderedMetadataStore) Saves() []Metadata {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Metadata(nil), s.saves...)
}

func (s *recordingMetadataStore) Load(context.Context) ([]Metadata, error) {
	return nil, nil
}

func (s *recordingMetadataStore) Save(_ context.Context, metadata Metadata) error {
	if s.started != nil {
		s.once.Do(func() {
			close(s.started)
		})
	}
	if s.release != nil {
		<-s.release
	}
	s.mu.Lock()
	s.saves = append(s.saves, metadata)
	s.mu.Unlock()
	return nil
}

func (s *recordingMetadataStore) Delete(context.Context, string) error {
	return nil
}

func (s *recordingMetadataStore) LoadSettings(context.Context) (Settings, error) {
	return DefaultSettings(), nil
}

func (s *recordingMetadataStore) SaveSettings(context.Context, Settings) error {
	return nil
}

func (s *recordingMetadataStore) LoadSelection(context.Context) (selection.State, bool, error) {
	return selection.State{}, false, nil
}

func (s *recordingMetadataStore) SaveSelection(context.Context, selection.State) error {
	return nil
}

func (s *recordingMetadataStore) Close() error {
	return nil
}

func (s *recordingMetadataStore) SaveCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.saves)
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

func assertManagerReadsAndWritesPromptly(t *testing.T, manager *Manager, id string) {
	t.Helper()
	metadataDone := make(chan struct{})
	go func() {
		_, _ = manager.Metadata(id)
		close(metadataDone)
	}()
	select {
	case <-metadataDone:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("Metadata() blocked on external metadata resolution")
	}

	listDone := make(chan struct{})
	go func() {
		_ = manager.ListCurrent()
		close(listDone)
	}()
	select {
	case <-listDone:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("ListCurrent() blocked on external metadata resolution")
	}

	writeDone := make(chan error, 1)
	go func() {
		_, err := manager.WriteTerminal(id, nil)
		writeDone <- err
	}()
	select {
	case err := <-writeDone:
		if err != nil {
			t.Fatalf("WriteTerminal() error = %v", err)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("WriteTerminal() blocked on external metadata resolution")
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

func TestListRefreshesRenamedClaudeTitles(t *testing.T) {
	// `/rename` writes a custom-title entry to the transcript without firing any
	// Claude Code hook, so nothing reports it. Re-reading the transcript on list
	// is what keeps a renamed session's sidebar entry from going stale.
	transcript := filepath.Join(t.TempDir(), "claude-session.jsonl")
	if err := os.WriteFile(transcript, []byte(
		`{"type":"ai-title","aiTitle":"Old title","sessionId":"claude-session"}`+"\n",
	), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	manager := NewManager("/bin/sh")
	manager.sessions["terminal-1"] = &entry{metadata: Metadata{
		ID: "terminal-1", Name: "Terminal", State: StateRunning,
		Agent: "claude", AgentSessionID: "claude-session",
		AgentTranscriptPath: transcript,
		AgentTitle:          "Old title", CreatedAt: time.Now().UTC(),
	}}

	if items := manager.List(); len(items) != 1 || items[0].AgentTitle != "Old title" {
		t.Fatalf("List() = %#v, want the reported title", items)
	}

	if err := os.WriteFile(transcript, []byte(
		`{"type":"ai-title","aiTitle":"Old title","sessionId":"claude-session"}`+"\n"+
			`{"type":"custom-title","customTitle":"deploy","sessionId":"claude-session"}`+"\n",
	), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	manager.sessions["terminal-1"].claudeTitleSampledAt = time.Time{}

	items := manager.List()
	if len(items) != 1 || items[0].AgentTitle != "deploy" {
		t.Fatalf("List() = %#v, want the renamed Claude title", items)
	}
}

func TestListLeavesNonClaudeAndTitlelessTranscriptsAlone(t *testing.T) {
	transcript := filepath.Join(t.TempDir(), "claude-session.jsonl")
	if err := os.WriteFile(transcript, []byte(
		`{"type":"user","message":{"content":"hi"}}`+"\n",
	), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	manager := NewManager("/bin/sh")
	manager.sessions["terminal-1"] = &entry{metadata: Metadata{
		ID: "terminal-1", Name: "Terminal", State: StateRunning,
		Agent: "claude", AgentSessionID: "claude-session",
		AgentTranscriptPath: transcript,
		AgentTitle:          "Reported title", CreatedAt: time.Now().UTC(),
	}}
	manager.sessions["terminal-2"] = &entry{metadata: Metadata{
		ID: "terminal-2", Name: "Terminal", State: StateRunning,
		Agent: "codex", AgentSessionID: "codex-session",
		AgentTranscriptPath: transcript,
		AgentTitle:          "Codex title", CreatedAt: time.Now().UTC().Add(time.Second),
	}}

	items := manager.List()
	if len(items) != 2 {
		t.Fatalf("List() = %#v, want two terminals", items)
	}
	if items[0].AgentTitle != "Reported title" {
		t.Fatalf("titleless transcript overwrote reported title: %q", items[0].AgentTitle)
	}
	if items[1].AgentTitle != "Codex title" {
		t.Fatalf("Codex title read from a Claude transcript: %q", items[1].AgentTitle)
	}
}
