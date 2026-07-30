package session

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

type metadataStore interface {
	Load(context.Context) ([]Metadata, error)
	Save(context.Context, Metadata) error
	Delete(context.Context, string) error
	LoadSettings(context.Context) (Settings, error)
	SaveSettings(context.Context, Settings) error
	Close() error
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
	statements := []string{
		"PRAGMA journal_mode = WAL",
		"PRAGMA busy_timeout = 5000",
		`CREATE TABLE IF NOT EXISTS terminals (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			state TEXT NOT NULL,
			cwd TEXT NOT NULL,
			agent TEXT NOT NULL DEFAULT '',
			resume_agent TEXT NOT NULL DEFAULT '',
			agent_status TEXT NOT NULL DEFAULT '',
			needs_attention INTEGER NOT NULL DEFAULT 0,
			agent_title TEXT NOT NULL DEFAULT '',
			agent_session_id TEXT NOT NULL DEFAULT '',
			agent_transcript_path TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
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
			terminal_history_limit INTEGER NOT NULL DEFAULT 1048576
		)`,
		`INSERT OR IGNORE INTO settings (id, prefix, sidebar_width, sidebar_collapsed)
			VALUES (1, 'Ctrl+B', 304, 0)`,
	}
	for _, statement := range statements {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate SQLite database: %w", err)
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
	if _, err := s.db.ExecContext(ctx, `UPDATE terminals
		SET agent_status = 'waiting', needs_attention = 1
		WHERE agent_status = 'attention'`); err != nil {
		return fmt.Errorf("migrate terminal attention status: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, "PRAGMA user_version = 6"); err != nil {
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
	var collapsed int
	err := s.db.QueryRowContext(ctx,
		`SELECT prefix, pane_tab_shortcut, sidebar_width, sidebar_collapsed,
			terminal_history_limit
		FROM settings WHERE id = 1`,
	).Scan(&result.Prefix, &result.PaneTabShortcut, &result.SidebarWidth, &collapsed,
		&result.TerminalHistoryLimit)
	if err != nil {
		return Settings{}, fmt.Errorf("load settings: %w", err)
	}
	result.SidebarCollapsed = collapsed != 0
	return result, nil
}

func (s *SQLiteStore) SaveSettings(ctx context.Context, settings Settings) error {
	collapsed := 0
	if settings.SidebarCollapsed {
		collapsed = 1
	}
	_, err := s.db.ExecContext(ctx, `UPDATE settings
		SET prefix = ?, pane_tab_shortcut = ?, sidebar_width = ?, sidebar_collapsed = ?,
			terminal_history_limit = ?
		WHERE id = 1`,
		settings.Prefix, settings.PaneTabShortcut, settings.SidebarWidth, collapsed,
		settings.TerminalHistoryLimit)
	if err != nil {
		return fmt.Errorf("save settings: %w", err)
	}
	return nil
}

func (s *SQLiteStore) Load(ctx context.Context) ([]Metadata, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, state, cwd, agent, resume_agent,
		agent_status, needs_attention, agent_title, agent_session_id, agent_transcript_path,
		created_at, exited_at, exit_code, message
		FROM terminals ORDER BY created_at`)
	if err != nil {
		return nil, fmt.Errorf("load terminals: %w", err)
	}
	defer rows.Close()
	var result []Metadata
	for rows.Next() {
		var item Metadata
		var createdAt string
		var exitedAt sql.NullString
		var exitCode sql.NullInt64
		var needsAttention int
		if err := rows.Scan(&item.ID, &item.Name, &item.State, &item.CWD, &item.Agent,
			&item.ResumeAgent, &item.AgentStatus, &needsAttention,
			&item.AgentTitle, &item.AgentSessionID, &item.AgentTranscriptPath,
			&createdAt, &exitedAt, &exitCode, &item.Message); err != nil {
			return nil, fmt.Errorf("scan terminal: %w", err)
		}
		item.NeedsAttention = needsAttention != 0
		item.CreatedAt, err = time.Parse(time.RFC3339Nano, createdAt)
		if err != nil {
			return nil, fmt.Errorf("parse terminal creation time: %w", err)
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
	var exitedAt any
	if item.ExitedAt != nil {
		exitedAt = item.ExitedAt.Format(time.RFC3339Nano)
	}
	var exitCode any
	if item.ExitCode != nil {
		exitCode = *item.ExitCode
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO terminals (
		id, name, state, cwd, agent, resume_agent, agent_status, needs_attention,
		agent_title, agent_session_id, agent_transcript_path,
		created_at, exited_at, exit_code, message
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		name=excluded.name, state=excluded.state, cwd=excluded.cwd, agent=excluded.agent,
		resume_agent=excluded.resume_agent, agent_status=excluded.agent_status,
		needs_attention=excluded.needs_attention,
		agent_title=excluded.agent_title, agent_session_id=excluded.agent_session_id,
		agent_transcript_path=excluded.agent_transcript_path,
		created_at=excluded.created_at, exited_at=excluded.exited_at,
		exit_code=excluded.exit_code, message=excluded.message`,
		item.ID, item.Name, item.State, item.CWD, item.Agent, item.ResumeAgent,
		item.AgentStatus, item.NeedsAttention, item.AgentTitle, item.AgentSessionID,
		item.AgentTranscriptPath,
		item.CreatedAt.Format(time.RFC3339Nano), exitedAt, exitCode, item.Message)
	if err != nil {
		return fmt.Errorf("save terminal: %w", err)
	}
	return nil
}

func (s *SQLiteStore) Delete(ctx context.Context, id string) error {
	if _, err := s.db.ExecContext(ctx, "DELETE FROM terminals WHERE id = ?", id); err != nil {
		return fmt.Errorf("delete terminal: %w", err)
	}
	return nil
}

func (s *SQLiteStore) Close() error {
	return s.db.Close()
}
