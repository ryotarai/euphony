package session

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestManagerArchivesPersistedAgentSessionByTerminalAndSessionIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "euphony.sqlite3")
	store, err := OpenSQLiteStore(path)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	createdAt := time.Now().UTC().Add(-time.Minute)
	if err := store.Save(context.Background(), Metadata{
		ID: "terminal-1", Name: "Archived rollout", State: StateExited,
		CWD: t.TempDir(), Agent: "codex", ResumeAgent: "codex",
		AgentSessionID: "agent-session-1", CreatedAt: createdAt, UpdatedAt: createdAt,
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	manager, err := NewPersistentManager("/bin/sh", HookConfig{}, path)
	if err != nil {
		t.Fatalf("NewPersistentManager() error = %v", err)
	}
	if _, err := manager.SetAgentSessionArchived("terminal-1", "wrong-session", true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("SetAgentSessionArchived() error = %v, want ErrNotFound", err)
	}
	archived, err := manager.SetAgentSessionArchived("terminal-1", "agent-session-1", true)
	if err != nil {
		t.Fatalf("SetAgentSessionArchived(true) error = %v", err)
	}
	if !archived.Archived {
		t.Fatalf("archived metadata = %#v, want archived", archived)
	}
	if err := manager.Close(context.Background()); err != nil {
		t.Fatalf("manager.Close() after archive error = %v", err)
	}
	manager, err = NewPersistentManager("/bin/sh", HookConfig{}, path)
	if err != nil {
		t.Fatalf("NewPersistentManager() after archive error = %v", err)
	}
	persisted := manager.ListPersisted()
	if len(persisted) != 1 || !persisted[0].Archived {
		t.Fatalf("persisted archived metadata = %#v, want one archived session", persisted)
	}
	if _, err := manager.SetAgentSessionArchived("terminal-1", "agent-session-1", false); err != nil {
		t.Fatalf("SetAgentSessionArchived(false) error = %v", err)
	}
	persisted = manager.ListPersisted()
	if len(persisted) != 1 || persisted[0].Archived {
		t.Fatalf("unarchived metadata = %#v, want one unarchived session", persisted)
	}
	if err := manager.Close(context.Background()); err != nil {
		t.Fatalf("manager.Close() error = %v", err)
	}
}

func TestListCurrentExcludesArchivedWhileStoredAndPersistedRetainIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "euphony.sqlite3")
	manager, err := NewPersistentManager("/bin/sh", HookConfig{}, path)
	if err != nil {
		t.Fatalf("NewPersistentManager() error = %v", err)
	}
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	metadata, err := manager.Create(context.Background(), "Kanban terminal", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := manager.UpdateAgent(metadata.ID, AgentUpdate{
		Agent: "codex", AgentSessionID: "kanban-session", Status: "waiting",
	}); err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
	if _, err := manager.SetAgentSessionArchived(metadata.ID, "kanban-session", true); err != nil {
		t.Fatalf("SetAgentSessionArchived() error = %v", err)
	}

	if current := manager.ListCurrent(); len(current) != 0 {
		t.Fatalf("ListCurrent() = %#v, want archived session excluded", current)
	}
	stored := manager.ListStored()
	if len(stored) != 1 || stored[0].ID != metadata.ID || !stored[0].Archived || stored[0].State != StateRunning {
		t.Fatalf("ListStored() = %#v, want archived open session retained", stored)
	}
	persisted := manager.ListPersisted()
	if len(persisted) != 1 || persisted[0].ID != metadata.ID || !persisted[0].Archived || persisted[0].State != StateRunning {
		t.Fatalf("ListPersisted() = %#v, want archived open session retained", persisted)
	}
}

func TestSetAgentSessionArchivedRejectsNonAgentIdentity(t *testing.T) {
	manager, err := NewPersistentManager("/bin/sh", HookConfig{}, filepath.Join(t.TempDir(), "euphony.sqlite3"))
	if err != nil {
		t.Fatalf("NewPersistentManager() error = %v", err)
	}
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	metadata, err := manager.Create(context.Background(), "Terminal with an unrelated session ID", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := manager.UpdateAgent(metadata.ID, AgentUpdate{
		AgentSessionID: "unrelated-session-id",
		Status:         "waiting",
	}); err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
	if _, err := manager.SetAgentSessionArchived(metadata.ID, "unrelated-session-id", true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("SetAgentSessionArchived() error = %v, want ErrNotFound", err)
	}
	current, ok := manager.Metadata(metadata.ID)
	if !ok || current.Archived {
		t.Fatalf("metadata after rejected archive = %#v, want an unarchived terminal", current)
	}
}
