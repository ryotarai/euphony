package localapi

import (
	"net"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestDefaultSocketPathHonorsExplicitAndRuntimeDirectory(t *testing.T) {
	t.Setenv("EUPHONY_SOCKET", filepath.Join(t.TempDir(), "explicit.sock"))
	path, err := DefaultSocketPath()
	if err != nil || path != os.Getenv("EUPHONY_SOCKET") {
		t.Fatalf("DefaultSocketPath() = %q, %v", path, err)
	}

	t.Setenv("EUPHONY_SOCKET", "")
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	path, err = DefaultSocketPath()
	if err != nil || path != filepath.Join(os.Getenv("XDG_RUNTIME_DIR"), "euphony", "euphony.sock") {
		t.Fatalf("runtime DefaultSocketPath() = %q, %v", path, err)
	}
}

func TestListenCreatesPrivateSocketAndCleansItUp(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix sockets are not supported")
	}
	directory, err := os.MkdirTemp("/tmp", "euphony-socket-")
	if err != nil {
		t.Fatalf("MkdirTemp() error = %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	path := filepath.Join(directory, "nested", "euphony.sock")
	listener, cleanup, err := Listen(path)
	if err != nil {
		t.Fatalf("Listen() error = %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat() error = %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("socket mode = %o, want 600", info.Mode().Perm())
	}
	connection, err := net.Dial("unix", path)
	if err != nil {
		t.Fatalf("Dial() error = %v", err)
	}
	_ = connection.Close()
	_ = listener.Close()
	if err := cleanup(); err != nil {
		t.Fatalf("cleanup() error = %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("socket remains after cleanup: %v", err)
	}
}

func TestListenRefusesToReplaceRegularFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "euphony.sock")
	if err := os.WriteFile(path, []byte("keep"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	if _, _, err := Listen(path); err == nil {
		t.Fatal("Listen() error = nil, want regular-file refusal")
	}
	content, err := os.ReadFile(path)
	if err != nil || string(content) != "keep" {
		t.Fatalf("regular file changed: %q, %v", content, err)
	}
}
