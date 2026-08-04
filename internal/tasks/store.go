package tasks

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type Repository interface {
	Create(context.Context, Task) error
	Get(context.Context, string) (Task, error)
	List(context.Context) ([]Task, error)
	Update(context.Context, Task) error
	Delete(context.Context, string) error
	ListUpdates(context.Context, string) ([]TaskUpdate, error)
	AppendUpdate(context.Context, TaskUpdate) (bool, error)
	Close() error
}

type memoryStore struct {
	mu      sync.RWMutex
	tasks   map[string]Task
	updates map[string][]TaskUpdate
}

func NewMemoryStore() Repository {
	return &memoryStore{
		tasks:   make(map[string]Task),
		updates: make(map[string][]TaskUpdate),
	}
}

func (s *memoryStore) Create(_ context.Context, task Task) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.tasks[task.ID]; exists {
		return fmt.Errorf("task %q already exists", task.ID)
	}
	s.tasks[task.ID] = cloneTask(task)
	return nil
}

func (s *memoryStore) Get(_ context.Context, id string) (Task, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	task, ok := s.tasks[id]
	if !ok {
		return Task{}, ErrNotFound
	}
	return cloneTask(task), nil
}

func (s *memoryStore) List(_ context.Context) ([]Task, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]Task, 0, len(s.tasks))
	for _, task := range s.tasks {
		result = append(result, cloneTask(task))
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].UpdatedAt.Equal(result[j].UpdatedAt) {
			return result[i].ID < result[j].ID
		}
		return result[i].UpdatedAt.After(result[j].UpdatedAt)
	})
	return result, nil
}

func (s *memoryStore) Update(_ context.Context, task Task) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.tasks[task.ID]; !exists {
		return ErrNotFound
	}
	s.tasks[task.ID] = cloneTask(task)
	return nil
}

func (s *memoryStore) Delete(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.tasks[id]; !exists {
		return ErrNotFound
	}
	delete(s.tasks, id)
	delete(s.updates, id)
	return nil
}

func (s *memoryStore) ListUpdates(_ context.Context, taskID string) ([]TaskUpdate, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, exists := s.tasks[taskID]; !exists {
		return nil, ErrNotFound
	}
	result := append([]TaskUpdate(nil), s.updates[taskID]...)
	sort.SliceStable(result, func(i, j int) bool {
		return result[i].CreatedAt.Before(result[j].CreatedAt)
	})
	return result, nil
}

func (s *memoryStore) AppendUpdate(_ context.Context, update TaskUpdate) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.tasks[update.TaskID]; !exists {
		return false, ErrNotFound
	}
	updates := s.updates[update.TaskID]
	if len(updates) > 0 {
		latest := updates[len(updates)-1]
		if latest.Kind == update.Kind && latest.Body == update.Body {
			return false, nil
		}
	}
	s.updates[update.TaskID] = append(updates, update)
	return true, nil
}

func (*memoryStore) Close() error { return nil }

type sqliteStore struct {
	db *sql.DB
}

func OpenStore(path string) (Repository, error) {
	if path == "" {
		return NewMemoryStore(), nil
	}
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, fmt.Errorf("create task database directory: %w", err)
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open task database: %w", err)
	}
	db.SetMaxOpenConns(1)
	store := &sqliteStore{db: db}
	if err := store.migrate(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *sqliteStore) migrate(ctx context.Context) error {
	for _, statement := range []string{
		"PRAGMA foreign_keys = ON",
		"PRAGMA busy_timeout = 5000",
		`CREATE TABLE IF NOT EXISTS tasks (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			priority TEXT NOT NULL,
			status TEXT NOT NULL,
			terminal_id TEXT NOT NULL DEFAULT '',
			agent TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS task_updates (
			id TEXT PRIMARY KEY,
			task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
			terminal_id TEXT NOT NULL DEFAULT '',
			kind TEXT NOT NULL,
			body TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS task_updates_task_created
			ON task_updates(task_id, created_at, id)`,
	} {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate task database: %w", err)
		}
	}
	return nil
}

func (s *sqliteStore) Create(ctx context.Context, task Task) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO tasks (
		id, title, description, priority, status, terminal_id, agent, created_at, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		task.ID, task.Title, task.Description, task.Priority, task.Status,
		task.TerminalID, task.Agent, formatTime(task.CreatedAt), formatTime(task.UpdatedAt))
	if err != nil {
		return fmt.Errorf("create task: %w", err)
	}
	return nil
}

func (s *sqliteStore) Get(ctx context.Context, id string) (Task, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, title, description, priority,
		status, terminal_id, agent, created_at, updated_at FROM tasks WHERE id = ?`, id)
	task, err := scanTask(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Task{}, ErrNotFound
	}
	if err != nil {
		return Task{}, fmt.Errorf("get task: %w", err)
	}
	return task, nil
}

func (s *sqliteStore) List(ctx context.Context) ([]Task, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, title, description, priority,
		status, terminal_id, agent, created_at, updated_at
		FROM tasks ORDER BY updated_at DESC, id`)
	if err != nil {
		return nil, fmt.Errorf("list tasks: %w", err)
	}
	defer rows.Close()
	result := make([]Task, 0)
	for rows.Next() {
		task, err := scanTask(rows)
		if err != nil {
			return nil, fmt.Errorf("scan task: %w", err)
		}
		result = append(result, task)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list tasks: %w", err)
	}
	return result, nil
}

func (s *sqliteStore) Update(ctx context.Context, task Task) error {
	result, err := s.db.ExecContext(ctx, `UPDATE tasks SET title = ?, description = ?,
		priority = ?, status = ?, terminal_id = ?, agent = ?, updated_at = ? WHERE id = ?`,
		task.Title, task.Description, task.Priority, task.Status, task.TerminalID,
		task.Agent, formatTime(task.UpdatedAt), task.ID)
	if err != nil {
		return fmt.Errorf("update task: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("update task result: %w", err)
	}
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *sqliteStore) Delete(ctx context.Context, id string) error {
	result, err := s.db.ExecContext(ctx, "DELETE FROM tasks WHERE id = ?", id)
	if err != nil {
		return fmt.Errorf("delete task: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete task result: %w", err)
	}
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *sqliteStore) ListUpdates(ctx context.Context, taskID string) ([]TaskUpdate, error) {
	if _, err := s.Get(ctx, taskID); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, task_id, terminal_id, kind,
		body, created_at FROM task_updates WHERE task_id = ? ORDER BY created_at, id`, taskID)
	if err != nil {
		return nil, fmt.Errorf("list task updates: %w", err)
	}
	defer rows.Close()
	var result []TaskUpdate
	for rows.Next() {
		var update TaskUpdate
		var createdAt string
		if err := rows.Scan(&update.ID, &update.TaskID, &update.TerminalID,
			&update.Kind, &update.Body, &createdAt); err != nil {
			return nil, fmt.Errorf("scan task update: %w", err)
		}
		update.CreatedAt, err = parseTime(createdAt)
		if err != nil {
			return nil, fmt.Errorf("parse task update timestamp: %w", err)
		}
		result = append(result, update)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list task updates: %w", err)
	}
	return result, nil
}

func (s *sqliteStore) AppendUpdate(ctx context.Context, update TaskUpdate) (bool, error) {
	var latestKind, latestBody string
	err := s.db.QueryRowContext(ctx, `SELECT kind, body FROM task_updates
		WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`, update.TaskID).
		Scan(&latestKind, &latestBody)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, fmt.Errorf("read latest task update: %w", err)
	}
	if err == nil && latestKind == update.Kind && latestBody == update.Body {
		return false, nil
	}
	if _, err := s.Get(ctx, update.TaskID); err != nil {
		return false, err
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO task_updates (
		id, task_id, terminal_id, kind, body, created_at
	) VALUES (?, ?, ?, ?, ?, ?)`, update.ID, update.TaskID, update.TerminalID,
		update.Kind, update.Body, formatTime(update.CreatedAt)); err != nil {
		return false, fmt.Errorf("append task update: %w", err)
	}
	return true, nil
}

func (s *sqliteStore) Close() error { return s.db.Close() }

type rowScanner interface {
	Scan(...any) error
}

func scanTask(row rowScanner) (Task, error) {
	var task Task
	var createdAt, updatedAt string
	err := row.Scan(&task.ID, &task.Title, &task.Description, &task.Priority,
		&task.Status, &task.TerminalID, &task.Agent, &createdAt, &updatedAt)
	if err != nil {
		return Task{}, err
	}
	task.CreatedAt, err = parseTime(createdAt)
	if err != nil {
		return Task{}, err
	}
	task.UpdatedAt, err = parseTime(updatedAt)
	if err != nil {
		return Task{}, err
	}
	return task, nil
}

func formatTime(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }

func parseTime(value string) (time.Time, error) { return time.Parse(time.RFC3339Nano, value) }
