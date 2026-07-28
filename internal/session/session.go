package session

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"

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
	id       string
	command  *exec.Cmd
	terminal *os.File
	waitDone chan struct{}
	close    sync.Once
}

func (s *Session) Read(buffer []byte) (int, error) {
	return s.terminal.Read(buffer)
}

func (s *Session) Write(data []byte) (int, error) {
	return s.terminal.Write(data)
}

func (s *Session) Resize(cols, rows uint16) error {
	if cols < 1 || cols > 1000 || rows < 1 || rows > 1000 {
		return errors.New("terminal dimensions must be between 1 and 1000")
	}
	return pty.Setsize(s.terminal, &pty.Winsize{Cols: cols, Rows: rows})
}

func (s *Session) terminate() {
	s.close.Do(func() {
		if s.command.Process != nil {
			_ = s.command.Process.Signal(syscall.SIGTERM)
		}
		_ = s.terminal.Close()
	})
}

func (s *Session) wait() error {
	<-s.waitDone
	return nil
}

var _ io.ReadWriter = (*Session)(nil)
