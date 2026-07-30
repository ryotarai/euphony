package session

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

func TestSQLiteStoreMigratesLegacyAttentionStatus(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.sqlite3")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	_, err = db.Exec(`CREATE TABLE terminals (
		id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL,
		cwd TEXT NOT NULL, agent TEXT NOT NULL DEFAULT '',
		resume_agent TEXT NOT NULL DEFAULT '', agent_status TEXT NOT NULL DEFAULT '',
		agent_title TEXT NOT NULL DEFAULT '', agent_session_id TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL, exited_at TEXT, exit_code INTEGER,
		message TEXT NOT NULL DEFAULT ''
	)`)
	if err != nil {
		t.Fatalf("create legacy schema: %v", err)
	}
	_, err = db.Exec(`INSERT INTO terminals (
		id, name, state, cwd, agent, agent_status, created_at
	) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		"legacy", "Terminal", "running", "/repo", "codex", "attention",
		time.Date(2026, 7, 30, 0, 0, 0, 0, time.UTC).Format(time.RFC3339Nano),
	)
	if err != nil {
		t.Fatalf("insert legacy terminal: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close legacy database: %v", err)
	}

	store, err := OpenSQLiteStore(path)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	defer store.Close()
	items, err := store.Load(context.Background())
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(items) != 1 || items[0].AgentStatus != "waiting" || !items[0].NeedsAttention {
		t.Fatalf("migrated metadata = %#v, want waiting with attention", items)
	}
}

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
		NeedsAttention:      true,
		AgentSessionID:      "019c43d4-95d9-7af0-92c4-d9f670ccaa32",
		AgentTranscriptPath: "/home/me/.codex/sessions/2026/07/30/rollout-session.jsonl",
		CreatedAt:           time.Date(2026, 7, 28, 1, 2, 3, 4, time.UTC),
		ExitedAt:            &exitedAt, ExitCode: &exitCode, Message: "done",
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
	if defaults.Prefix != "Ctrl+B" || defaults.PaneTabShortcut != "Meta+L" ||
		defaults.SidebarWidth != 304 || defaults.SidebarCollapsed {
		t.Fatalf("default settings = %#v", defaults)
	}
	want := Settings{
		Prefix: "Ctrl+A", PaneTabShortcut: "Ctrl+J",
		SidebarWidth: 420, SidebarCollapsed: true,
	}
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

func TestSQLiteStoreMigratesLegacySettingsWithDefaultPaneTabShortcut(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy-settings.sqlite3")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	_, err = db.Exec(`CREATE TABLE settings (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		prefix TEXT NOT NULL,
		sidebar_width INTEGER NOT NULL,
		sidebar_collapsed INTEGER NOT NULL
	)`)
	if err != nil {
		t.Fatalf("create legacy settings schema: %v", err)
	}
	_, err = db.Exec(`INSERT INTO settings (id, prefix, sidebar_width, sidebar_collapsed)
		VALUES (1, 'Ctrl+A', 420, 1)`)
	if err != nil {
		t.Fatalf("insert legacy settings: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close legacy database: %v", err)
	}

	store, err := OpenSQLiteStore(path)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	defer store.Close()
	got, err := store.LoadSettings(context.Background())
	if err != nil {
		t.Fatalf("LoadSettings() error = %v", err)
	}
	want := Settings{
		Prefix: "Ctrl+A", PaneTabShortcut: "Meta+L",
		SidebarWidth: 420, SidebarCollapsed: true,
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
		left.NeedsAttention == right.NeedsAttention &&
		left.AgentSessionID == right.AgentSessionID &&
		left.AgentTranscriptPath == right.AgentTranscriptPath &&
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
