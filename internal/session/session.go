package session

import (
	"errors"
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
)

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
	history        []byte
	subscribers    map[uint64]*subscriber
	nextSubscriber uint64
	outputClosed   bool
}

const (
	historyLimit = 1024 * 1024
	backlogLimit = 4 * 1024 * 1024
	chunkLimit   = 256 * 1024
)

// subscriber coalesces terminal bytes for a single reader. A PTY delivers
// bursts as many line-sized chunks, so a reader that is briefly descheduled
// must keep the stream instead of being dropped: pending bytes accumulate and
// are handed over as one chunk once the reader comes back.
type subscriber struct {
	output  chan []byte
	notify  chan struct{}
	done    chan struct{}
	pending []byte
	closed  bool
}

func (sub *subscriber) signal() {
	select {
	case sub.notify <- struct{}{}:
	default:
	}
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

func (s *Session) Subscribe() ([]byte, <-chan []byte, func()) {
	sub := &subscriber{
		output: make(chan []byte),
		notify: make(chan struct{}, 1),
		done:   make(chan struct{}),
	}
	s.outputMu.Lock()
	history := append([]byte(nil), s.history...)
	id := s.nextSubscriber
	s.nextSubscriber++
	sub.closed = s.outputClosed
	if !sub.closed {
		s.subscribers[id] = sub
	}
	s.outputMu.Unlock()
	go s.forward(sub)

	var once sync.Once
	unsubscribe := func() {
		once.Do(func() {
			s.outputMu.Lock()
			delete(s.subscribers, id)
			s.outputMu.Unlock()
			close(sub.done)
		})
	}
	return history, sub.output, unsubscribe
}

// forward hands coalesced output to one reader. The channel is closed only when
// the terminal stream itself ended, so a closed channel always means the
// process is gone and never that the reader fell behind.
func (s *Session) forward(sub *subscriber) {
	for {
		s.outputMu.Lock()
		pending := sub.pending
		if len(pending) > chunkLimit {
			// Hand over a bounded slice so one burst cannot stall the reader
			// with a multi-megabyte chunk; the rest follows on the next round.
			pending = append([]byte(nil), sub.pending[:chunkLimit]...)
			sub.pending = sub.pending[chunkLimit:]
		} else {
			sub.pending = nil
		}
		closed := sub.closed
		s.outputMu.Unlock()

		if len(pending) > 0 {
			select {
			case sub.output <- pending:
				continue
			case <-sub.done:
				return
			}
		}
		if closed {
			close(sub.output)
			return
		}
		select {
		case <-sub.notify:
		case <-sub.done:
			return
		}
	}
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
			for id, sub := range s.subscribers {
				delete(s.subscribers, id)
				sub.closed = true
				sub.signal()
			}
			s.outputMu.Unlock()
			return
		}
	}
}

func (s *Session) publish(data []byte) {
	s.outputMu.Lock()
	s.history = append(s.history, data...)
	if len(s.history) > historyLimit {
		s.history = append([]byte(nil), s.history[len(s.history)-historyLimit:]...)
	}
	for _, sub := range s.subscribers {
		sub.pending = append(sub.pending, data...)
		if len(sub.pending) > backlogLimit {
			sub.pending = append([]byte(nil), sub.pending[len(sub.pending)-backlogLimit:]...)
		}
		sub.signal()
	}
	s.outputMu.Unlock()
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
