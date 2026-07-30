package annotation

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestStoreAllowsOneActiveAnnotationPerTerminal(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	ids := []string{"annotation-1", "annotation-2"}
	store := NewStore(func() time.Time { return now }, func() string {
		id := ids[0]
		ids = ids[1:]
		return id
	})

	created, err := store.Create("terminal-1", "review.md", FormatMarkdown, "# Review")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	want := Session{
		ID:         "annotation-1",
		TerminalID: "terminal-1",
		Filename:   "review.md",
		Format:     FormatMarkdown,
		Content:    "# Review",
		CreatedAt:  now,
	}
	if !reflect.DeepEqual(created, want) {
		t.Fatalf("Create() = %#v, want %#v", created, want)
	}
	current, found := store.Current("terminal-1")
	if !found || !reflect.DeepEqual(current, want) {
		t.Fatalf("Current() = %#v, %v, want %#v, true", current, found, want)
	}
	if _, err := store.Create("terminal-1", "other.html", FormatHTML, "<p>Other</p>"); !errors.Is(err, ErrActive) {
		t.Fatalf("second Create() error = %v, want ErrActive", err)
	}
	if _, err := store.Create("terminal-2", "other.html", FormatHTML, "<p>Other</p>"); err != nil {
		t.Fatalf("Create() for another terminal error = %v", err)
	}
}

func TestStoreWaitReturnsCompletedCommentsAndReleasesTerminal(t *testing.T) {
	store := NewStore(time.Now, func() string { return "annotation-1" })
	session, err := store.Create("terminal-1", "review.md", FormatMarkdown, "Review me")
	if err != nil {
		t.Fatal(err)
	}
	start, end := 4, 13
	comments := []Comment{
		{
			Kind:        CommentSelection,
			Body:        "Make this concrete.",
			Quote:       "Review me",
			StartOffset: &start,
			EndOffset:   &end,
		},
		{Kind: CommentGlobal, Body: "Looks good overall."},
	}
	type waitResult struct {
		result Result
		err    error
	}
	waited := make(chan waitResult, 1)
	go func() {
		result, waitErr := store.Wait(context.Background(), session.ID)
		waited <- waitResult{result: result, err: waitErr}
	}()

	select {
	case result := <-waited:
		t.Fatalf("Wait() returned before completion: %#v, %v", result.result, result.err)
	case <-time.After(20 * time.Millisecond):
	}

	completed, completedSession, err := store.Complete(session.ID, comments)
	if err != nil {
		t.Fatalf("Complete() error = %v", err)
	}
	want := Result{AnnotationID: session.ID, Comments: comments}
	if !reflect.DeepEqual(completed, want) || !reflect.DeepEqual(completedSession, session) {
		t.Fatalf("Complete() = %#v, %#v, want %#v, %#v", completed, completedSession, want, session)
	}
	select {
	case result := <-waited:
		if result.err != nil || !reflect.DeepEqual(result.result, want) {
			t.Fatalf("Wait() = %#v, %v, want %#v, nil", result.result, result.err, want)
		}
	case <-time.After(time.Second):
		t.Fatal("Wait() did not return after completion")
	}
	if _, found := store.Current("terminal-1"); found {
		t.Fatal("Current() found completed annotation")
	}
	if _, _, err := store.Complete(session.ID, nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("duplicate Complete() error = %v, want ErrNotFound", err)
	}

	comments[0].Body = "mutated input"
	completed.Comments[1].Body = "mutated output"
	if want.Comments[0].Body != "mutated input" {
		t.Fatal("test fixture mutation did not occur")
	}
	if resultBody := completedSession.Content; resultBody != "Review me" {
		t.Fatalf("completed session content = %q", resultBody)
	}
}

func TestStoreCancelWakesWaiterAndAllowsAnotherAnnotation(t *testing.T) {
	ids := []string{"annotation-1", "annotation-2"}
	store := NewStore(time.Now, func() string {
		id := ids[0]
		ids = ids[1:]
		return id
	})
	session, err := store.Create("terminal-1", "review.md", FormatMarkdown, "Review")
	if err != nil {
		t.Fatal(err)
	}
	waited := make(chan error, 1)
	go func() {
		_, waitErr := store.Wait(context.Background(), session.ID)
		waited <- waitErr
	}()
	waitForStoreWaiter(t, store, session.ID)

	canceled, err := store.Cancel(session.ID)
	if err != nil || canceled.ID != session.ID {
		t.Fatalf("Cancel() = %#v, %v", canceled, err)
	}
	select {
	case waitErr := <-waited:
		if !errors.Is(waitErr, ErrCanceled) {
			t.Fatalf("Wait() error = %v, want ErrCanceled", waitErr)
		}
	case <-time.After(time.Second):
		t.Fatal("Wait() did not return after cancellation")
	}
	if _, err := store.Create("terminal-1", "next.md", FormatMarkdown, "Next"); err != nil {
		t.Fatalf("Create() after cancellation error = %v", err)
	}
	if _, err := store.Cancel(session.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("duplicate Cancel() error = %v, want ErrNotFound", err)
	}
}

func TestStoreWaitHonorsContextCancellation(t *testing.T) {
	store := NewStore(time.Now, func() string { return "annotation-1" })
	session, err := store.Create("terminal-1", "review.md", FormatMarkdown, "Review")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err = store.Wait(ctx, session.ID)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Wait() error = %v, want context.Canceled", err)
	}
	if current, found := store.Current("terminal-1"); !found || current.ID != session.ID {
		t.Fatalf("Current() = %#v, %v, want active session", current, found)
	}
}

func TestStoreCancelRemovesEntryAfterWaitContextIsCanceled(t *testing.T) {
	store := NewStore(time.Now, func() string { return "annotation-1" })
	session, err := store.Create("terminal-1", "review.md", FormatMarkdown, "Review")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := store.Wait(ctx, session.ID); !errors.Is(err, context.Canceled) {
		t.Fatalf("Wait() error = %v, want context.Canceled", err)
	}

	if _, err := store.Cancel(session.ID); err != nil {
		t.Fatalf("Cancel() error = %v", err)
	}
	if _, found := store.entries[session.ID]; found {
		t.Fatal("canceled entry remains after its waiter exited")
	}
}

func TestStoreCancelWithoutAWaiterRemovesEntry(t *testing.T) {
	store := NewStore(time.Now, func() string { return "annotation-1" })
	session, err := store.Create("terminal-1", "review.md", FormatMarkdown, "Review")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := store.Cancel(session.ID); err != nil {
		t.Fatalf("Cancel() error = %v", err)
	}
	if _, found := store.entries[session.ID]; found {
		t.Fatal("canceled entry remains when no waiter was active")
	}
}

func waitForStoreWaiter(t *testing.T, store *Store, id string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		store.mu.Lock()
		item := store.entries[id]
		waiting := 0
		if item != nil {
			waiting = item.waiting
		}
		store.mu.Unlock()
		if waiting > 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("Wait() did not register a waiter")
		}
		time.Sleep(time.Millisecond)
	}
}
