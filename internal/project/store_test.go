package project

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestMemoryRepositoryRejectsDuplicatePaths(t *testing.T) {
	repo := NewMemoryRepository()
	path := t.TempDir()
	want := Project{
		ID:        "project-1",
		Path:      path,
		CreatedAt: time.Date(2026, 8, 12, 0, 0, 0, 0, time.UTC),
	}
	if err := repo.Create(context.Background(), want); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := repo.Create(context.Background(), Project{
		ID:        "project-2",
		Path:      path,
		CreatedAt: want.CreatedAt.Add(time.Second),
	}); err != ErrAlreadyExists {
		t.Fatalf("duplicate Create() error = %v, want ErrAlreadyExists", err)
	}
}

func TestSQLiteRepositoryPersistsProjectsAfterReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "projects.sqlite3")
	want := Project{
		ID:        "project-1",
		Path:      t.TempDir(),
		CreatedAt: time.Date(2026, 8, 12, 1, 2, 3, 4, time.UTC),
	}

	repo, err := OpenSQLiteRepository(path)
	if err != nil {
		t.Fatalf("OpenSQLiteRepository() error = %v", err)
	}
	if err := repo.Create(context.Background(), want); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := repo.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	reopened, err := OpenSQLiteRepository(path)
	if err != nil {
		t.Fatalf("reopen error = %v", err)
	}
	defer func() { _ = reopened.Close() }()
	got, err := reopened.Get(context.Background(), want.ID)
	if err != nil {
		t.Fatalf("Get() after reopen error = %v", err)
	}
	if got != want {
		t.Fatalf("Get() after reopen = %#v, want %#v", got, want)
	}
	listed, err := reopened.List(context.Background())
	if err != nil || len(listed) != 1 || listed[0] != want {
		t.Fatalf("List() after reopen = %#v, %v; want %#v", listed, err, []Project{want})
	}
}
