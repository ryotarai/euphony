package session

import (
	"errors"
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
)

var ErrForegroundUnsupported = errors.New("foreground process inspection is unsupported")

type State string

const (
	StateStarting State = "starting"
	StateRunning  State = "running"
	StateExited   State = "exited"
	StateFailed   State = "failed"
)

type Session struct {
	id             string
	command        *exec.Cmd
	terminal       *os.File
	waitDone       chan struct{}
	pumpDone       chan struct{}
	close          sync.Once
	fileMu         sync.Mutex
	outputMu       sync.Mutex
	history        [][]byte
	historySize    int
	historyLimit   int
	subscribers    map[uint64]*outputSubscriber
	nextSubscriber uint64
	outputClosed   bool
}

const (
	historyChunkSize       = 32 * 1024
	maxLiveOutputQueueSize = 2 * 1024 * 1024
)

type outputSubscriber struct {
	mu            sync.Mutex
	queue         [][]byte
	head          int
	queuedBytes   int
	maxQueueBytes int
	closed        bool
	aborted       bool
	notify        chan struct{}
	abort         chan struct{}
	lagged        chan struct{}
	output        chan []byte
	abortOnce     sync.Once
	laggedOnce    sync.Once
}

// outputSubscriber keeps the replay-to-live handoff lossless up to a bounded
// high-water mark without blocking the PTY reader. Lagging clients reconnect
// from a fresh history snapshot instead of growing the queue without limit.
func newOutputSubscriber(maxQueueBytes int) *outputSubscriber {
	subscriber := &outputSubscriber{
		maxQueueBytes: maxQueueBytes,
		notify:        make(chan struct{}, 1),
		abort:         make(chan struct{}),
		lagged:        make(chan struct{}),
		output:        make(chan []byte),
	}
	go subscriber.run()
	return subscriber
}

func (s *outputSubscriber) enqueue(data []byte) bool {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return false
	}
	if s.queuedBytes+len(data) > s.maxQueueBytes {
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
	s.queue = append(s.queue, data)
	s.queuedBytes += len(data)
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
	defer close(s.output)
	for {
		data, ready, open := s.next()
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
		select {
		case s.output <- data:
		case <-s.abort:
			return
		}
	}
}

func (s *outputSubscriber) next() ([]byte, bool, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.aborted {
		return nil, false, false
	}
	if s.head < len(s.queue) {
		data := s.queue[s.head]
		s.queue[s.head] = nil
		s.head++
		s.queuedBytes -= len(data)
		if s.head == len(s.queue) {
			s.queue = nil
			s.head = 0
		} else if s.head >= 1024 && s.head*2 >= len(s.queue) {
			s.queue = append([][]byte(nil), s.queue[s.head:]...)
			s.head = 0
		}
		return data, true, true
	}
	if s.closed {
		return nil, false, false
	}
	return nil, false, true
}

func (s *Session) Write(data []byte) (int, error) {
	s.fileMu.Lock()
	defer s.fileMu.Unlock()
	return s.terminal.Write(data)
}

func (s *Session) Resize(cols, rows uint16) error {
	if cols < 1 || cols > 1000 || rows < 1 || rows > 1000 {
		return errors.New("terminal dimensions must be between 1 and 1000")
	}
	s.fileMu.Lock()
	defer s.fileMu.Unlock()
	return pty.Setsize(s.terminal, &pty.Winsize{Cols: cols, Rows: rows})
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
	s.outputMu.Lock()
	history := append([][]byte(nil), s.history...)
	id := s.nextSubscriber
	s.nextSubscriber++
	subscriber := newOutputSubscriber(maxLiveOutputQueueSize)
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
	return history, subscriber.output, subscriber.lagged, unsubscribe
}

func (s *Session) pump() {
	defer close(s.pumpDone)
	buffer := make([]byte, 32*1024)
	for {
		n, err := s.terminal.Read(buffer)
		if n > 0 {
			s.publish(buffer[:n])
		}
		if err != nil {
			s.outputMu.Lock()
			s.outputClosed = true
			for id, subscriber := range s.subscribers {
				delete(s.subscribers, id)
				subscriber.finish()
			}
			s.outputMu.Unlock()
			return
		}
	}
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
		defer s.fileMu.Unlock()
		if s.command.Process != nil {
			_ = s.command.Process.Kill()
		}
		_ = s.terminal.Close()
	})
}

func (s *Session) wait() error {
	<-s.waitDone
	return nil
}
