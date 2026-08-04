package session

import (
	"context"
	"database/sql"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestSQLiteStorePersistsAgentSummary(t *testing.T) {
	path := filepath.Join(t.TempDir(), "euphony.sqlite3")
	store, err := OpenSQLiteStore(path)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	want := AgentSummary{
		TerminalID:  "terminal-1",
		Provider:    "codex",
		Status:      "blocked",
		Summary:     "The agent is waiting for permission to edit the API.",
		Action:      "Approve the requested file access.",
		GeneratedAt: time.Date(2026, 8, 5, 1, 2, 3, 4, time.UTC),
		Error:       "",
	}
	if err := store.SaveAgentSummary(context.Background(), want); err != nil {
		t.Fatalf("SaveAgentSummary() error = %v", err)
	}
	got, err := store.LoadAgentSummaries(context.Background())
	if err != nil {
		t.Fatalf("LoadAgentSummaries() error = %v", err)
	}
	if !reflect.DeepEqual(got, []AgentSummary{want}) {
		t.Fatalf("LoadAgentSummaries() = %#v, want %#v", got, []AgentSummary{want})
	}
	if err := store.DeleteAgentSummary(context.Background(), want.TerminalID); err != nil {
		t.Fatalf("DeleteAgentSummary() error = %v", err)
	}
	got, err = store.LoadAgentSummaries(context.Background())
	if err != nil || len(got) != 0 {
		t.Fatalf("LoadAgentSummaries() after delete = %#v, %v", got, err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	manager, err := NewPersistentManager("/bin/sh", HookConfig{}, path)
	if err != nil {
		t.Fatalf("NewPersistentManager() error = %v", err)
	}
	defer manager.Close(context.Background())
	if got := manager.AgentSummaries(); len(got) != 0 {
		t.Fatalf("AgentSummaries() after delete = %#v", got)
	}
	if err := manager.SaveAgentSummary(context.Background(), want); err != nil {
		t.Fatalf("Manager.SaveAgentSummary() error = %v", err)
	}
	if got := manager.AgentSummaries(); !reflect.DeepEqual(got, []AgentSummary{want}) {
		t.Fatalf("Manager.AgentSummaries() = %#v, want %#v", got, []AgentSummary{want})
	}
}

func TestSQLiteStoreAddsDefaultAgentSummaryProviderToLegacySettings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy-settings.sqlite3")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	_, err = db.Exec(`CREATE TABLE settings (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		prefix TEXT NOT NULL,
		pane_tab_shortcut TEXT NOT NULL,
		sidebar_width INTEGER NOT NULL,
		sidebar_collapsed INTEGER NOT NULL,
		interface_font_size INTEGER NOT NULL,
		terminal_font_size INTEGER NOT NULL,
		terminal_font_family TEXT NOT NULL,
		agent_log_font_size INTEGER NOT NULL,
		terminal_history_limit INTEGER NOT NULL,
		terminal_line_height REAL NOT NULL,
		terminal_cursor_style TEXT NOT NULL,
		terminal_cursor_blink INTEGER NOT NULL,
		terminal_scroll_sensitivity INTEGER NOT NULL,
		terminal_option_as_alt INTEGER NOT NULL
	)`)
	if err != nil {
		t.Fatalf("create legacy settings: %v", err)
	}
	_, err = db.Exec(`INSERT INTO settings (
		id, prefix, pane_tab_shortcut, sidebar_width, sidebar_collapsed,
		interface_font_size, terminal_font_size, terminal_font_family,
		agent_log_font_size, terminal_history_limit, terminal_line_height,
		terminal_cursor_style, terminal_cursor_blink, terminal_scroll_sensitivity,
		terminal_option_as_alt
	) VALUES (1, 'Ctrl+B', 'Meta+L', 304, 0, 16, 14, ?, 14, 1048576, 1.25, 'bar', 0, 3, 1)`, DefaultTerminalFontFamily)
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
	settings, err := store.LoadSettings(context.Background())
	if err != nil {
		t.Fatalf("LoadSettings() error = %v", err)
	}
	if settings.AgentSummaryProvider != "claude" {
		t.Fatalf("AgentSummaryProvider = %q, want claude", settings.AgentSummaryProvider)
	}
}
