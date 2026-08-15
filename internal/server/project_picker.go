package server

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

var (
	errDirectoryPickerCanceled    = errors.New("directory picker canceled")
	errDirectoryPickerUnavailable = errors.New("directory picker unavailable")
)

func pickDirectory(ctx context.Context) (string, error) {
	return pickDirectoryForOS(runtime.GOOS, ctx, pickDirectoryNativeWindows)
}

func pickDirectoryForOS(
	goos string,
	ctx context.Context,
	nativeWindows func(context.Context) (string, error),
) (string, error) {
	if goos == "windows" {
		path, err := nativeWindows(ctx)
		return normalizePickedDirectory(path, err)
	}
	return pickDirectoryWithCommand(ctx)
}

func pickDirectoryWithCommand(ctx context.Context) (string, error) {
	command, args, err := directoryPickerCommand()
	if err != nil {
		return "", err
	}
	output, err := exec.CommandContext(ctx, command, args...).Output()
	if err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) && exitError.ExitCode() == 1 {
			return "", errDirectoryPickerCanceled
		}
		return "", fmt.Errorf("run directory picker: %w", err)
	}
	return normalizePickedDirectory(string(output), nil)
}

func normalizePickedDirectory(path string, pickErr error) (string, error) {
	if pickErr != nil {
		return "", pickErr
	}
	path = strings.TrimSpace(path)
	if path == "" {
		return "", errDirectoryPickerCanceled
	}
	path, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return "", fmt.Errorf("normalize picked directory: %w", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("inspect picked directory: %w", err)
	}
	if !info.IsDir() {
		return "", errors.New("picked path is not a directory")
	}
	return path, nil
}

func directoryPickerCommand() (string, []string, error) {
	return directoryPickerCommandFor(runtime.GOOS, exec.LookPath)
}

func directoryPickerCommandFor(goos string, lookPath func(string) (string, error)) (string, []string, error) {
	switch goos {
	case "darwin":
		command, err := lookPath("osascript")
		if err != nil {
			return "", nil, fmt.Errorf("%w: osascript is unavailable", errDirectoryPickerUnavailable)
		}
		return command, []string{
			"-e",
			`POSIX path of (choose folder with prompt "Choose project directory")`,
		}, nil
	case "linux":
		if command, err := lookPath("zenity"); err == nil {
			return command, []string{
				"--file-selection", "--directory", "--title=Choose project directory",
			}, nil
		}
		if command, err := lookPath("kdialog"); err == nil {
			return command, []string{"--getexistingdirectory", "", "Choose project directory"}, nil
		}
		return "", nil, fmt.Errorf("%w: install zenity or kdialog", errDirectoryPickerUnavailable)
	default:
		return "", nil, fmt.Errorf("%w: unsupported operating system", errDirectoryPickerUnavailable)
	}
}
