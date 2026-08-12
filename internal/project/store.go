package project

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
	Create(context.Context, Project) error
	Get(context.Context, string) (Project, error)
	List(context.Context) ([]Project, error)
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

func (r *memoryRepository) List(_ context.Context) ([]Project, error) {
	r.mu.RLock()
	projects := make([]Project, 0, len(r.projects))
	for _, project := range r.projects {
		projects = append(projects, project)
	}
	r.mu.RUnlock()
	sort.SliceStable(projects, func(i, j int) bool {
		if projects[i].CreatedAt.Equal(projects[j].CreatedAt) {
			return projects[i].ID < projects[j].ID
		}
		return projects[i].CreatedAt.Before(projects[j].CreatedAt)
	})
	return projects, nil
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
			created_at TEXT NOT NULL
		)`,
	} {
		if _, err := r.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate project database: %w", err)
		}
	}
	return nil
}

func (r *SQLiteRepository) Create(ctx context.Context, project Project) error {
	result, err := r.db.ExecContext(ctx, `INSERT INTO projects (id, path, created_at)
		VALUES (?, ?, ?)
		ON CONFLICT DO NOTHING`, project.ID, project.Path, formatTime(project.CreatedAt))
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
		"SELECT id, path, created_at FROM projects WHERE id = ?", id)
	project, err := scanProject(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Project{}, ErrNotFound
	}
	if err != nil {
		return Project{}, fmt.Errorf("get project: %w", err)
	}
	return project, nil
}

func (r *SQLiteRepository) List(ctx context.Context) ([]Project, error) {
	rows, err := r.db.QueryContext(ctx,
		"SELECT id, path, created_at FROM projects ORDER BY created_at, id")
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

func (r *SQLiteRepository) Close() error {
	return r.db.Close()
}

type projectScanner interface {
	Scan(...any) error
}

func scanProject(scanner projectScanner) (Project, error) {
	var project Project
	var createdAt string
	if err := scanner.Scan(&project.ID, &project.Path, &createdAt); err != nil {
		return Project{}, err
	}
	var err error
	project.CreatedAt, err = parseTime(createdAt)
	if err != nil {
		return Project{}, fmt.Errorf("parse project timestamp: %w", err)
	}
	return project, nil
}

func formatTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}

func parseTime(value string) (time.Time, error) {
	return time.Parse(time.RFC3339Nano, value)
}
