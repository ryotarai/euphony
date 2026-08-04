package tasks

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestMemoryStoreRoundTripAndCoalescesLatestUpdate(t *testing.T) {
	store := NewMemoryStore()
	ctx := context.Background()
	createdAt := time.Date(2026, 8, 5, 0, 0, 0, 0, time.UTC)
	task := Task{
		ID:          "task-1",
		Title:       "Ship task pane",
		Description: "Connect tasks to agents.",
		Priority:    PriorityHigh,
		Status:      StatusTodo,
		CreatedAt:   createdAt,
		UpdatedAt:   createdAt,
	}
	if err := store.Create(ctx, task); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != task.Title || got.Priority != PriorityHigh || got.Status != StatusTodo {
		t.Fatalf("Get() = %#v, want %#v", got, task)
	}

	update := TaskUpdate{
		ID:        "update-1",
		TaskID:    task.ID,
		Kind:      UpdateAgentStatus,
		Body:      "Agent is waiting.",
		CreatedAt: createdAt.Add(time.Minute),
	}
	added, err := store.AppendUpdate(ctx, update)
	if err != nil || !added {
		t.Fatalf("AppendUpdate() = %v, %v; want true", added, err)
	}
	duplicate := update
	duplicate.ID = "update-2"
	duplicate.CreatedAt = update.CreatedAt.Add(time.Minute)
	added, err = store.AppendUpdate(ctx, duplicate)
	if err != nil || added {
		t.Fatalf("duplicate AppendUpdate() = %v, %v; want false", added, err)
	}
	updates, err := store.ListUpdates(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(updates) != 1 || updates[0].Body != update.Body {
		t.Fatalf("ListUpdates() = %#v, want one update", updates)
	}
}

func TestSQLiteStorePersistsTasksAndDeletesUpdates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tasks.sqlite3")
	ctx := context.Background()
	createdAt := time.Date(2026, 8, 5, 1, 0, 0, 0, time.UTC)
	store, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	task := Task{
		ID:        "task-persisted",
		Title:     "Persist tasks",
		Priority:  PriorityMedium,
		Status:    StatusInProgress,
		CreatedAt: createdAt,
		UpdatedAt: createdAt,
	}
	if err := store.Create(ctx, task); err != nil {
		t.Fatal(err)
	}
	if added, err := store.AppendUpdate(ctx, TaskUpdate{
		ID:        "update-persisted",
		TaskID:    task.ID,
		Kind:      UpdateSystem,
		Body:      "Started agent.",
		CreatedAt: createdAt.Add(time.Second),
	}); err != nil || !added {
		t.Fatalf("AppendUpdate() = %v, %v", added, err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	got, err := reopened.Get(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != task.Title || got.Status != StatusInProgress {
		t.Fatalf("reopened Get() = %#v", got)
	}
	updates, err := reopened.ListUpdates(ctx, task.ID)
	if err != nil || len(updates) != 1 {
		t.Fatalf("reopened ListUpdates() = %#v, %v", updates, err)
	}
	if err := reopened.Delete(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.Get(ctx, task.ID); err != ErrNotFound {
		t.Fatalf("Get after Delete() error = %v, want ErrNotFound", err)
	}
	if _, err := reopened.ListUpdates(ctx, task.ID); err != ErrNotFound {
		t.Fatalf("ListUpdates after Delete() error = %v, want ErrNotFound", err)
	}
	if err := reopened.Close(); err != nil {
		t.Fatal(err)
	}
}
