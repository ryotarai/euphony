//go:build darwin || linux

package session

import (
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

func (s *Session) ForegroundIsShell() (bool, error) {
	s.fileMu.Lock()
	defer s.fileMu.Unlock()
	if s.terminal == nil || s.command == nil || s.command.Process == nil {
		return false, errors.New("terminal process has not started")
	}
	foregroundGroup, err := unix.IoctlGetInt(int(s.terminal.Fd()), unix.TIOCGPGRP)
	if err != nil {
		return false, err
	}
	shellGroup, err := syscall.Getpgid(s.command.Process.Pid)
	if err != nil {
		return false, err
	}
	return foregroundGroup == shellGroup, nil
}

func (s *Session) ForegroundCommand() (string, error) {
	s.fileMu.Lock()
	defer s.fileMu.Unlock()
	if s.terminal == nil || s.command == nil || s.command.Process == nil {
		return "", errors.New("terminal process has not started")
	}
	foregroundGroup, err := unix.IoctlGetInt(int(s.terminal.Fd()), unix.TIOCGPGRP)
	if err != nil {
		return "", err
	}
	output, err := exec.Command(
		"ps", "-o", "command=", "-p", strconv.Itoa(foregroundGroup),
	).Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
}
