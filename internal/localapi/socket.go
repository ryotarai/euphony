package localapi

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"
)

func DefaultSocketPath() (string, error) {
	if configured := os.Getenv("EUPHONY_SOCKET"); configured != "" {
		return configured, nil
	}
	if runtimeDirectory := os.Getenv("XDG_RUNTIME_DIR"); runtimeDirectory != "" {
		return filepath.Join(runtimeDirectory, "euphony", "euphony.sock"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home directory: %w", err)
	}
	return filepath.Join(home, ".local", "euphony", "euphony.sock"), nil
}

func Listen(path string) (net.Listener, func() error, error) {
	if path == "" {
		return nil, nil, errors.New("Unix socket path is empty")
	}
	if err := prepareSocketPath(path); err != nil {
		return nil, nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, nil, fmt.Errorf("create Unix socket directory: %w", err)
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, nil, fmt.Errorf("listen on Unix socket: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = listener.Close()
		_ = os.Remove(path)
		return nil, nil, fmt.Errorf("protect Unix socket: %w", err)
	}
	cleanup := func() error {
		err := os.Remove(path)
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return listener, cleanup, nil
}

func prepareSocketPath(path string) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect Unix socket: %w", err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		return fmt.Errorf("refusing to replace non-socket path %q", path)
	}
	connection, dialErr := net.DialTimeout("unix", path, 150*time.Millisecond)
	if dialErr == nil {
		_ = connection.Close()
		return fmt.Errorf("Euphony is already listening on %q", path)
	}
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("remove stale Unix socket: %w", err)
	}
	return nil
}
