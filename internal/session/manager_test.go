package session

import (
	"context"
	"io"
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

	if _, err := running.Write([]byte("printf 'euphony-ready\\n'\n")); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	output := readUntilCount(t, running, "euphony-ready", 2, 3*time.Second)
	if !strings.Contains(output, "euphony-ready") {
		t.Fatalf("PTY output = %q, want command output", output)
	}
	go func() {
		_, _ = io.Copy(io.Discard, running)
	}()
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

func readUntilCount(t *testing.T, session *Session, needle string, count int, timeout time.Duration) string {
	t.Helper()
	result := make(chan string, 1)
	go func() {
		var output strings.Builder
		buffer := make([]byte, 1024)
		for {
			n, err := session.Read(buffer)
			if n > 0 {
				output.Write(buffer[:n])
				if strings.Count(output.String(), needle) >= count {
					result <- output.String()
					return
				}
			}
			if err != nil {
				if err != io.EOF {
					result <- output.String()
				}
				return
			}
		}
	}()

	select {
	case output := <-result:
		return output
	case <-time.After(timeout):
		t.Fatalf("timed out waiting for %q", needle)
		return ""
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
