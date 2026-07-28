package session

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

func TestCreateRejectsBlankName(t *testing.T) {
	t.Parallel()

	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	if _, err := manager.Create(context.Background(), "   "); err == nil {
		t.Fatal("Create() error = nil, want validation error")
	}
}

func TestSessionRunsCommandsAndRecordsExit(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	metadata, err := manager.Create(context.Background(), "Agent")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	running, ok := manager.Get(metadata.ID)
	if !ok {
		t.Fatalf("Get(%q) ok = false", metadata.ID)
	}

	_, outputStream, unsubscribe := running.Subscribe()
	defer unsubscribe()
	if _, err := running.Write([]byte("printf 'euphony-ready\\n'\n")); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	output := receiveUntilCount(t, outputStream, "euphony-ready", 2, 3*time.Second)
	if !strings.Contains(output, "euphony-ready") {
		t.Fatalf("PTY output = %q, want command output", output)
	}
	if _, err := running.Write([]byte("exit 7\n")); err != nil {
		t.Fatalf("Write(exit) error = %v", err)
	}

	waitFor(t, 3*time.Second, func() bool {
		for _, item := range manager.List() {
			if item.ID == metadata.ID {
				return item.State == StateExited && item.ExitCode != nil && *item.ExitCode == 7
			}
		}
		return false
	})
}

func TestSessionsHaveUniqueIDsAndCreationOrder(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	first, err := manager.Create(context.Background(), "First")
	if err != nil {
		t.Fatalf("Create(first) error = %v", err)
	}
	second, err := manager.Create(context.Background(), "Second")
	if err != nil {
		t.Fatalf("Create(second) error = %v", err)
	}

	if first.ID == second.ID {
		t.Fatalf("session IDs are both %q", first.ID)
	}
	list := manager.List()
	if len(list) != 2 || list[0].ID != first.ID || list[1].ID != second.ID {
		t.Fatalf("List() = %#v, want creation order", list)
	}
}

func TestCreateRecordsCWDAndExposesTerminalHookEnvironment(t *testing.T) {
	manager := NewManager("/bin/sh", HookConfig{
		URL:   "http://127.0.0.1:8080/api/hooks/terminal",
		Token: "secret",
	})
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	metadata, err := manager.Create(context.Background(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	wantCWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd() error = %v", err)
	}
	if metadata.CWD != wantCWD {
		t.Fatalf("CWD = %q, want %q", metadata.CWD, wantCWD)
	}

	running, _ := manager.Get(metadata.ID)
	_, output, unsubscribe := running.Subscribe()
	defer unsubscribe()
	if _, err := running.Write([]byte("printf '%s|%s|%s\\n' \"$EUPHONY_TERMINAL_ID\" \"$EUPHONY_HOOK_URL\" \"$EUPHONY_TOKEN\"\n")); err != nil {
		t.Fatalf("Write(environment) error = %v", err)
	}
	result := receiveUntil(t, output, "secret", 3*time.Second)
	want := metadata.ID + "|http://127.0.0.1:8080/api/hooks/terminal|secret"
	if !strings.Contains(result, want) {
		t.Fatalf("environment output = %q, want %q", result, want)
	}
}

func TestUpdateAgentChangesTerminalActivity(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	updated, err := manager.UpdateAgent(metadata.ID, AgentUpdate{
		Agent:  "codex",
		Status: "running",
		Title:  "Implement v0.2",
		CWD:    "/workspace/euphony",
	})
	if err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
	if updated.Agent != "codex" || updated.AgentStatus != "running" ||
		updated.AgentTitle != "Implement v0.2" || updated.CWD != "/workspace/euphony" {
		t.Fatalf("updated metadata = %#v", updated)
	}
}

func TestResizeValidatesBounds(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Resize")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	running, _ := manager.Get(metadata.ID)

	if err := running.Resize(0, 24); err == nil {
		t.Fatal("Resize(0, 24) error = nil")
	}
	if err := running.Resize(80, 1001); err == nil {
		t.Fatal("Resize(80, 1001) error = nil")
	}
	if err := running.Resize(120, 40); err != nil {
		t.Fatalf("Resize(120, 40) error = %v", err)
	}
}

func TestDeleteTerminatesAndRemovesRunningSession(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Delete")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if err := manager.Delete(metadata.ID); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if _, ok := manager.Get(metadata.ID); ok {
		t.Fatalf("Get(%q) ok = true after delete", metadata.ID)
	}
}

func TestSubscribeReplaysHistoryAndContinuesWithLiveOutput(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Reload")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	running, ok := manager.Get(metadata.ID)
	if !ok {
		t.Fatalf("Get(%q) ok = false", metadata.ID)
	}

	initialHistory, initialOutput, unsubscribe := running.Subscribe()
	if len(initialHistory) != 0 {
		t.Fatalf("initial history = %q, want empty", initialHistory)
	}
	if _, err := running.Write([]byte("printf 'before-reload\\n'\n")); err != nil {
		t.Fatalf("Write(before reload) error = %v", err)
	}
	beforeReload := receiveUntil(t, initialOutput, "before-reload\r\n", 3*time.Second)
	unsubscribe()

	history, liveOutput, unsubscribeReloaded := running.Subscribe()
	defer unsubscribeReloaded()
	if !strings.Contains(string(history), "before-reload\r\n") {
		t.Fatalf("reloaded history = %q, want previous terminal output", history)
	}

	if _, err := running.Write([]byte("printf 'after-reload\\n'\n")); err != nil {
		t.Fatalf("Write(after reload) error = %v", err)
	}
	afterReload := receiveUntil(t, liveOutput, "after-reload\r\n", 3*time.Second)
	if !strings.Contains(afterReload, "after-reload\r\n") {
		t.Fatalf("live output = %q, want new terminal output", afterReload)
	}
	if !strings.Contains(beforeReload, "before-reload\r\n") {
		t.Fatalf("initial output = %q, want command output", beforeReload)
	}
}

func TestSubscribeAfterProcessExitReturnsHistoryAndClosedOutput(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	metadata, err := manager.Create(context.Background(), "Exited")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	running, _ := manager.Get(metadata.ID)
	_, output, unsubscribe := running.Subscribe()
	if _, err := running.Write([]byte("printf 'final-output\\n'; exit 0\n")); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	_ = receiveUntil(t, output, "final-output\r\n", 3*time.Second)
	unsubscribe()
	waitFor(t, 3*time.Second, func() bool {
		select {
		case <-running.pumpDone:
			return true
		default:
			return false
		}
	})

	history, exitedOutput, unsubscribeExited := running.Subscribe()
	defer unsubscribeExited()
	if !strings.Contains(string(history), "final-output\r\n") {
		t.Fatalf("history = %q, want final output", history)
	}
	select {
	case _, ok := <-exitedOutput:
		if ok {
			t.Fatal("exited output channel is open, want closed")
		}
	case <-time.After(time.Second):
		t.Fatal("exited output channel did not close")
	}
}

func receiveUntil(t *testing.T, output <-chan []byte, needle string, timeout time.Duration) string {
	t.Helper()
	var received strings.Builder
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case data, ok := <-output:
			if !ok {
				t.Fatalf("output closed while waiting for %q; received %q", needle, received.String())
			}
			received.Write(data)
			if strings.Contains(received.String(), needle) {
				return received.String()
			}
		case <-timer.C:
			t.Fatalf("timed out waiting for %q; received %q", needle, received.String())
		}
	}
}

func receiveUntilCount(t *testing.T, output <-chan []byte, needle string, count int, timeout time.Duration) string {
	t.Helper()
	var received strings.Builder
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case data, ok := <-output:
			if !ok {
				t.Fatalf("output closed while waiting for %q; received %q", needle, received.String())
			}
			received.Write(data)
			if strings.Count(received.String(), needle) >= count {
				return received.String()
			}
		case <-timer.C:
			t.Fatalf("timed out waiting for %q; received %q", needle, received.String())
		}
	}
}

func waitFor(t *testing.T, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition was not met before timeout")
}
