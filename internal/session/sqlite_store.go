package session

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/ryotarai/euphony/internal/selection"
	_ "modernc.org/sqlite"
)

type metadataStore interface {
	Load(context.Context) ([]Metadata, error)
	Save(context.Context, Metadata) error
	Delete(context.Context, string) error
	LoadSettings(context.Context) (Settings, error)
	SaveSettings(context.Context, Settings) error
	LoadSelection(context.Context) (selection.State, bool, error)
	SaveSelection(context.Context, selection.State) error
	Close() error
}

type agentSummaryStore interface {
	LoadAgentSummaries(context.Context) ([]AgentSummary, error)
	SaveAgentSummary(context.Context, AgentSummary) error
	MarkAgentSummaryRead(context.Context, string) error
	MarkAgentSummaryDone(context.Context, string) error
	DeleteAgentSummary(context.Context, string) error
	LoadAgentSummaryHistory(context.Context) (map[string][]AgentSummaryHistoryEntry, error)
	AppendAgentSummaryHistory(context.Context, string, AgentSummaryHistoryEntry) error
	DeleteAgentSummaryHistory(context.Context, string) error
}

type SQLiteStore struct {
	db *sql.DB
}

func OpenSQLiteStore(path string) (*SQLiteStore, error) {
	if path == "" {
		return nil, errors.New("SQLite path is required")
	}
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, fmt.Errorf("create SQLite directory: %w", err)
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open SQLite database: %w", err)
	}
	db.SetMaxOpenConns(1)
	store := &SQLiteStore{db: db}
	if err := store.migrate(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *SQLiteStore) migrate(ctx context.Context) error {
	var schemaVersion int
	if err := s.db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&schemaVersion); err != nil {
		return fmt.Errorf("read SQLite schema version: %w", err)
	}
	statements := []string{
		"PRAGMA journal_mode = WAL",
		"PRAGMA busy_timeout = 5000",
		`CREATE TABLE IF NOT EXISTS terminals (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			custom_name INTEGER NOT NULL DEFAULT 0,
			archived INTEGER NOT NULL DEFAULT 0,
			state TEXT NOT NULL,
				cwd TEXT NOT NULL,
				project_id TEXT NOT NULL DEFAULT '',
				sort_order INTEGER NOT NULL DEFAULT 0,
				agent TEXT NOT NULL DEFAULT '',
			resume_agent TEXT NOT NULL DEFAULT '',
			agent_status TEXT NOT NULL DEFAULT '',
			needs_attention INTEGER NOT NULL DEFAULT 0,
			agent_title TEXT NOT NULL DEFAULT '',
			agent_session_id TEXT NOT NULL DEFAULT '',
			agent_transcript_path TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL DEFAULT '',
			exited_at TEXT,
			exit_code INTEGER,
			message TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE IF NOT EXISTS settings (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			prefix TEXT NOT NULL,
			pane_tab_shortcut TEXT NOT NULL DEFAULT 'Meta+L',
			sidebar_width INTEGER NOT NULL,
			sidebar_collapsed INTEGER NOT NULL,
			interface_font_size INTEGER NOT NULL DEFAULT 16,
			terminal_font_size INTEGER NOT NULL DEFAULT 14,
			terminal_font_family TEXT NOT NULL DEFAULT 'Menlo, Monaco, "Hiragino Sans", "Yu Gothic", "Noto Sans Mono CJK JP", monospace',
			agent_log_font_size INTEGER NOT NULL DEFAULT 14,
			terminal_history_limit INTEGER NOT NULL DEFAULT 1048576,
			terminal_line_height REAL NOT NULL DEFAULT 1.25,
			terminal_cursor_style TEXT NOT NULL DEFAULT 'bar',
			terminal_cursor_blink INTEGER NOT NULL DEFAULT 0,
			terminal_scroll_sensitivity INTEGER NOT NULL DEFAULT 3,
			terminal_option_as_alt INTEGER NOT NULL DEFAULT 1,
			coding_agent TEXT NOT NULL DEFAULT 'codex',
			agent_summary_provider TEXT NOT NULL DEFAULT 'codex',
			agent_summary_prompt TEXT NOT NULL DEFAULT '',
			agent_summary_openai_effort TEXT NOT NULL DEFAULT 'low'
		)`,
		`INSERT OR IGNORE INTO settings (id, prefix, sidebar_width, sidebar_collapsed)
			VALUES (1, 'Ctrl+B', 304, 0)`,
		`CREATE TABLE IF NOT EXISTS selection (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			manual_terminal_ids TEXT NOT NULL,
			pinned_terminal_ids TEXT NOT NULL,
			focused_terminal_id TEXT NOT NULL,
			status_filters TEXT NOT NULL,
			cwd_filters TEXT NOT NULL,
			pinned_status_filters TEXT NOT NULL DEFAULT '[]',
			pinned_cwd_filters TEXT NOT NULL DEFAULT '[]',
			revision INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS agent_summaries (
			terminal_id TEXT PRIMARY KEY,
			provider TEXT NOT NULL,
			status TEXT NOT NULL,
			purpose TEXT NOT NULL DEFAULT '',
			summary TEXT NOT NULL,
			action TEXT NOT NULL DEFAULT '',
			priority TEXT NOT NULL DEFAULT '',
			options TEXT NOT NULL DEFAULT '[]',
			unread INTEGER NOT NULL DEFAULT 0,
			done INTEGER NOT NULL DEFAULT 0,
			generated_at TEXT NOT NULL,
			error TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE IF NOT EXISTS agent_summary_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			terminal_id TEXT NOT NULL,
			purpose TEXT NOT NULL DEFAULT '',
			summary TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT '',
			generated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS agent_summary_history_terminal_idx
			ON agent_summary_history (terminal_id, id)`,
	}
	for _, statement := range statements {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate SQLite database: %w", err)
		}
	}
	hasCustomName, err := s.hasColumn(ctx, "terminals", "custom_name")
	if err != nil {
		return err
	}
	if !hasCustomName {
		if _, err := s.db.ExecContext(ctx,
			"ALTER TABLE terminals ADD COLUMN custom_name INTEGER NOT NULL DEFAULT 0",
		); err != nil {
			return fmt.Errorf("add terminal custom name marker: %w", err)
		}
	}
	hasArchived, err := s.hasColumn(ctx, "terminals", "archived")
	if err != nil {
		return err
	}
	if !hasArchived {
		if _, err := s.db.ExecContext(ctx,
			"ALTER TABLE terminals ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
		); err != nil {
			return fmt.Errorf("add terminal archived flag: %w", err)
		}
	}
	hasNeedsAttention, err := s.hasColumn(ctx, "terminals", "needs_attention")
	if err != nil {
		return err
	}
	if !hasNeedsAttention {
		if _, err := s.db.ExecContext(ctx,
			"ALTER TABLE terminals ADD COLUMN needs_attention INTEGER NOT NULL DEFAULT 0",
		); err != nil {
			return fmt.Errorf("add terminal attention flag: %w", err)
		}
	}
	hasUpdatedAt, err := s.hasColumn(ctx, "terminals", "updated_at")
	if err != nil {
		return err
	}
	if !hasUpdatedAt {
		if _, err := s.db.ExecContext(ctx,
			"ALTER TABLE terminals ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''",
		); err != nil {
			return fmt.Errorf("add terminal update time: %w", err)
		}
	}
	hasAgentTranscriptPath, err := s.hasColumn(ctx, "terminals", "agent_transcript_path")
	if err != nil {
		return err
	}
	if !hasAgentTranscriptPath {
		if _, err := s.db.ExecContext(ctx,
			"ALTER TABLE terminals ADD COLUMN agent_transcript_path TEXT NOT NULL DEFAULT ''",
		); err != nil {
			return fmt.Errorf("add agent transcript path: %w", err)
		}
	}
	hasProjectID, err := s.hasColumn(ctx, "terminals", "project_id")
	if err != nil {
		return err
	}
	if !hasProjectID {
		if _, err := s.db.ExecContext(ctx,
			"ALTER TABLE terminals ADD COLUMN project_id TEXT NOT NULL DEFAULT ''",
		); err != nil {
			return fmt.Errorf("add terminal project ID: %w", err)
		}
	}
	hasOrder, err := s.hasColumn(ctx, "terminals", "sort_order")
	if err != nil {
		return err
	}
	if !hasOrder {
		if _, err := s.db.ExecContext(ctx,
			"ALTER TABLE terminals ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
		); err != nil {
			return fmt.Errorf("add terminal order: %w", err)
		}
	}
	hasPaneTabShortcut, err := s.hasColumn(ctx, "settings", "pane_tab_shortcut")
	if err != nil {
		return err
	}
	if !hasPaneTabShortcut {
		if _, err := s.db.ExecContext(ctx,
			"ALTER TABLE settings ADD COLUMN pane_tab_shortcut TEXT NOT NULL DEFAULT 'Meta+L'",
		); err != nil {
			return fmt.Errorf("add pane tab shortcut: %w", err)
		}
	}
	hasTerminalHistoryLimit, err := s.hasColumn(ctx, "settings", "terminal_history_limit")
	if err != nil {
		return err
	}
	if !hasTerminalHistoryLimit {
		if _, err := s.db.ExecContext(ctx,
			"ALTER TABLE settings ADD COLUMN terminal_history_limit INTEGER NOT NULL DEFAULT 1048576",
		); err != nil {
			return fmt.Errorf("add terminal history limit: %w", err)
		}
	}
	hasTerminalFontFamily, err := s.hasColumn(ctx, "settings", "terminal_font_family")
	if err != nil {
		return err
	}
	if !hasTerminalFontFamily {
		if _, err := s.db.ExecContext(ctx,
			`ALTER TABLE settings ADD COLUMN terminal_font_family TEXT NOT NULL DEFAULT 'Menlo, Monaco, "Hiragino Sans", "Yu Gothic", "Noto Sans Mono CJK JP", monospace'`,
		); err != nil {
			return fmt.Errorf("add terminal font family setting: %w", err)
		}
	}
	hasTerminalLineHeight, err := s.hasColumn(ctx, "settings", "terminal_line_height")
	if err != nil {
		return err
	}
	if !hasTerminalLineHeight {
		if _, err := s.db.ExecContext(ctx,
			"ALTER TABLE settings ADD COLUMN terminal_line_height REAL NOT NULL DEFAULT 1.25",
		); err != nil {
			return fmt.Errorf("add terminal line height setting: %w", err)
		}
	}
	hasTerminalCursorStyle, err := s.hasColumn(ctx, "settings", "terminal_cursor_style")
	if err != nil {
		return err
	}
	if !hasTerminalCursorStyle {
		if _, err := s.db.ExecContext(ctx,
			"ALTER TABLE settings ADD COLUMN terminal_cursor_style TEXT NOT NULL DEFAULT 'bar'",
		); err != nil {
			return fmt.Errorf("add terminal cursor style setting: %w", err)
		}
	}
	hasTerminalCursorBlink, err := s.hasColumn(ctx, "settings", "terminal_cursor_blink")
	if err != nil {
		return err
	}
	if !hasTerminalCursorBlink {
		if _, err := s.db.ExecContext(ctx,
			"ALTER TABLE settings ADD COLUMN terminal_cursor_blink INTEGER NOT NULL DEFAULT 0",
		); err != nil {
			return fmt.Errorf("add terminal cursor blink setting: %w", err)
		}
	}
	hasTerminalScrollSensitivity, err := s.hasColumn(ctx, "settings", "terminal_scroll_sensitivity")
	if err != nil {
		return err
	}
	if !hasTerminalScrollSensitivity {
		if _, err := s.db.ExecContext(ctx,
			"ALTER TABLE settings ADD COLUMN terminal_scroll_sensitivity INTEGER NOT NULL DEFAULT 3",
		); err != nil {
			return fmt.Errorf("add terminal scroll sensitivity setting: %w", err)
		}
	}
	hasTerminalOptionAsAlt, err := s.hasColumn(ctx, "settings", "terminal_option_as_alt")
	if err != nil {
		return err
	}
	if !hasTerminalOptionAsAlt {
		if _, err := s.db.ExecContext(ctx,
			"ALTER TABLE settings ADD COLUMN terminal_option_as_alt INTEGER NOT NULL DEFAULT 1",
		); err != nil {
			return fmt.Errorf("add terminal Option-as-Alt setting: %w", err)
		}
	}
	hasAgentSummaryProvider, err := s.hasColumn(ctx, "settings", "agent_summary_provider")
	if err != nil {
		return err
	}
	hasCodingAgent, err := s.hasColumn(ctx, "settings", "coding_agent")
	if err != nil {
		return err
	}
	if !hasCodingAgent {
		if _, err := s.db.ExecContext(ctx,
			"ALTER TABLE settings ADD COLUMN coding_agent TEXT NOT NULL DEFAULT 'codex'",
		); err != nil {
			return fmt.Errorf("add coding agent setting: %w", err)
		}
	}
	if !hasAgentSummaryProvider {
		if _, err := s.db.ExecContext(ctx,
			"ALTER TABLE settings ADD COLUMN agent_summary_provider TEXT NOT NULL DEFAULT 'codex'",
		); err != nil {
			return fmt.Errorf("add agent summary provider setting: %w", err)
		}
	} else if schemaVersion < 11 {
		if _, err := s.db.ExecContext(ctx,
			"UPDATE settings SET agent_summary_provider = ? WHERE agent_summary_provider = 'claude'",
			DefaultAgentSummaryProvider,
		); err != nil {
			return fmt.Errorf("migrate legacy agent summary provider: %w", err)
		}
	}
	hasAgentSummaryPrompt, err := s.hasColumn(ctx, "settings", "agent_summary_prompt")
	if err != nil {
		return err
	}
	if !hasAgentSummaryPrompt {
		if _, err := s.db.ExecContext(ctx,
			"ALTER TABLE settings ADD COLUMN agent_summary_prompt TEXT NOT NULL DEFAULT ''",
		); err != nil {
			return fmt.Errorf("add agent summary prompt setting: %w", err)
		}
	}
	hasAgentSummaryOpenAIEffort, err := s.hasColumn(ctx, "settings", "agent_summary_openai_effort")
	if err != nil {
		return err
	}
	if !hasAgentSummaryOpenAIEffort {
		if _, err := s.db.ExecContext(ctx,
			"ALTER TABLE settings ADD COLUMN agent_summary_openai_effort TEXT NOT NULL DEFAULT 'low'",
		); err != nil {
			return fmt.Errorf("add agent summary OpenAI effort setting: %w", err)
		}
	}
	for _, column := range []struct {
		name         string
		defaultValue int
	}{
		{name: "interface_font_size", defaultValue: 16},
		{name: "terminal_font_size", defaultValue: 14},
		{name: "agent_log_font_size", defaultValue: 14},
	} {
		exists, err := s.hasColumn(ctx, "settings", column.name)
		if err != nil {
			return err
		}
		if exists {
			continue
		}
		statement := fmt.Sprintf(
			"ALTER TABLE settings ADD COLUMN %s INTEGER NOT NULL DEFAULT %d",
			column.name,
			column.defaultValue,
		)
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("add %s setting: %w", column.name, err)
		}
	}
	for _, column := range []string{
		"pinned_status_filters",
		"pinned_cwd_filters",
	} {
		exists, err := s.hasColumn(ctx, "selection", column)
		if err != nil {
			return err
		}
		if exists {
			continue
		}
		statement := fmt.Sprintf(
			"ALTER TABLE selection ADD COLUMN %s TEXT NOT NULL DEFAULT '[]'",
			column,
		)
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("add %s selection field: %w", column, err)
		}
	}
	hasAgentSummaryUnread, err := s.hasColumn(ctx, "agent_summaries", "unread")
	if err != nil {
		return err
	}
	if !hasAgentSummaryUnread {
		if _, err := s.db.ExecContext(ctx,
			"ALTER TABLE agent_summaries ADD COLUMN unread INTEGER NOT NULL DEFAULT 0",
		); err != nil {
			return fmt.Errorf("add agent summary unread flag: %w", err)
		}
	}
	hasAgentSummaryPriority, err := s.hasColumn(ctx, "agent_summaries", "priority")
	if err != nil {
		return err
	}
	if !hasAgentSummaryPriority {
		if _, err := s.db.ExecContext(ctx,
			"ALTER TABLE agent_summaries ADD COLUMN priority TEXT NOT NULL DEFAULT ''",
		); err != nil {
			return fmt.Errorf("add agent summary priority: %w", err)
		}
	}
	hasAgentSummaryDone, err := s.hasColumn(ctx, "agent_summaries", "done")
	if err != nil {
		return err
	}
	if !hasAgentSummaryDone {
		if _, err := s.db.ExecContext(ctx,
			"ALTER TABLE agent_summaries ADD COLUMN done INTEGER NOT NULL DEFAULT 0",
		); err != nil {
			return fmt.Errorf("add agent summary done flag: %w", err)
		}
	}
	hasAgentSummaryOptions, err := s.hasColumn(ctx, "agent_summaries", "options")
	if err != nil {
		return err
	}
	if !hasAgentSummaryOptions {
		if _, err := s.db.ExecContext(ctx,
			"ALTER TABLE agent_summaries ADD COLUMN options TEXT NOT NULL DEFAULT '[]'",
		); err != nil {
			return fmt.Errorf("add agent summary options: %w", err)
		}
	}
	hasAgentSummaryPurpose, err := s.hasColumn(ctx, "agent_summaries", "purpose")
	if err != nil {
		return err
	}
	if !hasAgentSummaryPurpose {
		if _, err := s.db.ExecContext(ctx,
			"ALTER TABLE agent_summaries ADD COLUMN purpose TEXT NOT NULL DEFAULT ''",
		); err != nil {
			return fmt.Errorf("add agent summary purpose: %w", err)
		}
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE terminals
		SET agent_status = 'waiting', needs_attention = 1
		WHERE agent_status = 'attention'`); err != nil {
		return fmt.Errorf("migrate terminal attention status: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, "PRAGMA user_version = 18"); err != nil {
		return fmt.Errorf("set schema version: %w", err)
	}
	return nil
}

func (s *SQLiteStore) hasColumn(ctx context.Context, table, column string) (bool, error) {
	rows, err := s.db.QueryContext(ctx, "PRAGMA table_info("+table+")")
	if err != nil {
		return false, fmt.Errorf("inspect %s schema: %w", table, err)
	}
	defer rows.Close()
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, columnType string
		var defaultValue sql.NullString
		if err := rows.Scan(
			&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey,
		); err != nil {
			return false, fmt.Errorf("scan %s schema: %w", table, err)
		}
		if name == column {
			return true, nil
		}
	}
	if err := rows.Err(); err != nil {
		return false, fmt.Errorf("inspect %s schema: %w", table, err)
	}
	return false, nil
}

func (s *SQLiteStore) LoadSettings(ctx context.Context) (Settings, error) {
	var result Settings
	var collapsed, terminalCursorBlink, terminalOptionAsAlt int
	err := s.db.QueryRowContext(ctx,
		`SELECT prefix, pane_tab_shortcut, sidebar_width, sidebar_collapsed,
			interface_font_size, terminal_font_size, terminal_font_family, agent_log_font_size,
			terminal_history_limit, terminal_line_height,
			terminal_cursor_style, terminal_cursor_blink, terminal_scroll_sensitivity,
			terminal_option_as_alt, coding_agent, agent_summary_provider, agent_summary_prompt,
			agent_summary_openai_effort
		FROM settings WHERE id = 1`,
	).Scan(
		&result.Prefix,
		&result.PaneTabShortcut,
		&result.SidebarWidth,
		&collapsed,
		&result.InterfaceFontSize,
		&result.TerminalFontSize,
		&result.TerminalFontFamily,
		&result.AgentLogFontSize,
		&result.TerminalHistoryLimit,
		&result.TerminalLineHeight,
		&result.TerminalCursorStyle,
		&terminalCursorBlink,
		&result.TerminalScrollSensitivity,
		&terminalOptionAsAlt,
		&result.CodingAgent,
		&result.AgentSummaryProvider,
		&result.AgentSummaryPrompt,
		&result.AgentSummaryOpenAIEffort,
	)
	if err != nil {
		return Settings{}, fmt.Errorf("load settings: %w", err)
	}
	result.SidebarCollapsed = collapsed != 0
	result.TerminalCursorBlink = terminalCursorBlink != 0
	result.TerminalOptionAsAlt = terminalOptionAsAlt != 0
	return result, nil
}

func (s *SQLiteStore) SaveSettings(ctx context.Context, settings Settings) error {
	collapsed := 0
	if settings.SidebarCollapsed {
		collapsed = 1
	}
	terminalCursorBlink := 0
	if settings.TerminalCursorBlink {
		terminalCursorBlink = 1
	}
	terminalOptionAsAlt := 0
	if settings.TerminalOptionAsAlt {
		terminalOptionAsAlt = 1
	}
	_, err := s.db.ExecContext(ctx, `UPDATE settings
		SET prefix = ?, pane_tab_shortcut = ?, sidebar_width = ?, sidebar_collapsed = ?,
			interface_font_size = ?, terminal_font_size = ?, terminal_font_family = ?, agent_log_font_size = ?,
			terminal_history_limit = ?, terminal_line_height = ?,
			terminal_cursor_style = ?, terminal_cursor_blink = ?, terminal_scroll_sensitivity = ?,
			terminal_option_as_alt = ?, coding_agent = ?, agent_summary_provider = ?, agent_summary_prompt = ?
			, agent_summary_openai_effort = ?
		WHERE id = 1`,
		settings.Prefix, settings.PaneTabShortcut, settings.SidebarWidth, collapsed,
		settings.InterfaceFontSize, settings.TerminalFontSize, settings.TerminalFontFamily,
		settings.AgentLogFontSize,
		settings.TerminalHistoryLimit, settings.TerminalLineHeight,
		settings.TerminalCursorStyle, terminalCursorBlink, settings.TerminalScrollSensitivity,
		terminalOptionAsAlt, settings.CodingAgent, settings.AgentSummaryProvider, settings.AgentSummaryPrompt,
		settings.AgentSummaryOpenAIEffort)
	if err != nil {
		return fmt.Errorf("save settings: %w", err)
	}
	return nil
}

func (s *SQLiteStore) LoadSelection(ctx context.Context) (selection.State, bool, error) {
	var result selection.State
	var manualJSON, pinnedJSON, statusesJSON, cwdJSON string
	var pinnedStatusesJSON, pinnedCWDJSON string
	err := s.db.QueryRowContext(ctx, `SELECT manual_terminal_ids, pinned_terminal_ids,
		focused_terminal_id, status_filters, cwd_filters,
		pinned_status_filters, pinned_cwd_filters, revision
		FROM selection WHERE id = 1`).Scan(
		&manualJSON,
		&pinnedJSON,
		&result.FocusedTerminalID,
		&statusesJSON,
		&cwdJSON,
		&pinnedStatusesJSON,
		&pinnedCWDJSON,
		&result.Revision,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return selection.State{}, false, nil
	}
	if err != nil {
		return selection.State{}, false, fmt.Errorf("load selection: %w", err)
	}
	for _, item := range []struct {
		name   string
		data   string
		target any
	}{
		{name: "manual terminal IDs", data: manualJSON, target: &result.ManualTerminalIDs},
		{name: "pinned terminal IDs", data: pinnedJSON, target: &result.PinnedTerminalIDs},
		{name: "status filters", data: statusesJSON, target: &result.StatusFilters},
		{name: "cwd filters", data: cwdJSON, target: &result.CWDFilters},
		{name: "pinned status filters", data: pinnedStatusesJSON,
			target: &result.PinnedFilters.Statuses},
		{name: "pinned cwd filters", data: pinnedCWDJSON,
			target: &result.PinnedFilters.CWDs},
	} {
		if err := json.Unmarshal([]byte(item.data), item.target); err != nil {
			return selection.State{}, false,
				fmt.Errorf("decode selection %s: %w", item.name, err)
		}
	}
	return result, true, nil
}

func (s *SQLiteStore) SaveSelection(ctx context.Context, state selection.State) error {
	manualJSON, err := json.Marshal(state.ManualTerminalIDs)
	if err != nil {
		return fmt.Errorf("encode manual terminal IDs: %w", err)
	}
	pinnedJSON, err := json.Marshal(state.PinnedTerminalIDs)
	if err != nil {
		return fmt.Errorf("encode pinned terminal IDs: %w", err)
	}
	statusesJSON, err := json.Marshal(state.StatusFilters)
	if err != nil {
		return fmt.Errorf("encode status filters: %w", err)
	}
	cwdJSON, err := json.Marshal(state.CWDFilters)
	if err != nil {
		return fmt.Errorf("encode cwd filters: %w", err)
	}
	pinnedStatusesJSON, err := json.Marshal(state.PinnedFilters.Statuses)
	if err != nil {
		return fmt.Errorf("encode pinned status filters: %w", err)
	}
	pinnedCWDJSON, err := json.Marshal(state.PinnedFilters.CWDs)
	if err != nil {
		return fmt.Errorf("encode pinned cwd filters: %w", err)
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO selection (
		id, manual_terminal_ids, pinned_terminal_ids, focused_terminal_id,
		status_filters, cwd_filters, pinned_status_filters, pinned_cwd_filters,
		revision
	) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		manual_terminal_ids=excluded.manual_terminal_ids,
		pinned_terminal_ids=excluded.pinned_terminal_ids,
		focused_terminal_id=excluded.focused_terminal_id,
		status_filters=excluded.status_filters,
		cwd_filters=excluded.cwd_filters,
		pinned_status_filters=excluded.pinned_status_filters,
		pinned_cwd_filters=excluded.pinned_cwd_filters,
		revision=excluded.revision`,
		string(manualJSON), string(pinnedJSON), state.FocusedTerminalID,
		string(statusesJSON), string(cwdJSON), string(pinnedStatusesJSON),
		string(pinnedCWDJSON), state.Revision)
	if err != nil {
		return fmt.Errorf("save selection: %w", err)
	}
	return nil
}

func (s *SQLiteStore) Load(ctx context.Context) ([]Metadata, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, custom_name, archived, state, cwd, project_id, sort_order, agent, resume_agent,
		agent_status, needs_attention, agent_title, agent_session_id, agent_transcript_path,
		created_at, updated_at, exited_at, exit_code, message
		FROM terminals ORDER BY created_at`)
	if err != nil {
		return nil, fmt.Errorf("load terminals: %w", err)
	}
	defer rows.Close()
	var result []Metadata
	for rows.Next() {
		var item Metadata
		var createdAt string
		var updatedAt string
		var exitedAt sql.NullString
		var exitCode sql.NullInt64
		var customName int
		var archived int
		var needsAttention int
		if err := rows.Scan(&item.ID, &item.Name, &customName, &archived, &item.State, &item.CWD, &item.ProjectID, &item.Order, &item.Agent,
			&item.ResumeAgent, &item.AgentStatus, &needsAttention,
			&item.AgentTitle, &item.AgentSessionID, &item.AgentTranscriptPath,
			&createdAt, &updatedAt, &exitedAt, &exitCode, &item.Message); err != nil {
			return nil, fmt.Errorf("scan terminal: %w", err)
		}
		item.CustomName = customName != 0
		item.Archived = archived != 0
		item.NeedsAttention = needsAttention != 0
		item.CreatedAt, err = time.Parse(time.RFC3339Nano, createdAt)
		if err != nil {
			return nil, fmt.Errorf("parse terminal creation time: %w", err)
		}
		if updatedAt == "" {
			item.UpdatedAt = item.CreatedAt
		} else {
			item.UpdatedAt, err = time.Parse(time.RFC3339Nano, updatedAt)
			if err != nil {
				return nil, fmt.Errorf("parse terminal update time: %w", err)
			}
		}
		if exitedAt.Valid {
			value, parseErr := time.Parse(time.RFC3339Nano, exitedAt.String)
			if parseErr != nil {
				return nil, fmt.Errorf("parse terminal exit time: %w", parseErr)
			}
			item.ExitedAt = &value
		}
		if exitCode.Valid {
			value := int(exitCode.Int64)
			item.ExitCode = &value
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("load terminals: %w", err)
	}
	return result, nil
}

func (s *SQLiteStore) Save(ctx context.Context, item Metadata) error {
	updatedAt := item.UpdatedAt
	if updatedAt.IsZero() {
		updatedAt = item.CreatedAt
	}
	var exitedAt any
	if item.ExitedAt != nil {
		exitedAt = item.ExitedAt.Format(time.RFC3339Nano)
	}
	var exitCode any
	if item.ExitCode != nil {
		exitCode = *item.ExitCode
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO terminals (
		id, name, custom_name, archived, state, cwd, project_id, sort_order, agent, resume_agent, agent_status, needs_attention,
			agent_title, agent_session_id, agent_transcript_path,
			created_at, updated_at, exited_at, exit_code, message
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name=excluded.name, custom_name=excluded.custom_name, archived=excluded.archived,
			state=excluded.state,
		cwd=excluded.cwd, project_id=excluded.project_id, sort_order=excluded.sort_order, agent=excluded.agent,
		resume_agent=excluded.resume_agent, agent_status=excluded.agent_status,
		needs_attention=excluded.needs_attention,
		agent_title=excluded.agent_title, agent_session_id=excluded.agent_session_id,
		agent_transcript_path=excluded.agent_transcript_path,
		created_at=excluded.created_at, updated_at=excluded.updated_at,
		exited_at=excluded.exited_at,
		exit_code=excluded.exit_code, message=excluded.message`,
		item.ID, item.Name, item.CustomName, item.Archived, item.State, item.CWD, item.ProjectID, item.Order, item.Agent, item.ResumeAgent,
		item.AgentStatus, item.NeedsAttention, item.AgentTitle, item.AgentSessionID,
		item.AgentTranscriptPath,
		item.CreatedAt.Format(time.RFC3339Nano), updatedAt.Format(time.RFC3339Nano),
		exitedAt, exitCode, item.Message)
	if err != nil {
		return fmt.Errorf("save terminal: %w", err)
	}
	return nil
}

func (s *SQLiteStore) Reorder(ctx context.Context, orderedIDs []string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin terminal reorder: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	for index, id := range orderedIDs {
		result, err := tx.ExecContext(ctx,
			"UPDATE terminals SET sort_order = ? WHERE id = ? AND archived = 0", index+1, id)
		if err != nil {
			return fmt.Errorf("reorder terminal: %w", err)
		}
		rows, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("reorder terminal result: %w", err)
		}
		if rows != 1 {
			return ErrNotFound
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit terminal reorder: %w", err)
	}
	return nil
}

func (s *SQLiteStore) Delete(ctx context.Context, id string) error {
	if _, err := s.db.ExecContext(ctx, "DELETE FROM terminals WHERE id = ?", id); err != nil {
		return fmt.Errorf("delete terminal: %w", err)
	}
	return nil
}

func (s *SQLiteStore) LoadAgentSummaries(ctx context.Context) ([]AgentSummary, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT terminal_id, provider, status,
		purpose, summary, action, priority, options, unread, done, generated_at, error
		FROM agent_summaries ORDER BY generated_at, terminal_id`)
	if err != nil {
		return nil, fmt.Errorf("load agent summaries: %w", err)
	}
	defer rows.Close()
	var result []AgentSummary
	for rows.Next() {
		var item AgentSummary
		var unread, done int
		var optionsJSON string
		var generatedAt string
		if err := rows.Scan(
			&item.TerminalID, &item.Provider, &item.Status, &item.Purpose, &item.Summary,
			&item.Action, &item.Priority, &optionsJSON, &unread, &done, &generatedAt, &item.Error,
		); err != nil {
			return nil, fmt.Errorf("scan agent summary: %w", err)
		}
		if err := json.Unmarshal([]byte(optionsJSON), &item.Options); err != nil {
			return nil, fmt.Errorf("decode agent summary options: %w", err)
		}
		if len(item.Options) == 0 {
			item.Options = nil
		}
		item.Unread = unread != 0
		item.Done = done != 0
		item.GeneratedAt, err = time.Parse(time.RFC3339Nano, generatedAt)
		if err != nil {
			return nil, fmt.Errorf("parse agent summary timestamp: %w", err)
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("load agent summaries: %w", err)
	}
	return result, nil
}

func (s *SQLiteStore) SaveAgentSummary(ctx context.Context, item AgentSummary) error {
	options := item.Options
	if options == nil {
		options = []AgentSummaryOption{}
	}
	optionsJSON, err := json.Marshal(options)
	if err != nil {
		return fmt.Errorf("encode agent summary options: %w", err)
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO agent_summaries (
		terminal_id, provider, status, purpose, summary, action, priority, options, unread, done, generated_at, error
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(terminal_id) DO UPDATE SET
		provider=excluded.provider, status=excluded.status, purpose=excluded.purpose, summary=excluded.summary,
		action=excluded.action, priority=excluded.priority, options=excluded.options, unread=excluded.unread,
		done=excluded.done,
		generated_at=excluded.generated_at, error=excluded.error`,
		item.TerminalID, item.Provider, item.Status, item.Purpose, item.Summary, item.Action,
		item.Priority, optionsJSON, item.Unread, item.Done, item.GeneratedAt.Format(time.RFC3339Nano), item.Error)
	if err != nil {
		return fmt.Errorf("save agent summary: %w", err)
	}
	return nil
}

func (s *SQLiteStore) MarkAgentSummaryRead(ctx context.Context, terminalID string) error {
	if _, err := s.db.ExecContext(ctx,
		"UPDATE agent_summaries SET unread = 0 WHERE terminal_id = ?", terminalID,
	); err != nil {
		return fmt.Errorf("mark agent summary read: %w", err)
	}
	return nil
}

func (s *SQLiteStore) MarkAgentSummaryDone(ctx context.Context, terminalID string) error {
	if _, err := s.db.ExecContext(ctx,
		"UPDATE agent_summaries SET done = 1, unread = 0 WHERE terminal_id = ?", terminalID,
	); err != nil {
		return fmt.Errorf("mark agent summary done: %w", err)
	}
	return nil
}

func (s *SQLiteStore) DeleteAgentSummary(ctx context.Context, terminalID string) error {
	if _, err := s.db.ExecContext(ctx,
		"DELETE FROM agent_summaries WHERE terminal_id = ?", terminalID,
	); err != nil {
		return fmt.Errorf("delete agent summary: %w", err)
	}
	return nil
}

func (s *SQLiteStore) LoadAgentSummaryHistory(
	ctx context.Context,
) (map[string][]AgentSummaryHistoryEntry, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT terminal_id, purpose, summary, status, generated_at
		FROM agent_summary_history ORDER BY terminal_id, id`)
	if err != nil {
		return nil, fmt.Errorf("load agent summary history: %w", err)
	}
	defer rows.Close()
	result := make(map[string][]AgentSummaryHistoryEntry)
	for rows.Next() {
		var terminalID, generatedAt string
		var entry AgentSummaryHistoryEntry
		if err := rows.Scan(
			&terminalID, &entry.Purpose, &entry.Summary, &entry.Status, &generatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan agent summary history: %w", err)
		}
		entry.GeneratedAt, err = time.Parse(time.RFC3339Nano, generatedAt)
		if err != nil {
			return nil, fmt.Errorf("parse agent summary history timestamp: %w", err)
		}
		result[terminalID] = append(result[terminalID], entry)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("load agent summary history: %w", err)
	}
	return result, nil
}

func (s *SQLiteStore) AppendAgentSummaryHistory(
	ctx context.Context, terminalID string, entry AgentSummaryHistoryEntry,
) error {
	if _, err := s.db.ExecContext(ctx, `INSERT INTO agent_summary_history (
		terminal_id, purpose, summary, status, generated_at
	) VALUES (?, ?, ?, ?, ?)`,
		terminalID, entry.Purpose, entry.Summary, entry.Status,
		entry.GeneratedAt.Format(time.RFC3339Nano),
	); err != nil {
		return fmt.Errorf("append agent summary history: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM agent_summary_history
		WHERE terminal_id = ? AND id NOT IN (
			SELECT id FROM agent_summary_history WHERE terminal_id = ? ORDER BY id DESC LIMIT ?
		)`, terminalID, terminalID, MaxAgentSummaryHistoryEntries,
	); err != nil {
		return fmt.Errorf("prune agent summary history: %w", err)
	}
	return nil
}

func (s *SQLiteStore) DeleteAgentSummaryHistory(ctx context.Context, terminalID string) error {
	if _, err := s.db.ExecContext(ctx,
		"DELETE FROM agent_summary_history WHERE terminal_id = ?", terminalID,
	); err != nil {
		return fmt.Errorf("delete agent summary history: %w", err)
	}
	return nil
}

func (s *SQLiteStore) Close() error {
	return s.db.Close()
}
