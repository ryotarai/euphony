package session

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestSQLiteStorePersistsTerminalMetadata(t *testing.T) {
	path := filepath.Join(t.TempDir(), "euphony.sqlite3")
	store, err := OpenSQLiteStore(path)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}

	exitCode := 7
	exitedAt := time.Date(2026, 7, 29, 1, 2, 3, 4, time.UTC)
	want := Metadata{
		ID: "terminal-1", Name: "Terminal", State: StateExited, CWD: "/repo",
		Agent: "codex", ResumeAgent: "codex", AgentStatus: "waiting", AgentTitle: "SQLite",
		AgentSessionID: "019c43d4-95d9-7af0-92c4-d9f670ccaa32",
		CreatedAt:      time.Date(2026, 7, 28, 1, 2, 3, 4, time.UTC),
		ExitedAt:       &exitedAt, ExitCode: &exitCode, Message: "done",
	}
	if err := store.Save(context.Background(), want); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	store, err = OpenSQLiteStore(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer store.Close()
	got, err := store.Load(context.Background())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(got) != 1 || !metadataEqual(got[0], want) {
		t.Fatalf("Load() = %#v, want %#v", got, want)
	}
	if err := store.Delete(context.Background(), want.ID); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	got, err = store.Load(context.Background())
	if err != nil || len(got) != 0 {
		t.Fatalf("Load() after delete = %#v, %v", got, err)
	}
}

func TestSQLiteStorePersistsSettings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "euphony.sqlite3")
	store, err := OpenSQLiteStore(path)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	defaults, err := store.LoadSettings(context.Background())
	if err != nil {
		t.Fatalf("LoadSettings() error = %v", err)
	}
	if defaults.Prefix != "Ctrl+B" || defaults.SidebarWidth != 304 || defaults.SidebarCollapsed {
		t.Fatalf("default settings = %#v", defaults)
	}
	want := Settings{Prefix: "Ctrl+A", SidebarWidth: 420, SidebarCollapsed: true}
	if err := store.SaveSettings(context.Background(), want); err != nil {
		t.Fatalf("SaveSettings() error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	store, err = OpenSQLiteStore(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer store.Close()
	got, err := store.LoadSettings(context.Background())
	if err != nil {
		t.Fatalf("LoadSettings() after reopen error = %v", err)
	}
	if got != want {
		t.Fatalf("LoadSettings() = %#v, want %#v", got, want)
	}
}

func metadataEqual(left, right Metadata) bool {
	return left.ID == right.ID && left.Name == right.Name && left.State == right.State &&
		left.CWD == right.CWD && left.Agent == right.Agent &&
		left.ResumeAgent == right.ResumeAgent &&
		left.AgentStatus == right.AgentStatus && left.AgentTitle == right.AgentTitle &&
		left.AgentSessionID == right.AgentSessionID &&
		left.CreatedAt.Equal(right.CreatedAt) &&
		timesEqual(left.ExitedAt, right.ExitedAt) &&
		intsEqual(left.ExitCode, right.ExitCode) && left.Message == right.Message
}

func timesEqual(left, right *time.Time) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return left.Equal(*right)
}

func intsEqual(left, right *int) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
