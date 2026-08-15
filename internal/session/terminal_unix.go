//go:build darwin || linux

package session

import (
	"errors"
	"io"
	"os/exec"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

func defaultShell() string {
	return "/bin/sh"
}

func startTerminal(command *exec.Cmd, cols, rows uint16) (terminalStart, error) {
	terminal, err := pty.StartWithSize(command, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return terminalStart{}, err
	}
	terminalFD := int(terminal.Fd())
	if err := unix.SetNonblock(terminalFD, true); err != nil {
		_ = command.Process.Kill()
		_ = terminal.Close()
		_ = waitCommand(command)
		return terminalStart{}, err
	}
	resizeWake := []int{0, 0}
	if err := unix.Pipe(resizeWake); err != nil {
		_ = command.Process.Kill()
		_ = terminal.Close()
		_ = waitCommand(command)
		return terminalStart{}, err
	}
	return terminalStart{
		terminal:        terminal,
		resizeWakeRead:  resizeWake[0],
		resizeWakeWrite: resizeWake[1],
	}, nil
}

func waitCommand(command *exec.Cmd) error {
	return command.Wait()
}

func signalResizeUnix(s *Session) error {
	for {
		if _, err := unix.Write(s.resizeWakeWrite, []byte{1}); err != nil {
			if errors.Is(err, unix.EINTR) {
				continue
			}
			return err
		}
		return nil
	}
}

func writeTerminalUnix(s *Session, data []byte) (int, error) {
	fd, err := duplicateTerminalFD(s.terminalFD)
	if err != nil {
		return 0, err
	}
	defer unix.Close(fd)

	written := 0
	for written < len(data) {
		n, writeErr := unix.Write(fd, data[written:])
		if n > 0 {
			written += n
		}
		if writeErr == nil {
			if n == 0 {
				return written, io.ErrShortWrite
			}
			continue
		}
		if errors.Is(writeErr, unix.EINTR) {
			continue
		}
		if errors.Is(writeErr, unix.EAGAIN) || errors.Is(writeErr, unix.EWOULDBLOCK) {
			if err := waitUntilWritableUnix(s, fd); err != nil {
				return written, err
			}
			continue
		}
		return written, writeErr
	}
	return written, nil
}

func duplicateTerminalFD(fd int) (int, error) {
	return unix.FcntlInt(uintptr(fd), unix.F_DUPFD_CLOEXEC, 0)
}

func waitUntilWritableUnix(s *Session, fd int) error {
	pollFDs := []unix.PollFd{{
		Fd:     int32(fd),
		Events: unix.POLLOUT | unix.POLLHUP | unix.POLLERR,
	}}
	for {
		if s.pumpDone != nil {
			select {
			case <-s.pumpDone:
				return io.ErrClosedPipe
			default:
			}
		}
		_, err := unix.Poll(pollFDs, 100)
		if err != nil {
			if errors.Is(err, unix.EINTR) {
				continue
			}
			return err
		}
		events := pollFDs[0].Revents
		if events&(unix.POLLHUP|unix.POLLERR|unix.POLLNVAL) != 0 {
			return io.ErrClosedPipe
		}
		if events&unix.POLLOUT != 0 {
			return nil
		}
	}
}

func (s *Session) pump() {
	defer func() {
		s.fileMu.Lock()
		if s.terminal != nil {
			_ = s.terminal.Close()
		}
		s.fileMu.Unlock()
		close(s.pumpDone)
		s.resizeSubmitMu.Lock()
		_ = unix.Close(s.resizeWakeRead)
		_ = unix.Close(s.resizeWakeWrite)
		s.resizeSubmitMu.Unlock()
	}()
	buffer := make([]byte, 32*1024)
	pollFDs := []unix.PollFd{
		{
			Fd:     int32(s.terminalFD),
			Events: unix.POLLIN | unix.POLLHUP | unix.POLLERR,
		},
		{
			Fd:     int32(s.resizeWakeRead),
			Events: unix.POLLIN | unix.POLLHUP | unix.POLLERR,
		},
	}
	for {
		_, err := unix.Poll(pollFDs, -1)
		if err != nil {
			if errors.Is(err, unix.EINTR) {
				continue
			}
			s.finishOutput()
			return
		}

		terminalEvents := pollFDs[0].Revents
		if terminalEvents&(unix.POLLIN|unix.POLLHUP|unix.POLLERR) != 0 {
			closed, readErr := s.drainTerminalOutput(buffer)
			if readErr != nil || closed {
				s.finishOutput()
				return
			}
		}

		wakeEvents := pollFDs[1].Revents
		if wakeEvents&(unix.POLLIN|unix.POLLHUP|unix.POLLERR) != 0 {
			var wake [1]byte
			_, _ = unix.Read(s.resizeWakeRead, wake[:])
			s.processPendingResize()
		}
	}
}

func (s *Session) drainTerminalOutput(buffer []byte) (bool, error) {
	for range maxPTYReadBatchChunks {
		n, err := unix.Read(s.terminalFD, buffer)
		if n > 0 {
			s.afterReadMu.Lock()
			afterRead := s.afterRead
			s.afterReadMu.Unlock()
			if afterRead != nil {
				afterRead(buffer[:n])
			}
			s.publish(buffer[:n])
		}
		if err != nil {
			if errors.Is(err, unix.EAGAIN) || errors.Is(err, unix.EWOULDBLOCK) {
				return false, nil
			}
			if errors.Is(err, unix.EINTR) {
				continue
			}
			return false, err
		}
		if n == 0 {
			return true, nil
		}

		readable := []unix.PollFd{{
			Fd:     int32(s.terminalFD),
			Events: unix.POLLIN | unix.POLLHUP | unix.POLLERR,
		}}
		if _, err := unix.Poll(readable, 0); err != nil {
			if errors.Is(err, unix.EINTR) {
				continue
			}
			return false, err
		}
		if readable[0].Revents&(unix.POLLIN|unix.POLLHUP|unix.POLLERR) == 0 {
			return false, nil
		}
	}
	return false, nil
}

func (s *Session) processPendingResize() {
	select {
	case request := <-s.resizeRequests:
		if err := request.ctx.Err(); err != nil {
			request.done <- err
			return
		}
		err := unix.IoctlSetWinsize(s.terminalFD, unix.TIOCSWINSZ, &unix.Winsize{
			Col: request.cols,
			Row: request.rows,
		})
		if err == nil {
			if request.ctx.Err() != nil {
				request.done <- request.ctx.Err()
				return
			}
			s.dimensionsMu.Lock()
			s.cols = request.cols
			s.rows = request.rows
			s.dimensionsMu.Unlock()
			if request.notify != nil {
				request.notify()
			}
		}
		request.done <- err
	default:
	}
}
