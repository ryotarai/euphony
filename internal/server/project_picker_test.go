package server

import (
	"errors"
	"strings"
	"testing"
)

func TestDirectoryPickerCommandForWindowsUsesPowerShell(t *testing.T) {
	resolved := `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
	lookPath := func(name string) (string, error) {
		if name == "powershell.exe" {
			return resolved, nil
		}
		return "", errors.New("command not found")
	}

	command, args, err := directoryPickerCommandFor("windows", lookPath)
	if err != nil {
		t.Fatalf("directoryPickerCommandFor() error = %v", err)
	}
	if command != resolved {
		t.Fatalf("command = %q, want %q", command, resolved)
	}

	for _, want := range []string{"-NoProfile", "-NonInteractive", "-STA"} {
		if !containsString(args, want) {
			t.Fatalf("args = %#v, want %q", args, want)
		}
	}
	if len(args) == 0 || args[len(args)-1] == "" {
		t.Fatalf("args = %#v, want a PowerShell script", args)
	}
	for _, want := range []string{
		"System.Windows.Forms.FolderBrowserDialog",
		"Choose project directory",
		"OutputEncoding",
		"UTF8",
		"exit 1",
	} {
		if !strings.Contains(args[len(args)-1], want) {
			t.Fatalf("script = %q, want %q", args[len(args)-1], want)
		}
	}
}

func TestDirectoryPickerCommandForWindowsFallsBackToPowerShellCore(t *testing.T) {
	resolved := `C:\Program Files\PowerShell\7\pwsh.exe`
	lookPath := func(name string) (string, error) {
		if name == "pwsh.exe" {
			return resolved, nil
		}
		return "", errors.New("command not found")
	}

	command, args, err := directoryPickerCommandFor("windows", lookPath)
	if err != nil {
		t.Fatalf("directoryPickerCommandFor() error = %v", err)
	}
	if command != resolved {
		t.Fatalf("command = %q, want %q", command, resolved)
	}
	if !containsString(args, "-STA") {
		t.Fatalf("args = %#v, want STA mode", args)
	}
}

func TestDirectoryPickerCommandForWindowsReportsUnavailableWithoutPowerShell(t *testing.T) {
	_, _, err := directoryPickerCommandFor("windows", func(string) (string, error) {
		return "", errors.New("command not found")
	})
	if !errors.Is(err, errDirectoryPickerUnavailable) {
		t.Fatalf("error = %v, want errDirectoryPickerUnavailable", err)
	}
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
