package server

import (
	"context"
	"sync"

	"github.com/ryotarai/euphony/internal/session"
)

const terminalOutputFrameBytes = 64 * 1024

// terminalOutputGate stops one WebSocket writer without stopping the shared
// PTY. A session can have several subscribers, so backpressure must remain
// scoped to the connection that reported a full xterm write queue.
type terminalOutputGate struct {
	mu      sync.Mutex
	paused  bool
	resumed chan struct{}
}

func newTerminalOutputGate() *terminalOutputGate {
	return &terminalOutputGate{}
}

func (g *terminalOutputGate) pause() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.paused {
		return
	}
	g.paused = true
	g.resumed = make(chan struct{})
}

func (g *terminalOutputGate) resume() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.paused {
		return
	}
	g.paused = false
	close(g.resumed)
	g.resumed = nil
}

func (g *terminalOutputGate) wait(ctx context.Context) error {
	for {
		g.mu.Lock()
		if !g.paused {
			g.mu.Unlock()
			return nil
		}
		resumed := g.resumed
		g.mu.Unlock()

		select {
		case <-resumed:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// terminalEventBatcher reduces WebSocket and JSON frame overhead while
// preserving resize ordering. It only drains already-available adjacent
// output events and never waits to manufacture latency.
type terminalEventBatcher struct {
	maxBytes int
	pending  *session.TerminalEvent
}

func newTerminalEventBatcher(maxBytes int) *terminalEventBatcher {
	if maxBytes < 1 {
		maxBytes = 1
	}
	return &terminalEventBatcher{maxBytes: maxBytes}
}

func batchTerminalHistory(history [][]byte, maxBytes int) [][]byte {
	if maxBytes < 1 {
		maxBytes = 1
	}
	batched := make([][]byte, 0, len(history))
	var current []byte
	flush := func() {
		if len(current) == 0 {
			return
		}
		batched = append(batched, current)
		current = nil
	}
	for _, chunk := range history {
		if len(chunk) == 0 {
			continue
		}
		if len(chunk) > maxBytes {
			flush()
			batched = append(batched, chunk)
			continue
		}
		if len(current) == 0 {
			current = chunk
			continue
		}
		if len(current)+len(chunk) > maxBytes {
			flush()
			current = chunk
			continue
		}
		combined := make([]byte, 0, len(current)+len(chunk))
		combined = append(combined, current...)
		current = append(combined, chunk...)
	}
	flush()
	return batched
}

func (b *terminalEventBatcher) next(
	ctx context.Context,
	events <-chan session.TerminalEvent,
) (session.TerminalEvent, bool, error) {
	if b.pending != nil {
		event := *b.pending
		b.pending = nil
		return event, true, nil
	}
	var event session.TerminalEvent
	var ok bool
	select {
	case event, ok = <-events:
		if !ok {
			return session.TerminalEvent{}, false, nil
		}
	case <-ctx.Done():
		return session.TerminalEvent{}, false, ctx.Err()
	}
	if event.Cols > 0 && event.Rows > 0 || len(event.Data) == 0 {
		return event, true, nil
	}

	data := append([]byte(nil), event.Data...)
	for len(data) < b.maxBytes {
		select {
		case next, ok := <-events:
			if !ok {
				return session.TerminalEvent{Data: data}, true, nil
			}
			if next.Cols > 0 && next.Rows > 0 || len(next.Data) == 0 {
				b.pending = &next
				return session.TerminalEvent{Data: data}, true, nil
			}
			if len(data)+len(next.Data) > b.maxBytes {
				b.pending = &next
				return session.TerminalEvent{Data: data}, true, nil
			}
			data = append(data, next.Data...)
		default:
			return session.TerminalEvent{Data: data}, true, nil
		}
	}
	return session.TerminalEvent{Data: data}, true, nil
}
