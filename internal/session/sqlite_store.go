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
			agent_title TEXT NOT NULL DEFAULT '',
			agent_session_id TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			exited_at TEXT,
			exit_code INTEGER,
			message TEXT NOT NULL DEFAULT ''
		)`,
		"PRAGMA user_version = 1",
	}
	for _, statement := range statements {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate SQLite database: %w", err)
		}
	}
	return nil
}

func (s *SQLiteStore) Load(ctx context.Context) ([]Metadata, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, state, cwd, agent, resume_agent,
		agent_status, agent_title, agent_session_id, created_at, exited_at, exit_code, message
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
		if err := rows.Scan(&item.ID, &item.Name, &item.State, &item.CWD, &item.Agent,
			&item.ResumeAgent, &item.AgentStatus, &item.AgentTitle, &item.AgentSessionID,
			&createdAt, &exitedAt, &exitCode, &item.Message); err != nil {
			return nil, fmt.Errorf("scan terminal: %w", err)
		}
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
		id, name, state, cwd, agent, resume_agent, agent_status, agent_title,
		agent_session_id, created_at, exited_at, exit_code, message
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		name=excluded.name, state=excluded.state, cwd=excluded.cwd, agent=excluded.agent,
		resume_agent=excluded.resume_agent, agent_status=excluded.agent_status,
		agent_title=excluded.agent_title, agent_session_id=excluded.agent_session_id,
		created_at=excluded.created_at, exited_at=excluded.exited_at,
		exit_code=excluded.exit_code, message=excluded.message`,
		item.ID, item.Name, item.State, item.CWD, item.Agent, item.ResumeAgent,
		item.AgentStatus, item.AgentTitle, item.AgentSessionID,
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
