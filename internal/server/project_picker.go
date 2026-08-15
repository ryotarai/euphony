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

const windowsFolderPickerScript = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose project directory'
$dialog.ShowNewFolderButton = $false
if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    exit 1
}
[Console]::Write($dialog.SelectedPath)`

func pickDirectory(ctx context.Context) (string, error) {
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
	path := strings.TrimSpace(string(output))
	if path == "" {
		return "", errDirectoryPickerCanceled
	}
	path, err = filepath.Abs(filepath.Clean(path))
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
	case "windows":
		for _, executable := range []string{"powershell.exe", "pwsh.exe"} {
			if command, err := lookPath(executable); err == nil {
				return command, []string{
					"-NoLogo", "-NoProfile", "-NonInteractive", "-STA",
					"-Command", windowsFolderPickerScript,
				}, nil
			}
		}
		return "", nil, fmt.Errorf("%w: powershell.exe or pwsh.exe is unavailable", errDirectoryPickerUnavailable)
	default:
		return "", nil, fmt.Errorf("%w: unsupported operating system", errDirectoryPickerUnavailable)
	}
}
