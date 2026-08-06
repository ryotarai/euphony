package session

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/ryotarai/euphony/internal/selection"
)

func TestManagerAgentSummaryUnreadTransitions(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	first := AgentSummary{TerminalID: "terminal-1", Action: "Approve the change."}
	if err := manager.SaveAgentSummary(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	got := manager.AgentSummaries()[0]
	if !got.Unread {
		t.Fatalf("new summary unread = false, want true")
	}
	if _, err := manager.MarkAgentSummaryRead(context.Background(), first.TerminalID); err != nil {
		t.Fatal(err)
	}
	if err := manager.SaveAgentSummary(context.Background(), AgentSummary{
		TerminalID: first.TerminalID, Action: "  Approve the change.  ",
	}); err != nil {
		t.Fatal(err)
	}
	if manager.AgentSummaries()[0].Unread {
		t.Fatal("whitespace-only action change made summary unread")
	}
	if err := manager.SaveAgentSummary(context.Background(), AgentSummary{
		TerminalID: first.TerminalID, Action: "Reject the change.",
	}); err != nil {
		t.Fatal(err)
	}
	if !manager.AgentSummaries()[0].Unread {
		t.Fatal("action change did not make summary unread")
	}
}

func TestManagerAgentSummaryUnreadPreservesUnchangedAction(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	if err := manager.SaveAgentSummary(context.Background(), AgentSummary{
		TerminalID: "terminal-1", Action: "Approve the change.", Status: "blocked",
	}); err != nil {
		t.Fatal(err)
	}
	if err := manager.SaveAgentSummary(context.Background(), AgentSummary{
		TerminalID: "terminal-1", Action: "Approve the change.", Status: "waiting",
	}); err != nil {
		t.Fatal(err)
	}
	if !manager.AgentSummaries()[0].Unread {
		t.Fatal("unchanged action cleared unread state")
	}
}

func TestManagerMarkAgentSummaryReadIsIdempotent(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	want := AgentSummary{TerminalID: "terminal-1", Action: "Approve the change."}
	if err := manager.SaveAgentSummary(context.Background(), want); err != nil {
		t.Fatal(err)
	}
	first, err := manager.MarkAgentSummaryRead(context.Background(), want.TerminalID)
	if err != nil {
		t.Fatalf("first MarkAgentSummaryRead() error = %v", err)
	}
	second, err := manager.MarkAgentSummaryRead(context.Background(), want.TerminalID)
	if err != nil {
		t.Fatalf("second MarkAgentSummaryRead() error = %v", err)
	}
	if first.Unread || second.Unread {
		t.Fatalf("read summaries = %#v, %#v; want unread false", first, second)
	}
	if first != second {
		t.Fatalf("second MarkAgentSummaryRead() = %#v, want %#v", second, first)
	}
}

func TestManagerMarkAgentSummaryReadDoesNotPersistWhenAlreadyRead(t *testing.T) {
	store := &agentSummaryTestStore{}
	manager := NewManager("/bin/sh")
	manager.store = store
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	summary := AgentSummary{TerminalID: "terminal-1", Action: "Approve the change."}
	if err := manager.SaveAgentSummary(context.Background(), summary); err != nil {
		t.Fatalf("SaveAgentSummary() error = %v", err)
	}
	if _, err := manager.MarkAgentSummaryRead(context.Background(), summary.TerminalID); err != nil {
		t.Fatalf("first MarkAgentSummaryRead() error = %v", err)
	}
	if _, err := manager.MarkAgentSummaryRead(context.Background(), summary.TerminalID); err != nil {
		t.Fatalf("second MarkAgentSummaryRead() error = %v", err)
	}
	if store.saveCalls != 1 || store.markReadCalls != 1 {
		t.Fatalf("store writes = SaveAgentSummary:%d, MarkAgentSummaryRead:%d; want 1, 1", store.saveCalls, store.markReadCalls)
	}
}

func TestManagerMarkAgentSummaryReadRollsBackWhenPersistenceFails(t *testing.T) {
	persistErr := errors.New("persist read state")
	store := &agentSummaryTestStore{markReadErr: persistErr}
	manager := NewManager("/bin/sh")
	manager.store = store
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	summary := AgentSummary{TerminalID: "terminal-1", Action: "Approve the change."}
	if err := manager.SaveAgentSummary(context.Background(), summary); err != nil {
		t.Fatalf("SaveAgentSummary() error = %v", err)
	}
	if _, err := manager.MarkAgentSummaryRead(context.Background(), summary.TerminalID); !errors.Is(err, persistErr) {
		t.Fatalf("MarkAgentSummaryRead() error = %v, want %v", err, persistErr)
	}
	got := manager.AgentSummaries()[0]
	if !got.Unread {
		t.Fatalf("summary after persistence failure unread = false, want true")
	}
}

func TestManagerMarkAgentSummaryReadRejectsUnknownTerminal(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	if _, err := manager.MarkAgentSummaryRead(context.Background(), "missing"); !errors.Is(err, ErrAgentSummaryNotFound) {
		t.Fatalf("MarkAgentSummaryRead() error = %v, want ErrAgentSummaryNotFound", err)
	}
}

func TestSQLiteStoreMarksAgentSummaryRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "euphony.sqlite3")
	store, err := OpenSQLiteStore(path)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	want := AgentSummary{
		TerminalID:  "terminal-1",
		Provider:    "codex",
		Status:      "blocked",
		Summary:     "The agent is waiting for permission.",
		Action:      "Approve the requested access.",
		Unread:      true,
		GeneratedAt: time.Date(2026, 8, 5, 1, 2, 3, 4, time.UTC),
		Error:       "",
	}
	if err := store.SaveAgentSummary(context.Background(), want); err != nil {
		t.Fatalf("SaveAgentSummary() error = %v", err)
	}
	if err := store.MarkAgentSummaryRead(context.Background(), want.TerminalID); err != nil {
		t.Fatalf("MarkAgentSummaryRead() error = %v", err)
	}

	want.Unread = false
	got, err := store.LoadAgentSummaries(context.Background())
	if err != nil {
		t.Fatalf("LoadAgentSummaries() error = %v", err)
	}
	if !reflect.DeepEqual(got, []AgentSummary{want}) {
		t.Fatalf("LoadAgentSummaries() = %#v, want %#v", got, []AgentSummary{want})
	}
}

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
		Unread:      true,
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

func TestManagerPersistsAgentSummaryReadState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "euphony.sqlite3")
	manager, err := NewPersistentManager("/bin/sh", HookConfig{}, path)
	if err != nil {
		t.Fatalf("NewPersistentManager() error = %v", err)
	}
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	want := AgentSummary{
		TerminalID:  "terminal-1",
		Provider:    "codex",
		Status:      "waiting",
		Summary:     "The agent is waiting for input.",
		Action:      "Provide the requested input.",
		GeneratedAt: time.Date(2026, 8, 5, 1, 2, 3, 4, time.UTC),
	}
	if err := manager.SaveAgentSummary(context.Background(), want); err != nil {
		t.Fatalf("SaveAgentSummary() error = %v", err)
	}
	if got := manager.AgentSummaries()[0]; !got.Unread {
		t.Fatalf("new summary unread = false, want true")
	}
	got, err := manager.MarkAgentSummaryRead(context.Background(), want.TerminalID)
	if err != nil {
		t.Fatalf("MarkAgentSummaryRead() error = %v", err)
	}
	if got.Unread {
		t.Fatalf("read summary unread = true, want false")
	}
	if err := manager.Close(context.Background()); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	manager, err = NewPersistentManager("/bin/sh", HookConfig{}, path)
	if err != nil {
		t.Fatalf("NewPersistentManager() after read error = %v", err)
	}
	gotSummaries := manager.AgentSummaries()
	if len(gotSummaries) != 1 || gotSummaries[0].Unread {
		t.Fatalf("AgentSummaries() after reopen = %#v, want one read summary", gotSummaries)
	}
}

func TestSQLiteStoreDefaultsAndMigratesAgentSummaryProviderToCodex(t *testing.T) {
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
	t.Cleanup(func() { _ = store.Close() })
	settings, err := store.LoadSettings(context.Background())
	if err != nil {
		t.Fatalf("LoadSettings() error = %v", err)
	}
	if settings.AgentSummaryProvider != "codex" {
		t.Fatalf("AgentSummaryProvider = %q, want codex", settings.AgentSummaryProvider)
	}
	if _, err := store.db.Exec(`UPDATE settings SET agent_summary_provider = 'claude' WHERE id = 1`); err != nil {
		t.Fatalf("set legacy provider: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close migrated database: %v", err)
	}
	store, err = OpenSQLiteStore(path)
	if err != nil {
		t.Fatalf("reopen migrated database: %v", err)
	}
	settings, err = store.LoadSettings(context.Background())
	if err != nil {
		t.Fatalf("LoadSettings() after migration error = %v", err)
	}
	if settings.AgentSummaryProvider != "codex" {
		t.Fatalf("migrated AgentSummaryProvider = %q, want codex", settings.AgentSummaryProvider)
	}
}

type agentSummaryTestStore struct {
	saveCalls     int
	markReadCalls int
	markReadErr   error
}

func (*agentSummaryTestStore) Load(context.Context) ([]Metadata, error) {
	return nil, nil
}

func (*agentSummaryTestStore) Save(context.Context, Metadata) error {
	return nil
}

func (*agentSummaryTestStore) Delete(context.Context, string) error {
	return nil
}

func (*agentSummaryTestStore) LoadSettings(context.Context) (Settings, error) {
	return Settings{}, nil
}

func (*agentSummaryTestStore) SaveSettings(context.Context, Settings) error {
	return nil
}

func (*agentSummaryTestStore) LoadSelection(context.Context) (selection.State, bool, error) {
	return selection.State{}, false, nil
}

func (*agentSummaryTestStore) SaveSelection(context.Context, selection.State) error {
	return nil
}

func (*agentSummaryTestStore) Close() error {
	return nil
}

func (*agentSummaryTestStore) LoadAgentSummaries(context.Context) ([]AgentSummary, error) {
	return nil, nil
}

func (s *agentSummaryTestStore) SaveAgentSummary(context.Context, AgentSummary) error {
	s.saveCalls++
	return nil
}

func (s *agentSummaryTestStore) MarkAgentSummaryRead(context.Context, string) error {
	s.markReadCalls++
	return s.markReadErr
}

func (*agentSummaryTestStore) DeleteAgentSummary(context.Context, string) error {
	return nil
}
