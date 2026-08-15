//go:build windows

package session

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

const conPTYReadBufferSize = 32 * 1024

type windowsTerminalBackend struct {
	input        *os.File
	console      windows.Handle
	resizeSignal chan struct{}
	pipeOnce     sync.Once
	consoleOnce  sync.Once
}

type windowsReadResult struct {
	data []byte
	err  error
}

func defaultShell() string {
	if shell := os.Getenv("COMSPEC"); shell != "" {
		return shell
	}
	return "cmd.exe"
}

func startTerminal(command *exec.Cmd, cols, rows uint16) (terminalStart, error) {
	securityAttributes := &windows.SecurityAttributes{
		Length:        uint32(unsafe.Sizeof(windows.SecurityAttributes{})),
		InheritHandle: 1,
	}
	var inputRead, inputWrite windows.Handle
	var outputRead, outputWrite windows.Handle
	var console windows.Handle
	defer func() {
		closeWindowsHandle(&inputRead)
		closeWindowsHandle(&inputWrite)
		closeWindowsHandle(&outputRead)
		closeWindowsHandle(&outputWrite)
		if console != 0 {
			windows.ClosePseudoConsole(console)
		}
	}()

	if err := windows.CreatePipe(&inputRead, &inputWrite, securityAttributes, 0); err != nil {
		return terminalStart{}, fmt.Errorf("create ConPTY input pipe: %w", err)
	}
	if err := windows.CreatePipe(&outputRead, &outputWrite, securityAttributes, 0); err != nil {
		return terminalStart{}, fmt.Errorf("create ConPTY output pipe: %w", err)
	}
	if err := windows.SetHandleInformation(inputWrite, windows.HANDLE_FLAG_INHERIT, 0); err != nil {
		return terminalStart{}, fmt.Errorf("make ConPTY input handle private: %w", err)
	}
	if err := windows.SetHandleInformation(outputRead, windows.HANDLE_FLAG_INHERIT, 0); err != nil {
		return terminalStart{}, fmt.Errorf("make ConPTY output handle private: %w", err)
	}

	if err := windows.CreatePseudoConsole(
		windows.Coord{X: int16(cols), Y: int16(rows)},
		inputRead,
		outputWrite,
		0,
		&console,
	); err != nil {
		return terminalStart{}, fmt.Errorf("create ConPTY: %w", err)
	}

	attributes, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return terminalStart{}, fmt.Errorf("create process attribute list: %w", err)
	}
	if err := attributes.Update(
		windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
		unsafe.Pointer(&console),
		unsafe.Sizeof(console),
	); err != nil {
		attributes.Delete()
		return terminalStart{}, fmt.Errorf("attach ConPTY to process attributes: %w", err)
	}

	commandLine, err := windows.UTF16FromString(windows.ComposeCommandLine(command.Args))
	if err != nil {
		attributes.Delete()
		return terminalStart{}, fmt.Errorf("encode Windows command line: %w", err)
	}
	var commandLinePtr *uint16
	if len(commandLine) > 0 {
		commandLinePtr = &commandLine[0]
	}

	var applicationName *uint16
	if command.Path != "" {
		applicationName, err = windows.UTF16PtrFromString(command.Path)
		if err != nil {
			attributes.Delete()
			return terminalStart{}, fmt.Errorf("encode Windows application name: %w", err)
		}
	}

	var currentDirectory *uint16
	if command.Dir != "" {
		currentDirectory, err = windows.UTF16PtrFromString(command.Dir)
		if err != nil {
			attributes.Delete()
			return terminalStart{}, fmt.Errorf("encode Windows working directory: %w", err)
		}
	}

	envBlock, err := windowsEnvironmentBlock(command.Env)
	if err != nil {
		attributes.Delete()
		return terminalStart{}, err
	}
	var environment *uint16
	if len(envBlock) > 0 {
		environment = &envBlock[0]
	}

	startupInfo := windows.StartupInfoEx{}
	startupInfo.StartupInfo.Cb = uint32(unsafe.Sizeof(startupInfo))
	startupInfo.ProcThreadAttributeList = attributes.List()
	processInfo := windows.ProcessInformation{}
	creationFlags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_UNICODE_ENVIRONMENT)
	if err := windows.CreateProcess(
		applicationName,
		commandLinePtr,
		nil,
		nil,
		false,
		creationFlags,
		environment,
		currentDirectory,
		&startupInfo.StartupInfo,
		&processInfo,
	); err != nil {
		attributes.Delete()
		return terminalStart{}, fmt.Errorf("start ConPTY process: %w", err)
	}
	attributes.Delete()

	closeWindowsHandle(&processInfo.Thread)
	closeWindowsHandle(&inputRead)
	closeWindowsHandle(&outputWrite)

	process, err := os.FindProcess(int(processInfo.ProcessId))
	closeWindowsHandle(&processInfo.Process)
	if err != nil {
		return terminalStart{}, fmt.Errorf("open ConPTY process: %w", err)
	}

	output := os.NewFile(uintptr(outputRead), "euphony-conpty-output")
	input := os.NewFile(uintptr(inputWrite), "euphony-conpty-input")
	if output == nil || input == nil {
		_ = process.Kill()
		_, _ = process.Wait()
		if output != nil {
			_ = output.Close()
		}
		if input != nil {
			_ = input.Close()
		}
		return terminalStart{}, errors.New("create ConPTY pipe files")
	}
	outputRead = 0
	inputWrite = 0
	command.Process = process
	backend := &windowsTerminalBackend{
		input:        input,
		console:      console,
		resizeSignal: make(chan struct{}, 1),
	}
	console = 0
	return terminalStart{
		terminal:        output,
		backend:         backend,
		resizeWakeRead:  -1,
		resizeWakeWrite: -1,
	}, nil
}

func closeWindowsHandle(handle *windows.Handle) {
	if *handle != 0 {
		_ = windows.CloseHandle(*handle)
		*handle = 0
	}
}

func waitCommand(command *exec.Cmd) error {
	if command.Process == nil {
		return errors.New("process has not started")
	}
	_, err := command.Process.Wait()
	return err
}

func (s *Session) pump() {
	s.backend.pump(s)
}

func signalResizeUnix(_ *Session) error {
	return errors.New("Unix terminal resize is unavailable on Windows")
}

func writeTerminalUnix(_ *Session, _ []byte) (int, error) {
	return 0, errors.New("Unix terminal writes are unavailable on Windows")
}

func (b *windowsTerminalBackend) write(_ *Session, data []byte) (int, error) {
	if b.input == nil {
		return 0, io.ErrClosedPipe
	}
	return b.input.Write(data)
}

func (b *windowsTerminalBackend) signalResize(s *Session) error {
	select {
	case <-s.pumpDone:
		return errors.New("terminal output loop is closed")
	default:
	}
	select {
	case b.resizeSignal <- struct{}{}:
		return nil
	case <-s.pumpDone:
		return errors.New("terminal output loop is closed")
	}
}

func (b *windowsTerminalBackend) processPendingResize(s *Session) {
	select {
	case request := <-s.resizeRequests:
		if err := request.ctx.Err(); err != nil {
			request.done <- err
			return
		}
		err := windows.ResizePseudoConsole(b.console, windows.Coord{
			X: int16(request.cols),
			Y: int16(request.rows),
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

func (b *windowsTerminalBackend) pump(s *Session) {
	defer func() {
		b.close(s)
		close(s.pumpDone)
	}()

	readResults := make(chan windowsReadResult, 1)
	startRead := func() {
		go func() {
			s.fileMu.Lock()
			terminal := s.terminal
			s.fileMu.Unlock()
			if terminal == nil {
				readResults <- windowsReadResult{err: io.ErrClosedPipe}
				return
			}
			buffer := make([]byte, conPTYReadBufferSize)
			n, err := terminal.Read(buffer)
			readResults <- windowsReadResult{data: buffer[:n], err: err}
		}()
	}

	startRead()
	for {
		select {
		case result := <-readResults:
			if len(result.data) > 0 {
				s.afterReadMu.Lock()
				afterRead := s.afterRead
				s.afterReadMu.Unlock()
				if afterRead != nil {
					afterRead(result.data)
				}
				s.publish(result.data)
			}
			if result.err != nil || len(result.data) == 0 {
				s.finishOutput()
				return
			}
			startRead()
		case <-b.resizeSignal:
			b.processPendingResize(s)
		}
	}
}

func (b *windowsTerminalBackend) terminate(s *Session) {
	b.closePipes(s)
}

func (b *windowsTerminalBackend) close(s *Session) {
	b.closePipes(s)
	b.consoleOnce.Do(func() {
		if b.console != 0 {
			windows.ClosePseudoConsole(b.console)
			b.console = 0
		}
	})
}

func (b *windowsTerminalBackend) closePipes(s *Session) {
	b.pipeOnce.Do(func() {
		s.fileMu.Lock()
		terminal := s.terminal
		s.terminal = nil
		s.terminalFD = -1
		s.fileMu.Unlock()
		if terminal != nil {
			_ = terminal.Close()
		}
		if b.input != nil {
			_ = b.input.Close()
			b.input = nil
		}
	})
}

func windowsEnvironmentBlock(env []string) ([]uint16, error) {
	if env == nil {
		return nil, nil
	}
	values := make(map[string]string, len(env))
	for _, value := range env {
		if strings.IndexByte(value, 0) >= 0 {
			return nil, errors.New("environment contains NUL")
		}
		values[strings.ToUpper(windowsEnvironmentKey(value))] = value
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	if len(keys) == 0 {
		return []uint16{0, 0}, nil
	}
	sort.Strings(keys)
	block := make([]uint16, 0, len(env)+1)
	for _, key := range keys {
		encoded, err := windows.UTF16FromString(values[key])
		if err != nil {
			return nil, fmt.Errorf("encode environment: %w", err)
		}
		block = append(block, encoded...)
	}
	block = append(block, 0)
	return block, nil
}

func windowsEnvironmentKey(value string) string {
	if strings.HasPrefix(value, "=") {
		if separator := strings.IndexByte(value[1:], '='); separator >= 0 {
			return value[:separator+2]
		}
	}
	if separator := strings.IndexByte(value, '='); separator >= 0 {
		return value[:separator]
	}
	return value
}
