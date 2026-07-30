//go:build aix || darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package workspacefiles

import (
	"errors"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestDirectoryRejectsFIFOWithoutBlocking(t *testing.T) {
	root := t.TempDir()
	if err := syscall.Mkfifo(filepath.Join(root, "pipe"), 0o600); err != nil {
		t.Fatalf("Mkfifo() error = %v", err)
	}
	reader := mustReader(t, root)
	result := make(chan error, 1)
	go func() {
		_, err := reader.Directory("pipe")
		result <- err
	}()

	select {
	case err := <-result:
		if !errors.Is(err, ErrTypeMismatch) {
			t.Fatalf("Directory(pipe) error = %v, want ErrTypeMismatch", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Directory(pipe) blocked waiting for a FIFO writer")
	}
}
