package project

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type Repository interface {
	Create(context.Context, Project) error
	Get(context.Context, string) (Project, error)
	List(context.Context) ([]Project, error)
	Reorder(context.Context, []string) error
	Delete(context.Context, string) error
	Close() error
}

type memoryRepository struct {
	mu       sync.RWMutex
	projects map[string]Project
}

func NewMemoryRepository() Repository {
	return &memoryRepository{projects: make(map[string]Project)}
}

func (r *memoryRepository) Create(_ context.Context, project Project) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.projects[project.ID]; exists {
		return ErrAlreadyExists
	}
	for _, existing := range r.projects {
		if existing.Path == project.Path {
			return ErrAlreadyExists
		}
	}
	r.projects[project.ID] = project
	return nil
}

func (r *memoryRepository) Get(_ context.Context, id string) (Project, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	project, exists := r.projects[id]
	if !exists {
		return Project{}, ErrNotFound
	}
	return project, nil
}

func (r *memoryRepository) Delete(_ context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.projects[id]; !exists {
		return ErrNotFound
	}
	delete(r.projects, id)
	return nil
}

func (r *memoryRepository) List(_ context.Context) ([]Project, error) {
	r.mu.RLock()
	projects := make([]Project, 0, len(r.projects))
	for _, project := range r.projects {
		projects = append(projects, project)
	}
	r.mu.RUnlock()
	sortProjects(projects)
	return projects, nil
}

func (r *memoryRepository) Reorder(_ context.Context, orderedIDs []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(orderedIDs) != len(r.projects) {
		return ErrInvalidOrder
	}
	seen := make(map[string]struct{}, len(orderedIDs))
	for index, id := range orderedIDs {
		project, ok := r.projects[id]
		if !ok {
			return ErrNotFound
		}
		if _, duplicate := seen[id]; duplicate {
			return ErrInvalidOrder
		}
		seen[id] = struct{}{}
		project.Order = int64(index + 1)
		r.projects[id] = project
	}
	return nil
}

func (*memoryRepository) Close() error { return nil }

type SQLiteRepository struct {
	db *sql.DB
}

func OpenSQLiteRepository(path string) (Repository, error) {
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, fmt.Errorf("create project database directory: %w", err)
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open project database: %w", err)
	}
	db.SetMaxOpenConns(1)
	repository := &SQLiteRepository{db: db}
	if err := repository.migrate(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	return repository, nil
}

func (r *SQLiteRepository) migrate(ctx context.Context) error {
	for _, statement := range []string{
		"PRAGMA busy_timeout = 5000",
		`CREATE TABLE IF NOT EXISTS projects (
			id TEXT PRIMARY KEY,
			path TEXT UNIQUE NOT NULL,
			created_at TEXT NOT NULL,
			sort_order INTEGER NOT NULL DEFAULT 0
		)`,
	} {
		if _, err := r.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate project database: %w", err)
		}
	}
	hasOrder, err := r.hasColumn(ctx, "projects", "sort_order")
	if err != nil {
		return err
	}
	if !hasOrder {
		if _, err := r.db.ExecContext(ctx,
			"ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
		); err != nil {
			return fmt.Errorf("add project order: %w", err)
		}
	}
	return nil
}

func (r *SQLiteRepository) Create(ctx context.Context, project Project) error {
	result, err := r.db.ExecContext(ctx, `INSERT INTO projects (id, path, created_at, sort_order)
		VALUES (?, ?, ?, ?)
		ON CONFLICT DO NOTHING`, project.ID, project.Path, formatTime(project.CreatedAt), project.Order)
	if err != nil {
		return fmt.Errorf("create project: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("create project result: %w", err)
	}
	if rows == 0 {
		return ErrAlreadyExists
	}
	return nil
}

func (r *SQLiteRepository) Get(ctx context.Context, id string) (Project, error) {
	row := r.db.QueryRowContext(ctx,
		"SELECT id, path, created_at, sort_order FROM projects WHERE id = ?", id)
	project, err := scanProject(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Project{}, ErrNotFound
	}
	if err != nil {
		return Project{}, fmt.Errorf("get project: %w", err)
	}
	return project, nil
}

func (r *SQLiteRepository) Delete(ctx context.Context, id string) error {
	result, err := r.db.ExecContext(ctx, "DELETE FROM projects WHERE id = ?", id)
	if err != nil {
		return fmt.Errorf("delete project: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete project result: %w", err)
	}
	if rows == 0 {
		return ErrNotFound
	}
	return nil
}

func (r *SQLiteRepository) List(ctx context.Context) ([]Project, error) {
	rows, err := r.db.QueryContext(ctx,
		"SELECT id, path, created_at, sort_order FROM projects ORDER BY sort_order, created_at, id")
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	defer rows.Close()
	projects := make([]Project, 0)
	for rows.Next() {
		project, err := scanProject(rows)
		if err != nil {
			return nil, fmt.Errorf("scan project: %w", err)
		}
		projects = append(projects, project)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	sortProjects(projects)
	return projects, nil
}

func (r *SQLiteRepository) Reorder(ctx context.Context, orderedIDs []string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin project reorder: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	for index, id := range orderedIDs {
		result, err := tx.ExecContext(ctx,
			"UPDATE projects SET sort_order = ? WHERE id = ?", index+1, id)
		if err != nil {
			return fmt.Errorf("reorder project: %w", err)
		}
		rows, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("reorder project result: %w", err)
		}
		if rows != 1 {
			return ErrNotFound
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit project reorder: %w", err)
	}
	return nil
}

func (r *SQLiteRepository) Close() error {
	return r.db.Close()
}

type projectScanner interface {
	Scan(...any) error
}

func scanProject(scanner projectScanner) (Project, error) {
	var project Project
	var createdAt string
	if err := scanner.Scan(&project.ID, &project.Path, &createdAt, &project.Order); err != nil {
		return Project{}, err
	}
	var err error
	project.CreatedAt, err = parseTime(createdAt)
	if err != nil {
		return Project{}, fmt.Errorf("parse project timestamp: %w", err)
	}
	return project, nil
}

func (r *SQLiteRepository) hasColumn(ctx context.Context, table, column string) (bool, error) {
	rows, err := r.db.QueryContext(ctx, "PRAGMA table_info("+table+")")
	if err != nil {
		return false, fmt.Errorf("inspect project schema: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, dataType string
		var notNull, primaryKey int
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &dataType, &notNull, &defaultValue, &primaryKey); err != nil {
			return false, fmt.Errorf("scan project schema: %w", err)
		}
		if name == column {
			return true, nil
		}
	}
	if err := rows.Err(); err != nil {
		return false, fmt.Errorf("inspect project schema: %w", err)
	}
	return false, nil
}

func formatTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}

func parseTime(value string) (time.Time, error) {
	return time.Parse(time.RFC3339Nano, value)
}
