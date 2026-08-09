package control

import (
	"context"
	"encoding/base64"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ryotarai/euphony/internal/session"
)

func TestEncodeKeysValidatesBeforeEncoding(t *testing.T) {
	got, err := EncodeKeys([]string{"ctrl+c", "enter", "esc", "up"})
	if err != nil {
		t.Fatalf("EncodeKeys() error = %v", err)
	}
	want := []byte{0x03, '\r', 0x1b, 0x1b, '[', 'A'}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("EncodeKeys() = %x, want %x", got, want)
	}
	if _, err := EncodeKeys([]string{"enter", "not-a-key"}); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("EncodeKeys(invalid) error = %v, want ErrInvalidKey", err)
	}
}

func TestRenameTerminalTrimsNameAndMarksCustomName(t *testing.T) {
	manager := session.NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(t.Context()) })
	created, err := manager.Create(t.Context(), "Terminal", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	service, err := New(manager)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	renamed, err := service.RenameTerminal(created.ID, "  Renamed  ")
	if err != nil {
		t.Fatalf("RenameTerminal() error = %v", err)
	}
	if renamed.Name != "Renamed" || !renamed.CustomName {
		t.Fatalf("RenameTerminal() = %#v, want trimmed custom name", renamed)
	}
}

func TestWaitOutputObservesFutureBytesAndReadPreservesRawHistory(t *testing.T) {
	manager := session.NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(t.Context()) })
	metadata, err := manager.Create(t.Context(), "Automation", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	service, err := New(manager)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	command := "printf '\\377\\033[31mAUTOMATION_READY\\033[0m\\n'"
	if err := service.RunTerminal(metadata.ID, command); err != nil {
		t.Fatalf("RunTerminal() error = %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	waited, err := service.WaitOutput(ctx, metadata.ID, OutputMatch{
		Literal:  "AUTOMATION_READY",
		MaxBytes: 1024 * 1024,
	})
	if err != nil {
		t.Fatalf("WaitOutput() error = %v", err)
	}
	if !strings.Contains(waited.MatchedLine, "AUTOMATION_READY") {
		t.Fatalf("MatchedLine = %q", waited.MatchedLine)
	}
	read, err := service.ReadTerminal(metadata.ID, 1024*1024)
	if err != nil {
		t.Fatalf("ReadTerminal() error = %v", err)
	}
	raw, err := base64.RawStdEncoding.DecodeString(read.DataBase64)
	if err != nil {
		t.Fatalf("decode DataBase64: %v", err)
	}
	if !strings.Contains(string(raw), "AUTOMATION_READY") ||
		!strings.Contains(read.Text, "AUTOMATION_READY") ||
		strings.Contains(read.Text, "\x1b[31m") {
		t.Fatalf("ReadTerminal() = raw %q, text %q", raw, read.Text)
	}
}

func TestRunTerminalRejectsBusyForegroundProcess(t *testing.T) {
	manager := session.NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(t.Context()) })
	metadata, err := manager.Create(t.Context(), "Busy", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	service, err := New(manager)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if err := service.RunTerminal(metadata.ID, "sleep 2"); err != nil {
		t.Fatalf("RunTerminal(sleep) error = %v", err)
	}
	running, _ := manager.Get(metadata.ID)
	deadline := time.Now().Add(time.Second)
	for {
		available, checkErr := running.ForegroundIsShell()
		if checkErr != nil {
			t.Fatalf("ForegroundIsShell() error = %v", checkErr)
		}
		if !available {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("sleep did not take the PTY foreground")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := service.RunTerminal(metadata.ID, "printf 'should-not-run\\n'"); !errors.Is(err, ErrTerminalBusy) {
		t.Fatalf("RunTerminal(busy) error = %v, want ErrTerminalBusy", err)
	}
}

func TestRunTerminalAutomationLocksOrdinaryInputUntilOutputSettles(t *testing.T) {
	manager := session.NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(t.Context()) })
	metadata, err := manager.Create(t.Context(), "Automation", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	service, err := New(manager)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	service.automationQuietPeriod = 120 * time.Millisecond
	service.automationMaxSettle = time.Second

	started := time.Now()
	result := make(chan error, 1)
	go func() {
		result <- service.RunTerminalAutomation(
			context.Background(), metadata.ID, []byte("sleep 0.05; printf 'automation-ready\\n'\r"),
		)
	}()

	locked := false
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		input := "ordinary-input\r"
		err := service.SendTerminalInput(metadata.ID, TerminalInput{Text: &input})
		if errors.Is(err, ErrTerminalLocked) {
			locked = true
			break
		}
		if err != nil {
			t.Fatalf("ordinary input before lock = %v", err)
		}
		time.Sleep(time.Millisecond)
	}
	if !locked {
		t.Fatal("ordinary terminal input was not rejected while automation was active")
	}
	if err := <-result; err != nil {
		t.Fatalf("RunTerminalAutomation() error = %v", err)
	}
	if elapsed := time.Since(started); elapsed < 100*time.Millisecond {
		t.Fatalf("automation returned after %s, want output settling period", elapsed)
	}

	input := "after-release\r"
	if err := service.SendTerminalInput(metadata.ID, TerminalInput{Text: &input}); err != nil {
		t.Fatalf("ordinary input after automation release = %v", err)
	}
}
