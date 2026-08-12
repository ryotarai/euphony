package project

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestCreateCanonicalizesAndPersistsAnExistingDirectory(t *testing.T) {
	repo := NewMemoryRepository()
	createdAt := time.Date(2026, 8, 12, 0, 0, 0, 0, time.UTC)
	service := NewService(repo, func() time.Time { return createdAt }, func() string { return "project-1" })
	directory := t.TempDir()

	created, err := service.Create(context.Background(), directory+"/.")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if created.ID != "project-1" || created.Path != directory || !created.CreatedAt.Equal(createdAt) {
		t.Fatalf("created project = %#v", created)
	}
	listed, err := service.List(context.Background())
	if err != nil || len(listed) != 1 || listed[0].ID != created.ID {
		t.Fatalf("List() = %#v, %v", listed, err)
	}
}

func TestCreateRejectsMissingAndDuplicateDirectories(t *testing.T) {
	repo := NewMemoryRepository()
	ids := []string{"project-1", "project-2"}
	service := NewService(repo, time.Now, func() string {
		id := ids[0]
		ids = ids[1:]
		return id
	})
	directory := t.TempDir()
	if _, err := service.Create(context.Background(), filepath.Join(directory, "missing")); err == nil {
		t.Fatal("Create(missing) error = nil")
	}
	if _, err := service.Create(context.Background(), directory); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Create(context.Background(), directory); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("duplicate error = %v", err)
	}
}

func TestGetReturnsCreatedProject(t *testing.T) {
	repo := NewMemoryRepository()
	createdAt := time.Date(2026, 8, 12, 1, 2, 3, 4, time.UTC)
	service := NewService(repo, func() time.Time { return createdAt }, func() string { return "project-1" })
	directory := t.TempDir()

	created, err := service.Create(context.Background(), directory)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	got, err := service.Get(context.Background(), created.ID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if got.ID != created.ID || got.Path != directory || !got.CreatedAt.Equal(createdAt) {
		t.Fatalf("Get() = %#v, want %#v", got, created)
	}
}

func TestListSortsProjectsByCreatedAtThenID(t *testing.T) {
	repo := NewMemoryRepository()
	first := time.Date(2026, 8, 12, 0, 0, 0, 0, time.UTC)
	paths := []string{t.TempDir(), t.TempDir(), t.TempDir()}
	projects := []Project{
		{ID: "project-b", Path: paths[0], CreatedAt: first},
		{ID: "project-a", Path: paths[1], CreatedAt: first},
		{ID: "project-c", Path: paths[2], CreatedAt: first.Add(time.Second)},
	}
	for _, item := range projects {
		if err := repo.Create(context.Background(), item); err != nil {
			t.Fatalf("Create(%q) error = %v", item.ID, err)
		}
	}

	service := NewService(repo, time.Now, func() string { return "unused" })
	listed, err := service.List(context.Background())
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(listed) != 3 {
		t.Fatalf("List() length = %d, want 3", len(listed))
	}
	wantIDs := []string{"project-a", "project-b", "project-c"}
	for index, wantID := range wantIDs {
		if listed[index].ID != wantID {
			t.Fatalf("List()[%d].ID = %q, want %q; list = %#v", index, listed[index].ID, wantID, listed)
		}
	}
}
