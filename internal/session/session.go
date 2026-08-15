package session

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// foregroundProcessName reduces a ps command line to the executable name
// shown beside a terminal. Login shells conventionally prefix argv[0] with a
// dash, while arguments are intentionally omitted from the label.
func foregroundProcessName(command string) string {
	fields := strings.Fields(command)
	if len(fields) == 0 {
		return ""
	}
	name := strings.Trim(fields[0], "'\"")
	name = strings.TrimPrefix(name, "-")
	if name == "" {
		return ""
	}
	return filepath.Base(name)
}

var ErrForegroundUnsupported = errors.New("foreground process inspection is unsupported")

type State string

const (
	StateStarting State = "starting"
	StateRunning  State = "running"
	StateExited   State = "exited"
	StateFailed   State = "failed"
)

type Session struct {
	id              string
	command         *exec.Cmd
	terminal        *os.File
	terminalFD      int
	backend         terminalBackend
	waitDone        chan struct{}
	pumpDone        chan struct{}
	close           sync.Once
	fileMu          sync.Mutex
	writeMu         sync.Mutex
	dimensionsMu    sync.Mutex
	cols            uint16
	rows            uint16
	resizeSubmitMu  sync.Mutex
	resizeRequests  chan resizeRequest
	resizeWakeRead  int
	resizeWakeWrite int
	outputMu        sync.Mutex
	history         [][]byte
	historySize     int
	historyLimit    int
	subscribers     map[uint64]*outputSubscriber
	nextSubscriber  uint64
	outputClosed    bool
	afterReadMu     sync.Mutex
	afterRead       func([]byte)
}

type terminalBackend interface {
	write(*Session, []byte) (int, error)
	signalResize(*Session) error
	processPendingResize(*Session)
	pump(*Session)
	terminate(*Session)
	close(*Session)
}

type terminalStart struct {
	terminal        *os.File
	backend         terminalBackend
	resizeWakeRead  int
	resizeWakeWrite int
}

func (s *Session) signalResize() error {
	if s.backend != nil {
		return s.backend.signalResize(s)
	}
	return signalResizeUnix(s)
}

const (
	historyChunkSize       = 32 * 1024
	maxLiveOutputQueueSize = 2 * 1024 * 1024
	maxPTYReadBatchChunks  = 64
)

type outputSubscriber struct {
	mu            sync.Mutex
	queue         []TerminalEvent
	head          int
	queuedBytes   int
	maxQueueBytes int
	closed        bool
	aborted       bool
	eventMode     bool
	notify        chan struct{}
	abort         chan struct{}
	lagged        chan struct{}
	output        chan []byte
	events        chan TerminalEvent
	abortOnce     sync.Once
	laggedOnce    sync.Once
}

type TerminalEvent struct {
	Data []byte
	Cols uint16
	Rows uint16
}

type resizeRequest struct {
	ctx    context.Context
	cols   uint16
	rows   uint16
	notify func()
	done   chan error
}

// outputSubscriber keeps the replay-to-live handoff lossless up to a bounded
// high-water mark without blocking the PTY reader. Lagging clients reconnect
// from a fresh history snapshot instead of growing the queue without limit.
func newOutputSubscriber(maxQueueBytes int) *outputSubscriber {
	return newTerminalSubscriber(maxQueueBytes, false)
}

func newTerminalEventSubscriber(maxQueueBytes int) *outputSubscriber {
	return newTerminalSubscriber(maxQueueBytes, true)
}

func newTerminalSubscriber(maxQueueBytes int, eventMode bool) *outputSubscriber {
	subscriber := &outputSubscriber{
		maxQueueBytes: maxQueueBytes,
		eventMode:     eventMode,
		notify:        make(chan struct{}, 1),
		abort:         make(chan struct{}),
		lagged:        make(chan struct{}),
		output:        make(chan []byte),
		events:        make(chan TerminalEvent),
	}
	go subscriber.run()
	return subscriber
}

func (s *outputSubscriber) enqueue(data []byte) bool {
	return s.enqueueEvent(TerminalEvent{Data: data})
}

func (s *outputSubscriber) enqueueResize(cols, rows uint16) bool {
	return s.enqueueEvent(TerminalEvent{Cols: cols, Rows: rows})
}

func (s *outputSubscriber) enqueueEvent(event TerminalEvent) bool {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return false
	}
	if event.Cols > 0 && event.Rows > 0 && s.head < len(s.queue) {
		last := len(s.queue) - 1
		if s.queue[last].Cols > 0 && s.queue[last].Rows > 0 {
			s.queue[last] = event
			s.mu.Unlock()
			s.signal()
			return true
		}
	}
	if s.queuedBytes+len(event.Data) > s.maxQueueBytes {
		s.closed = true
		s.aborted = true
		s.queue = nil
		s.head = 0
		s.queuedBytes = 0
		s.mu.Unlock()
		s.laggedOnce.Do(func() {
			close(s.lagged)
		})
		s.abortOnce.Do(func() {
			close(s.abort)
		})
		s.signal()
		return false
	}
	s.queue = append(s.queue, event)
	s.queuedBytes += len(event.Data)
	s.mu.Unlock()
	s.signal()
	return true
}

func (s *outputSubscriber) finish() {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	s.signal()
}

func (s *outputSubscriber) abortOutput() {
	s.mu.Lock()
	s.closed = true
	s.aborted = true
	s.queue = nil
	s.head = 0
	s.queuedBytes = 0
	s.mu.Unlock()
	s.abortOnce.Do(func() {
		close(s.abort)
	})
	s.signal()
}

func (s *outputSubscriber) signal() {
	select {
	case s.notify <- struct{}{}:
	default:
	}
}

func (s *outputSubscriber) run() {
	if s.eventMode {
		defer close(s.events)
	} else {
		defer close(s.output)
	}
	for {
		event, ready, open := s.next()
		if !open {
			return
		}
		if !ready {
			select {
			case <-s.notify:
			case <-s.abort:
				return
			}
			continue
		}
		if s.eventMode {
			select {
			case s.events <- event:
			case <-s.abort:
				return
			}
		} else if len(event.Data) > 0 {
			select {
			case s.output <- event.Data:
			case <-s.abort:
				return
			}
		}
	}
}

func (s *outputSubscriber) next() (TerminalEvent, bool, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.aborted {
		return TerminalEvent{}, false, false
	}
	if s.head < len(s.queue) {
		event := s.queue[s.head]
		s.queue[s.head] = TerminalEvent{}
		s.head++
		s.queuedBytes -= len(event.Data)
		if s.head == len(s.queue) {
			s.queue = nil
			s.head = 0
		} else if s.head >= 1024 && s.head*2 >= len(s.queue) {
			s.queue = append([]TerminalEvent(nil), s.queue[s.head:]...)
			s.head = 0
		}
		return event, true, true
	}
	if s.closed {
		return TerminalEvent{}, false, false
	}
	return TerminalEvent{}, false, true
}

func (s *Session) Write(data []byte) (int, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	s.fileMu.Lock()
	if s.terminal == nil || s.terminalFD < 0 {
		s.fileMu.Unlock()
		return 0, errors.New("terminal is closed")
	}
	backend := s.backend
	s.fileMu.Unlock()
	if backend != nil {
		return backend.write(s, data)
	}
	return writeTerminalUnix(s, data)
}

func (s *Session) Resize(cols, rows uint16) error {
	return s.ResizeWithNotificationContext(context.Background(), cols, rows, nil)
}

// ResizeWithNotification submits the resize to the PTY event loop. The loop
// drains readable output first, then calls notify after applying the size and
// before reading more output.
func (s *Session) ResizeWithNotification(
	cols, rows uint16,
	notify func(),
) error {
	return s.ResizeWithNotificationContext(context.Background(), cols, rows, notify)
}

// ResizeWithNotificationContext submits a resize that can be canceled while
// the PTY event loop is busy. A canceled request remains safe to consume from
// the event loop, but it never changes the stored dimensions or publishes a
// resize notification.
func (s *Session) ResizeWithNotificationContext(
	ctx context.Context,
	cols, rows uint16,
	notify func(),
) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if cols < 1 || cols > 1000 || rows < 1 || rows > 1000 {
		return errors.New("terminal dimensions must be between 1 and 1000")
	}
	if s.resizeRequests == nil {
		return errors.New("terminal resize loop is not running")
	}

	s.resizeSubmitMu.Lock()
	defer s.resizeSubmitMu.Unlock()
	select {
	case <-s.pumpDone:
		return errors.New("terminal output loop is closed")
	default:
	}
	request := resizeRequest{
		ctx:    ctx,
		cols:   cols,
		rows:   rows,
		notify: notify,
		done:   make(chan error, 1),
	}
	select {
	case s.resizeRequests <- request:
	case <-s.pumpDone:
		return errors.New("terminal output loop is closed")
	case <-ctx.Done():
		return ctx.Err()
	}
	if err := s.signalResize(); err != nil {
		select {
		case <-s.resizeRequests:
		default:
		}
		select {
		case <-s.pumpDone:
			return errors.New("terminal output loop is closed")
		default:
			return err
		}
	}
	select {
	case err := <-request.done:
		return err
	case <-s.pumpDone:
		select {
		case err := <-request.done:
			return err
		default:
			return errors.New("terminal output loop is closed")
		}
	case <-ctx.Done():
		select {
		case err := <-request.done:
			return err
		default:
			return ctx.Err()
		}
	}
}

func (s *Session) Dimensions() (uint16, uint16) {
	s.dimensionsMu.Lock()
	defer s.dimensionsMu.Unlock()
	return s.cols, s.rows
}

func (s *Session) WorkingDirectory() (string, error) {
	if s.command.Process == nil {
		return "", errors.New("terminal process has not started")
	}
	return processWorkingDirectory(s.command.Process.Pid)
}

func (s *Session) HistorySnapshot(maxBytes int) ([]byte, bool) {
	s.outputMu.Lock()
	size := s.historySize
	data := make([]byte, 0, size)
	for _, chunk := range s.history {
		data = append(data, chunk...)
	}
	s.outputMu.Unlock()
	if maxBytes > 0 && len(data) > maxBytes {
		return append([]byte(nil), data[len(data)-maxBytes:]...), true
	}
	return data, false
}

func (s *Session) Subscribe() ([][]byte, <-chan []byte, func()) {
	history, output, _, unsubscribe := s.SubscribeWithStatus()
	return history, output, unsubscribe
}

func (s *Session) SubscribeWithStatus() ([][]byte, <-chan []byte, <-chan struct{}, func()) {
	subscriber := newOutputSubscriber(maxLiveOutputQueueSize)
	history, unsubscribe := s.subscribe(subscriber)
	return history, subscriber.output, subscriber.lagged, unsubscribe
}

func (s *Session) SubscribeTerminalEventsWithStatus() (
	[][]byte,
	<-chan TerminalEvent,
	<-chan struct{},
	func(uint16, uint16),
	func(),
) {
	subscriber := newTerminalEventSubscriber(maxLiveOutputQueueSize)
	history, unsubscribe := s.subscribe(subscriber)
	// The coordinator calls enqueueResize only from ResizeWithNotification's
	// notify callback, except when acknowledging an unchanged initial size.
	enqueueResize := func(cols, rows uint16) {
		subscriber.enqueueResize(cols, rows)
	}
	return history, subscriber.events, subscriber.lagged, enqueueResize, unsubscribe
}

func (s *Session) subscribe(subscriber *outputSubscriber) ([][]byte, func()) {
	s.outputMu.Lock()
	history := append([][]byte(nil), s.history...)
	id := s.nextSubscriber
	s.nextSubscriber++
	if s.outputClosed {
		subscriber.finish()
	} else {
		s.subscribers[id] = subscriber
	}
	s.outputMu.Unlock()

	var once sync.Once
	unsubscribe := func() {
		once.Do(func() {
			s.outputMu.Lock()
			if _, ok := s.subscribers[id]; ok {
				delete(s.subscribers, id)
			}
			s.outputMu.Unlock()
			subscriber.abortOutput()
		})
	}
	return history, unsubscribe
}

func (s *Session) finishOutput() {
	s.outputMu.Lock()
	s.outputClosed = true
	for id, subscriber := range s.subscribers {
		delete(s.subscribers, id)
		subscriber.finish()
	}
	s.outputMu.Unlock()
}

func (s *Session) setAfterReadHook(hook func([]byte)) {
	s.afterReadMu.Lock()
	s.afterRead = hook
	s.afterReadMu.Unlock()
}

func (s *Session) publish(data []byte) {
	chunk := append([]byte(nil), data...)
	s.outputMu.Lock()
	for len(data) > 0 {
		size := min(len(data), historyChunkSize)
		s.history = append(s.history, append([]byte(nil), data[:size]...))
		s.historySize += size
		data = data[size:]
	}
	s.trimHistoryLocked()
	for id, subscriber := range s.subscribers {
		if !subscriber.enqueue(chunk) {
			delete(s.subscribers, id)
		}
	}
	s.outputMu.Unlock()
}

func (s *Session) setHistoryLimit(limit int) {
	s.outputMu.Lock()
	s.historyLimit = limit
	s.trimHistoryLocked()
	s.outputMu.Unlock()
}

func (s *Session) trimHistoryLocked() {
	if s.historyLimit <= 0 {
		return
	}
	excess := s.historySize - s.historyLimit
	for excess > 0 {
		first := s.history[0]
		if len(first) <= excess {
			s.history[0] = nil
			s.history = s.history[1:]
			s.historySize -= len(first)
			excess -= len(first)
			continue
		}
		s.history[0] = append([]byte(nil), first[excess:]...)
		s.historySize -= excess
		excess = 0
	}
}

func (s *Session) terminate() {
	s.close.Do(func() {
		s.fileMu.Lock()
		backend := s.backend
		process := s.command.Process
		s.fileMu.Unlock()
		if process != nil {
			_ = process.Kill()
		}
		if backend != nil {
			backend.terminate(s)
		}
	})
}

func (s *Session) wait() error {
	<-s.waitDone
	return nil
}
