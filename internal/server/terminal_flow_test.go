package server

import (
	"context"
	"testing"
	"time"

	"github.com/ryotarai/euphony/internal/session"
)

func TestTerminalOutputGateWaitsForResume(t *testing.T) {
	gate := newTerminalOutputGate()
	gate.pause()

	completed := make(chan error, 1)
	go func() {
		completed <- gate.wait(t.Context())
	}()

	select {
	case err := <-completed:
		t.Fatalf("wait() completed while paused: %v", err)
	case <-time.After(20 * time.Millisecond):
	}

	gate.resume()
	select {
	case err := <-completed:
		if err != nil {
			t.Fatalf("wait() after resume error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("wait() did not resume")
	}
}

func TestTerminalEventBatcherPreservesResizeBoundaries(t *testing.T) {
	events := make(chan session.TerminalEvent, 4)
	events <- session.TerminalEvent{Data: []byte("one")}
	events <- session.TerminalEvent{Data: []byte("two")}
	events <- session.TerminalEvent{Cols: 80, Rows: 24}
	events <- session.TerminalEvent{Data: []byte("three")}
	batcher := newTerminalEventBatcher(16)

	first, ok, err := batcher.next(t.Context(), events)
	if err != nil || !ok || string(first.Data) != "onetwo" {
		t.Fatalf("first batch = %#v, ok=%v, err=%v", first, ok, err)
	}
	resize, ok, err := batcher.next(t.Context(), events)
	if err != nil || !ok || resize.Cols != 80 || resize.Rows != 24 {
		t.Fatalf("resize batch = %#v, ok=%v, err=%v", resize, ok, err)
	}
	last, ok, err := batcher.next(t.Context(), events)
	if err != nil || !ok || string(last.Data) != "three" {
		t.Fatalf("last batch = %#v, ok=%v, err=%v", last, ok, err)
	}
}

func TestTerminalEventBatcherDoesNotCrossByteLimit(t *testing.T) {
	events := make(chan session.TerminalEvent, 2)
	events <- session.TerminalEvent{Data: []byte("1234")}
	events <- session.TerminalEvent{Data: []byte("5678")}
	batcher := newTerminalEventBatcher(6)

	first, ok, err := batcher.next(t.Context(), events)
	if err != nil || !ok || string(first.Data) != "1234" {
		t.Fatalf("first batch = %#v, ok=%v, err=%v", first, ok, err)
	}
	second, ok, err := batcher.next(t.Context(), events)
	if err != nil || !ok || string(second.Data) != "5678" {
		t.Fatalf("second batch = %#v, ok=%v, err=%v", second, ok, err)
	}
}

func TestBatchTerminalHistoryCoalescesAdjacentChunks(t *testing.T) {
	batched := batchTerminalHistory([][]byte{
		[]byte("one"),
		[]byte("two"),
		[]byte("three"),
	}, 8)

	if len(batched) != 2 {
		t.Fatalf("batched history length = %d, want 2", len(batched))
	}
	if string(batched[0]) != "onetwo" || string(batched[1]) != "three" {
		t.Fatalf("batched history = %q, %q", batched[0], batched[1])
	}
}

func TestTerminalOutputGateHonorsContextCancellation(t *testing.T) {
	gate := newTerminalOutputGate()
	gate.pause()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	if err := gate.wait(ctx); err == nil {
		t.Fatal("wait() error = nil, want context cancellation")
	}
}
