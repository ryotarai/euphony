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
	subscribers    map[uint64]chan []byte
	nextSubscriber uint64
	outputClosed   bool
}

const historyLimit = 1024 * 1024

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

func (s *Session) Subscribe() ([]byte, <-chan []byte, func()) {
	s.outputMu.Lock()
	history := append([]byte(nil), s.history...)
	id := s.nextSubscriber
	s.nextSubscriber++
	output := make(chan []byte, 64)
	if s.outputClosed {
		close(output)
	} else {
		s.subscribers[id] = output
	}
	s.outputMu.Unlock()

	var once sync.Once
	unsubscribe := func() {
		once.Do(func() {
			s.outputMu.Lock()
			if current, ok := s.subscribers[id]; ok {
				delete(s.subscribers, id)
				close(current)
			}
			s.outputMu.Unlock()
		})
	}
	return history, output, unsubscribe
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
			for id, output := range s.subscribers {
				delete(s.subscribers, id)
				close(output)
			}
			s.outputMu.Unlock()
			return
		}
	}
}

func (s *Session) publish(data []byte) {
	chunk := append([]byte(nil), data...)
	s.outputMu.Lock()
	s.history = append(s.history, chunk...)
	if len(s.history) > historyLimit {
		s.history = append([]byte(nil), s.history[len(s.history)-historyLimit:]...)
	}
	for id, output := range s.subscribers {
		select {
		case output <- chunk:
		default:
			delete(s.subscribers, id)
			close(output)
		}
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
