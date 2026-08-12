package project

import (
	"context"
	"errors"
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

func TestSQLiteRepositoryRejectsDuplicateIDsAndPaths(t *testing.T) {
	repo, err := OpenSQLiteRepository(":memory:")
	if err != nil {
		t.Fatalf("OpenSQLiteRepository() error = %v", err)
	}
	defer func() { _ = repo.Close() }()

	createdAt := time.Date(2026, 8, 12, 0, 0, 0, 0, time.UTC)
	first := Project{ID: "project-1", Path: t.TempDir(), CreatedAt: createdAt}
	if err := repo.Create(context.Background(), first); err != nil {
		t.Fatalf("Create(first) error = %v", err)
	}
	cases := []struct {
		name    string
		project Project
	}{
		{
			name:    "duplicate ID",
			project: Project{ID: first.ID, Path: t.TempDir(), CreatedAt: createdAt.Add(time.Second)},
		},
		{
			name:    "duplicate path",
			project: Project{ID: "project-2", Path: first.Path, CreatedAt: createdAt.Add(time.Second)},
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if err := repo.Create(context.Background(), test.project); !errors.Is(err, ErrAlreadyExists) {
				t.Fatalf("Create() error = %v, want ErrAlreadyExists", err)
			}
		})
	}
}

func TestSQLiteRepositoryListsProjectsByCreatedAtThenID(t *testing.T) {
	repo, err := OpenSQLiteRepository(":memory:")
	if err != nil {
		t.Fatalf("OpenSQLiteRepository() error = %v", err)
	}
	defer func() { _ = repo.Close() }()

	createdAt := time.Date(2026, 8, 12, 0, 0, 0, 0, time.UTC)
	projects := []Project{
		{ID: "later", Path: t.TempDir(), CreatedAt: createdAt.Add(500 * time.Millisecond)},
		{ID: "same-b", Path: t.TempDir(), CreatedAt: createdAt},
		{ID: "same-a", Path: t.TempDir(), CreatedAt: createdAt},
		{ID: "earlier", Path: t.TempDir(), CreatedAt: createdAt.Add(-time.Second)},
	}
	for _, project := range projects {
		if err := repo.Create(context.Background(), project); err != nil {
			t.Fatalf("Create(%q) error = %v", project.ID, err)
		}
	}

	listed, err := repo.List(context.Background())
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	wantIDs := []string{"earlier", "same-a", "same-b", "later"}
	if len(listed) != len(wantIDs) {
		t.Fatalf("List() length = %d, want %d; list = %#v", len(listed), len(wantIDs), listed)
	}
	for index, wantID := range wantIDs {
		if listed[index].ID != wantID {
			t.Fatalf("List()[%d].ID = %q, want %q; list = %#v", index, listed[index].ID, wantID, listed)
		}
	}
}
