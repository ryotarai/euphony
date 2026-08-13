package session

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/ryotarai/euphony/internal/selection"
)

func TestAgentSummaryJSONUsesAnEmptyOptionsArray(t *testing.T) {
	payload, err := json.Marshal(AgentSummary{TerminalID: "terminal-1", Summary: "Working."})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if string(decoded["options"]) != "[]" {
		t.Fatalf("options JSON = %s, want []", decoded["options"])
	}
}

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

func TestManagerAgentSummaryOptionsResetAndPreserveActionState(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	first := AgentSummary{
		TerminalID: "terminal-1", Action: "Approve the change.",
		Options: []AgentSummaryOption{{ID: "legacy", Label: "Allow", Input: "y\r"}},
	}
	if err := manager.SaveAgentSummary(context.Background(), first); err != nil {
		t.Fatalf("SaveAgentSummary(first) error = %v", err)
	}
	if got := manager.AgentSummaries()[0]; len(got.Options) != 1 || got.Options[0].ID != "option-1" {
		t.Fatalf("normalized options = %#v, want option-1", got.Options)
	}
	if _, err := manager.MarkAgentSummaryDone(context.Background(), first.TerminalID); err != nil {
		t.Fatalf("MarkAgentSummaryDone() error = %v", err)
	}

	if err := manager.SaveAgentSummary(context.Background(), AgentSummary{
		TerminalID: first.TerminalID, Action: "Approve the change.",
		Options: []AgentSummaryOption{{ID: "another-id", Label: "Allow", Input: "y\r"}},
	}); err != nil {
		t.Fatalf("SaveAgentSummary(same options) error = %v", err)
	}
	if got := manager.AgentSummaries()[0]; !got.Done || got.Unread {
		t.Fatalf("same action/options summary = %#v, want done=true unread=false", got)
	}

	if err := manager.SaveAgentSummary(context.Background(), AgentSummary{
		TerminalID: first.TerminalID, Action: "Approve the change.",
		Options: []AgentSummaryOption{{Label: "Deny", Input: "n\r"}},
	}); err != nil {
		t.Fatalf("SaveAgentSummary(changed option) error = %v", err)
	}
	if got := manager.AgentSummaries()[0]; got.Done || !got.Unread || got.Options[0].ID != "option-1" {
		t.Fatalf("changed option summary = %#v, want done=false unread=true normalized option", got)
	}
}

func TestManagerAgentSummaryDoneTransitions(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	first := AgentSummary{
		TerminalID: "terminal-1", Action: "Approve the change.", Priority: "high",
	}
	if err := manager.SaveAgentSummary(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	if got := manager.AgentSummaries()[0]; got.Done || !got.Unread {
		t.Fatalf("new summary = %#v, want done=false unread=true", got)
	}

	done, err := manager.MarkAgentSummaryDone(context.Background(), first.TerminalID)
	if err != nil {
		t.Fatalf("MarkAgentSummaryDone() error = %v", err)
	}
	if !done.Done || done.Unread {
		t.Fatalf("done summary = %#v, want done=true unread=false", done)
	}

	if err := manager.SaveAgentSummary(context.Background(), AgentSummary{
		TerminalID: first.TerminalID, Action: "  Approve the change.  ", Priority: "low",
	}); err != nil {
		t.Fatal(err)
	}
	if got := manager.AgentSummaries()[0]; !got.Done || got.Unread {
		t.Fatalf("same-action summary = %#v, want done=true unread=false", got)
	}

	if err := manager.SaveAgentSummary(context.Background(), AgentSummary{
		TerminalID: first.TerminalID, Action: "Reject the change.", Priority: "high",
	}); err != nil {
		t.Fatal(err)
	}
	if got := manager.AgentSummaries()[0]; got.Done || !got.Unread {
		t.Fatalf("changed-action summary = %#v, want done=false unread=true", got)
	}

	second, err := manager.MarkAgentSummaryDone(context.Background(), first.TerminalID)
	if err != nil {
		t.Fatalf("second MarkAgentSummaryDone() error = %v", err)
	}
	if !second.Done || second.Unread {
		t.Fatalf("second done summary = %#v, want done=true unread=false", second)
	}
}

func TestManagerMarkAgentSummaryDoneIfCurrentRejectsNewerSummary(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	first := AgentSummary{
		TerminalID:  "terminal-1",
		Status:      "waiting",
		Action:      "Approve the change.",
		Options:     []AgentSummaryOption{{Label: "Allow", Input: "y\r"}},
		GeneratedAt: time.Date(2026, 8, 5, 1, 0, 0, 0, time.UTC),
	}
	if err := manager.SaveAgentSummary(context.Background(), first); err != nil {
		t.Fatalf("SaveAgentSummary(first) error = %v", err)
	}
	current := manager.AgentSummaries()[0]

	newer := first
	newer.GeneratedAt = first.GeneratedAt.Add(time.Minute)
	newer.Options = []AgentSummaryOption{{Label: "Deny", Input: "n\r"}}
	if err := manager.SaveAgentSummary(context.Background(), newer); err != nil {
		t.Fatalf("SaveAgentSummary(newer) error = %v", err)
	}

	if _, err := manager.MarkAgentSummaryDoneIfCurrent(context.Background(), current); !errors.Is(err, ErrAgentSummaryChanged) {
		t.Fatalf("MarkAgentSummaryDoneIfCurrent() error = %v, want ErrAgentSummaryChanged", err)
	}
	got := manager.AgentSummaries()[0]
	if got.Done || got.Options[0].Label != "Deny" {
		t.Fatalf("newer summary after stale completion = %#v, want actionable newer summary", got)
	}
}

func TestManagerMarkAgentSummaryDoneRejectsUnknownTerminal(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	if _, err := manager.MarkAgentSummaryDone(context.Background(), "missing"); !errors.Is(err, ErrAgentSummaryNotFound) {
		t.Fatalf("MarkAgentSummaryDone() error = %v, want ErrAgentSummaryNotFound", err)
	}
}

func TestManagerMarkAgentSummaryDoneRollsBackWhenPersistenceFails(t *testing.T) {
	persistErr := errors.New("persist done state")
	store := &agentSummaryTestStore{markDoneErr: persistErr}
	manager := NewManager("/bin/sh")
	manager.store = store
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	summary := AgentSummary{TerminalID: "terminal-1", Action: "Approve the change."}
	if err := manager.SaveAgentSummary(context.Background(), summary); err != nil {
		t.Fatalf("SaveAgentSummary() error = %v", err)
	}
	if _, err := manager.MarkAgentSummaryDone(context.Background(), summary.TerminalID); !errors.Is(err, persistErr) {
		t.Fatalf("MarkAgentSummaryDone() error = %v, want %v", err, persistErr)
	}
	if got := manager.AgentSummaries()[0]; got.Done || !got.Unread {
		t.Fatalf("summary after persistence failure = %#v, want done=false unread=true", got)
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
	if !reflect.DeepEqual(first, second) {
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

func TestSQLiteStoreMarksAgentSummaryDone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "euphony.sqlite3")
	store, err := OpenSQLiteStore(path)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	want := AgentSummary{
		TerminalID: "terminal-1", Provider: "codex", Status: "blocked",
		Summary: "The agent is waiting for permission.", Action: "Approve the requested access.",
		Priority: "high", Unread: true, GeneratedAt: time.Date(2026, 8, 5, 1, 2, 3, 4, time.UTC),
	}
	if err := store.SaveAgentSummary(context.Background(), want); err != nil {
		t.Fatalf("SaveAgentSummary() error = %v", err)
	}
	if err := store.MarkAgentSummaryDone(context.Background(), want.TerminalID); err != nil {
		t.Fatalf("MarkAgentSummaryDone() error = %v", err)
	}

	want.Done = true
	want.Unread = false
	got, err := store.LoadAgentSummaries(context.Background())
	if err != nil {
		t.Fatalf("LoadAgentSummaries() error = %v", err)
	}
	if !reflect.DeepEqual(got, []AgentSummary{want}) {
		t.Fatalf("LoadAgentSummaries() = %#v, want %#v", got, []AgentSummary{want})
	}
}

func TestSQLiteStoreMigratesAgentSummaryPriorityAndDoneColumns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy-agent-summary.sqlite3")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	_, err = db.Exec(`CREATE TABLE agent_summaries (
		terminal_id TEXT PRIMARY KEY,
		provider TEXT NOT NULL,
		status TEXT NOT NULL,
		summary TEXT NOT NULL,
		action TEXT NOT NULL DEFAULT '',
		unread INTEGER NOT NULL DEFAULT 0,
		generated_at TEXT NOT NULL,
		error TEXT NOT NULL DEFAULT ''
	)`)
	if err != nil {
		t.Fatalf("create legacy agent summary schema: %v", err)
	}
	_, err = db.Exec(`INSERT INTO agent_summaries (
		terminal_id, provider, status, summary, action, unread, generated_at, error
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		"terminal-1", "codex", "waiting", "Waiting for input.",
		"Provide the requested input.", 0,
		time.Date(2026, 8, 5, 1, 2, 3, 4, time.UTC).Format(time.RFC3339Nano), "")
	if err != nil {
		t.Fatalf("insert legacy agent summary: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close legacy database: %v", err)
	}

	store, err := OpenSQLiteStore(path)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	got, err := store.LoadAgentSummaries(context.Background())
	if err != nil {
		t.Fatalf("LoadAgentSummaries() error = %v", err)
	}
	if len(got) != 1 || got[0].Priority != "" || got[0].Done || len(got[0].Options) != 0 {
		t.Fatalf("migrated summaries = %#v, want empty priority/done/options", got)
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
		Purpose:     "API access approval",
		Summary:     "The agent is waiting for permission to edit the API.",
		Action:      "Approve the requested file access.",
		Options:     []AgentSummaryOption{{ID: "option-1", Label: "Allow", Input: "y\r"}},
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

func TestManagerPersistsAgentSummaryDoneState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "euphony.sqlite3")
	manager, err := NewPersistentManager("/bin/sh", HookConfig{}, path)
	if err != nil {
		t.Fatalf("NewPersistentManager() error = %v", err)
	}

	want := AgentSummary{
		TerminalID: "terminal-1", Provider: "codex", Status: "waiting",
		Summary: "The agent is waiting for input.", Action: "Provide the requested input.",
		Priority: "high",
	}
	if err := manager.SaveAgentSummary(context.Background(), want); err != nil {
		t.Fatalf("SaveAgentSummary() error = %v", err)
	}
	got, err := manager.MarkAgentSummaryDone(context.Background(), want.TerminalID)
	if err != nil {
		t.Fatalf("MarkAgentSummaryDone() error = %v", err)
	}
	if !got.Done || got.Unread {
		t.Fatalf("done summary = %#v, want done=true unread=false", got)
	}
	if err := manager.Close(context.Background()); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	manager, err = NewPersistentManager("/bin/sh", HookConfig{}, path)
	if err != nil {
		t.Fatalf("NewPersistentManager() after done error = %v", err)
	}
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	gotSummaries := manager.AgentSummaries()
	if len(gotSummaries) != 1 || !gotSummaries[0].Done || gotSummaries[0].Unread || gotSummaries[0].Priority != "high" {
		t.Fatalf("AgentSummaries() after reopen = %#v, want persisted done summary", gotSummaries)
	}
}

func TestSQLiteStoreDefaultsAndPreservesAgentSummaryProvider(t *testing.T) {
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
	if settings.AgentSummaryProvider != "claude" {
		t.Fatalf("saved AgentSummaryProvider = %q, want claude", settings.AgentSummaryProvider)
	}
}

func TestSQLiteStorePersistsAgentSummaryOpenAIEffort(t *testing.T) {
	path := filepath.Join(t.TempDir(), "effort.sqlite3")
	store, err := OpenSQLiteStore(path)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	defer store.Close()
	settings := DefaultSettings()
	if settings.AgentSummaryOpenAIEffort != "low" {
		t.Fatalf("default OpenAI effort = %q, want low", settings.AgentSummaryOpenAIEffort)
	}
	settings.AgentSummaryOpenAIEffort = "max"
	if err := store.SaveSettings(context.Background(), settings); err != nil {
		t.Fatalf("SaveSettings() error = %v", err)
	}
	got, err := store.LoadSettings(context.Background())
	if err != nil {
		t.Fatalf("LoadSettings() error = %v", err)
	}
	if got.AgentSummaryOpenAIEffort != "max" {
		t.Fatalf("persisted OpenAI effort = %q, want max", got.AgentSummaryOpenAIEffort)
	}
}

type agentSummaryTestStore struct {
	saveCalls     int
	markReadCalls int
	markReadErr   error
	markDoneCalls int
	markDoneErr   error
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

func (s *agentSummaryTestStore) MarkAgentSummaryDone(context.Context, string) error {
	s.markDoneCalls++
	return s.markDoneErr
}

func (*agentSummaryTestStore) DeleteAgentSummary(context.Context, string) error {
	return nil
}

func (*agentSummaryTestStore) LoadAgentSummaryHistory(
	context.Context,
) (map[string][]AgentSummaryHistoryEntry, error) {
	return nil, nil
}

func (*agentSummaryTestStore) AppendAgentSummaryHistory(
	context.Context, string, AgentSummaryHistoryEntry,
) error {
	return nil
}

func (*agentSummaryTestStore) DeleteAgentSummaryHistory(context.Context, string) error {
	return nil
}

func TestManagerAgentSummaryHistoryAccumulatesAndCaps(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent-summary-history.sqlite3")
	manager, err := NewPersistentManager("/bin/sh", HookConfig{}, path)
	if err != nil {
		t.Fatalf("NewPersistentManager() error = %v", err)
	}
	generatedAt := time.Date(2026, 8, 5, 1, 2, 3, 4, time.UTC)
	total := MaxAgentSummaryHistoryEntries + 3
	for index := 0; index < total; index++ {
		if err := manager.SaveAgentSummary(context.Background(), AgentSummary{
			TerminalID:  "terminal-1",
			Provider:    "codex",
			Status:      "waiting",
			Purpose:     "Ship the feature.",
			Summary:     fmt.Sprintf("Step %d.", index),
			GeneratedAt: generatedAt.Add(time.Duration(index) * time.Minute),
		}); err != nil {
			t.Fatalf("SaveAgentSummary(%d) error = %v", index, err)
		}
	}
	// A repeated generation must not add a duplicate entry.
	if err := manager.SaveAgentSummary(context.Background(), AgentSummary{
		TerminalID:  "terminal-1",
		Provider:    "codex",
		Status:      "waiting",
		Purpose:     "Ship the feature.",
		Summary:     fmt.Sprintf("Step %d.", total-1),
		GeneratedAt: generatedAt.Add(time.Duration(total) * time.Minute),
	}); err != nil {
		t.Fatalf("SaveAgentSummary(duplicate) error = %v", err)
	}
	// Failed generations must not be recorded.
	if err := manager.SaveAgentSummary(context.Background(), AgentSummary{
		TerminalID:  "terminal-1",
		Provider:    "codex",
		Summary:     "",
		Error:       "provider failed",
		GeneratedAt: generatedAt.Add(time.Hour),
	}); err != nil {
		t.Fatalf("SaveAgentSummary(error) error = %v", err)
	}
	assertAgentSummaryHistory(t, manager, total)
	if err := manager.Close(context.Background()); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	manager, err = NewPersistentManager("/bin/sh", HookConfig{}, path)
	if err != nil {
		t.Fatalf("NewPersistentManager() after reopen error = %v", err)
	}
	assertAgentSummaryHistory(t, manager, total)

	if err := manager.DeleteAgentSummary(context.Background(), "terminal-1"); err != nil {
		t.Fatalf("DeleteAgentSummary() error = %v", err)
	}
	if got := manager.AgentSummaryHistory("terminal-1"); len(got) != 0 {
		t.Fatalf("AgentSummaryHistory() after delete = %#v, want empty", got)
	}
	if err := manager.Close(context.Background()); err != nil {
		t.Fatalf("Close() after delete error = %v", err)
	}
	manager, err = NewPersistentManager("/bin/sh", HookConfig{}, path)
	if err != nil {
		t.Fatalf("NewPersistentManager() after delete error = %v", err)
	}
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	if got := manager.AgentSummaryHistory("terminal-1"); len(got) != 0 {
		t.Fatalf("AgentSummaryHistory() after delete and reopen = %#v, want empty", got)
	}
}

func assertAgentSummaryHistory(t *testing.T, manager *Manager, total int) {
	t.Helper()
	history := manager.AgentSummaryHistory("terminal-1")
	if len(history) != MaxAgentSummaryHistoryEntries {
		t.Fatalf("AgentSummaryHistory() length = %d, want %d",
			len(history), MaxAgentSummaryHistoryEntries)
	}
	for index, entry := range history {
		want := fmt.Sprintf("Step %d.", total-MaxAgentSummaryHistoryEntries+index)
		if entry.Summary != want {
			t.Fatalf("AgentSummaryHistory()[%d].Summary = %q, want %q", index, entry.Summary, want)
		}
		if entry.Purpose != "Ship the feature." || entry.Status != "waiting" {
			t.Fatalf("AgentSummaryHistory()[%d] = %#v, want purpose and status kept", index, entry)
		}
	}
}
