package session

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestArchiveStaleWaitingAgentsStopsOnlyEligibleAgentsAndPersistsThem(t *testing.T) {
	manager, err := NewPersistentManager(
		"/bin/sh",
		HookConfig{},
		filepath.Join(t.TempDir(), "euphony.sqlite3"),
	)
	if err != nil {
		t.Fatalf("NewPersistentManager() error = %v", err)
	}
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	stale, err := manager.CreateWithCommandArgs(
		context.Background(), "Stale agent", t.TempDir(), "/bin/sh", "-c", "sleep 30",
	)
	if err != nil {
		t.Fatalf("CreateWithCommandArgs(stale) error = %v", err)
	}
	stale, err = manager.UpdateAgent(stale.ID, AgentUpdate{
		Agent: "codex", AgentSessionID: "stale-session", Status: "waiting",
	})
	if err != nil {
		t.Fatalf("UpdateAgent(stale) error = %v", err)
	}

	recent, err := manager.CreateWithCommandArgs(
		context.Background(), "Recent agent", t.TempDir(), "/bin/sh", "-c", "sleep 30",
	)
	if err != nil {
		t.Fatalf("CreateWithCommandArgs(recent) error = %v", err)
	}
	if _, err := manager.UpdateAgent(recent.ID, AgentUpdate{
		Agent: "claude", AgentSessionID: "recent-session", Status: "waiting",
	}); err != nil {
		t.Fatalf("UpdateAgent(recent) error = %v", err)
	}

	running, err := manager.CreateWithCommandArgs(
		context.Background(), "Running agent", t.TempDir(), "/bin/sh", "-c", "sleep 30",
	)
	if err != nil {
		t.Fatalf("CreateWithCommandArgs(running) error = %v", err)
	}
	if _, err := manager.UpdateAgent(running.ID, AgentUpdate{
		Agent: "codex", AgentSessionID: "running-session", Status: "running",
	}); err != nil {
		t.Fatalf("UpdateAgent(running) error = %v", err)
	}

	bare, err := manager.CreateWithCommandArgs(
		context.Background(), "Bare terminal", t.TempDir(), "/bin/sh", "-c", "sleep 30",
	)
	if err != nil {
		t.Fatalf("CreateWithCommandArgs(bare) error = %v", err)
	}
	if _, err := manager.ArchiveAgentSession(bare.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ArchiveAgentSession(bare) error = %v, want ErrNotFound", err)
	}

	unidentified, err := manager.CreateWithCommandArgs(
		context.Background(), "Unidentified agent", t.TempDir(), "/bin/sh", "-c", "sleep 30",
	)
	if err != nil {
		t.Fatalf("CreateWithCommandArgs(unidentified) error = %v", err)
	}
	if _, err := manager.UpdateAgent(unidentified.ID, AgentUpdate{
		Agent: "codex", Status: "waiting",
	}); err != nil {
		t.Fatalf("UpdateAgent(unidentified) error = %v", err)
	}
	if _, err := manager.ArchiveAgentSession(unidentified.ID); !errors.Is(err, ErrAgentSessionNotReady) {
		t.Fatalf("ArchiveAgentSession(unidentified) error = %v, want ErrAgentSessionNotReady", err)
	}

	archived := manager.ArchiveStaleWaitingAgents(stale.UpdatedAt.Add(24 * time.Hour))
	if len(archived) != 1 || archived[0].ID != stale.ID {
		t.Fatalf("archived = %#v, want only stale agent", archived)
	}
	if archived[0].State != StateExited || !archived[0].Archived ||
		archived[0].AgentSessionID != "stale-session" {
		t.Fatalf("archived metadata = %#v, want an exited resumable record", archived[0])
	}
	if _, ok := manager.Get(stale.ID); ok {
		t.Fatal("stale agent process is still registered after archival")
	}

	current := manager.ListCurrent()
	if len(current) != 4 {
		t.Fatalf("current sessions = %#v, want recent, running, bare, and unidentified terminals", current)
	}
	for _, item := range current {
		if item.ID == stale.ID {
			t.Fatalf("stale agent remained in current sessions: %#v", current)
		}
	}
	if _, ok := manager.Get(recent.ID); !ok {
		t.Fatal("recent waiting agent was archived")
	}
	if _, ok := manager.Get(running.ID); !ok {
		t.Fatal("running agent was archived")
	}
	if _, ok := manager.Get(bare.ID); !ok {
		t.Fatal("bare terminal was archived")
	}
	if _, ok := manager.Get(unidentified.ID); !ok {
		t.Fatal("unidentified agent was archived")
	}

	persisted := manager.ListPersisted()
	var found Metadata
	for _, item := range persisted {
		if item.ID == stale.ID {
			found = item
			break
		}
	}
	if found.ID == "" || found.State != StateExited || !found.Archived {
		t.Fatalf("persisted stale agent = %#v, want archived record", found)
	}
}

func TestArchiveAgentSessionStopsAnAgentAndKeepsItRestorable(t *testing.T) {
	manager, err := NewPersistentManager(
		"/bin/sh",
		HookConfig{},
		filepath.Join(t.TempDir(), "euphony.sqlite3"),
	)
	if err != nil {
		t.Fatalf("NewPersistentManager() error = %v", err)
	}
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	created, err := manager.CreateWithCommandArgs(
		context.Background(), "Manual archive", t.TempDir(), "/bin/sh", "-c", "sleep 30",
	)
	if err != nil {
		t.Fatalf("CreateWithCommandArgs() error = %v", err)
	}
	if _, err := manager.UpdateAgent(created.ID, AgentUpdate{
		Agent: "codex", AgentSessionID: "manual-session", Status: "running",
	}); err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}

	archived, err := manager.ArchiveAgentSession(created.ID)
	if err != nil {
		t.Fatalf("ArchiveAgentSession() error = %v", err)
	}
	if archived.ID != created.ID || archived.State != StateExited || !archived.Archived {
		t.Fatalf("archived metadata = %#v, want archived exited session", archived)
	}
	if _, ok := manager.Get(created.ID); ok {
		t.Fatal("manually archived process is still registered")
	}
	stored := manager.ListPersisted()
	if len(stored) != 1 || stored[0].ID != created.ID || !stored[0].Archived {
		t.Fatalf("stored sessions = %#v, want one archived session", stored)
	}
}

func TestArchiveAgentSessionKeepsLiveSessionWhenPersistenceFails(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	created, err := manager.CreateWithCommandArgs(
		context.Background(), "Archive persistence failure", t.TempDir(), "/bin/sh", "-c", "sleep 30",
	)
	if err != nil {
		t.Fatalf("CreateWithCommandArgs() error = %v", err)
	}
	if _, err := manager.UpdateAgent(created.ID, AgentUpdate{
		Agent: "codex", AgentSessionID: "persist-failure-session", Status: "running",
	}); err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
	persistenceErr := errors.New("archive save failed")
	manager.store = &failSaveMetadataStore{
		metadataStore: &recordingMetadataStore{},
		err:           persistenceErr,
	}

	if _, err := manager.ArchiveAgentSession(created.ID); !errors.Is(err, persistenceErr) {
		t.Fatalf("ArchiveAgentSession() error = %v, want %v", err, persistenceErr)
	}
	if _, ok := manager.Get(created.ID); !ok {
		t.Fatal("session disappeared after archive persistence failed")
	}
	metadata, ok := manager.Metadata(created.ID)
	if !ok || metadata.Archived || metadata.State == StateExited {
		t.Fatalf("metadata after failed archive = %#v, want live unarchived session", metadata)
	}
}
