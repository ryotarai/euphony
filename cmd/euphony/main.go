package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/ryotarai/euphony/internal/agenthook"
	"github.com/ryotarai/euphony/internal/localapi"
	"github.com/ryotarai/euphony/internal/server"
	euphonysetup "github.com/ryotarai/euphony/internal/setup"
)

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr); err != nil {
		var exit *exitError
		if errors.As(err, &exit) {
			os.Exit(exit.code)
		}
		log.Fatal(err)
	}
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	if len(args) > 0 {
		switch args[0] {
		case "setup":
			return runSetup(stdout)
		case "hook":
			return runHook(args[1:], stdin)
		}
		return runAutomation(args, stdin, stdout, stderr)
	}
	return runServer()
}

func runSetup(stdout io.Writer) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	result, err := euphonysetup.Install(euphonysetup.Config{
		HomeDir:    home,
		CodexDir:   os.Getenv("CODEX_HOME"),
		ClaudeDir:  os.Getenv("CLAUDE_CONFIG_DIR"),
		Executable: executable,
		Path:       os.Getenv("PATH"),
	})
	if err != nil {
		return err
	}
	if len(result.Installed) == 0 {
		_, _ = fmt.Fprintln(stdout, "No supported coding agents found.")
		return nil
	}
	for _, agent := range result.Installed {
		_, _ = fmt.Fprintf(stdout, "Installed %s hooks.\n", agent)
	}
	return nil
}

func runHook(args []string, stdin io.Reader) error {
	if len(args) != 2 {
		return errors.New("usage: euphony hook <agent> <status>")
	}
	// Hooks must never interrupt the coding agent when Euphony is unavailable.
	_ = agenthook.Report(context.Background(), agenthook.Config{
		URL:        os.Getenv("EUPHONY_HOOK_URL"),
		Token:      os.Getenv("EUPHONY_TOKEN"),
		TerminalID: os.Getenv("EUPHONY_TERMINAL_ID"),
		Agent:      args[0],
		Status:     args[1],
	}, stdin)
	return nil
}

func runServer() error {
	address := os.Getenv("EUPHONY_ADDR")
	if address == "" {
		address = "127.0.0.1:8080"
	}
	databasePath := os.Getenv("EUPHONY_DB")
	codexDirectory := os.Getenv("CODEX_HOME")
	claudeDirectory := os.Getenv("CLAUDE_CONFIG_DIR")
	var home string
	if databasePath == "" || codexDirectory == "" || claudeDirectory == "" {
		var err error
		home, err = os.UserHomeDir()
		if err != nil {
			return fmt.Errorf("resolve home directory: %w", err)
		}
	}
	if databasePath == "" {
		databasePath = filepath.Join(home, ".local", "euphony", "euphony.sqlite3")
	}
	if codexDirectory == "" {
		codexDirectory = filepath.Join(home, ".codex")
	}
	if claudeDirectory == "" {
		claudeDirectory = filepath.Join(home, ".claude")
	}
	codexSessionsRoot, claudeProjectsRoot := agentLogRoots(
		home, codexDirectory, claudeDirectory,
	)
	token, generatedToken, err := resolveToken(os.Getenv("EUPHONY_TOKEN"))
	if err != nil {
		return err
	}
	srv, err := server.New(server.Config{
		Token:              token,
		Shell:              os.Getenv("SHELL"),
		HookURL:            "http://" + address + "/api/hooks/terminal",
		DatabasePath:       databasePath,
		CodexSessionIndex:  filepath.Join(codexDirectory, "session_index.jsonl"),
		CodexSessionsRoot:  codexSessionsRoot,
		ClaudeProjectsRoot: claudeProjectsRoot,
	})
	if err != nil {
		return err
	}
	socketPath, err := localapi.DefaultSocketPath()
	if err != nil {
		return err
	}
	unixListener, cleanupSocket, err := localapi.Listen(socketPath)
	if err != nil {
		return err
	}
	defer cleanupSocket()

	log.Printf("Euphony listening on http://%s and unix://%s", address, socketPath)
	httpServer := &http.Server{
		Addr:              address,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	unixServer := &http.Server{
		Handler:           srv.LocalHandler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	result := make(chan error, 2)
	go func() {
		result <- httpServer.ListenAndServe()
	}()
	go func() {
		result <- unixServer.Serve(unixListener)
	}()
	if generatedToken {
		url := browserURL(address, token)
		if err := openBrowser(url); err != nil {
			log.Printf("Open %s in a browser: %v", url, err)
		}
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)

	var serveErr error
	select {
	case err := <-result:
		if !errors.Is(err, http.ErrServerClosed) {
			serveErr = err
		}
	case <-signals:
		log.Print("Shutting down Euphony")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	shutdownErr := httpServer.Shutdown(ctx)
	unixShutdownErr := unixServer.Shutdown(ctx)
	sessionErr := srv.Close(ctx)
	if serveErr != nil {
		return serveErr
	}
	if shutdownErr != nil {
		return shutdownErr
	}
	if unixShutdownErr != nil {
		return unixShutdownErr
	}
	return sessionErr
}

func agentLogRoots(home, codexDirectory, claudeDirectory string) (string, string) {
	if codexDirectory == "" {
		codexDirectory = filepath.Join(home, ".codex")
	}
	if claudeDirectory == "" {
		claudeDirectory = filepath.Join(home, ".claude")
	}
	return filepath.Join(codexDirectory, "sessions"), filepath.Join(claudeDirectory, "projects")
}

func resolveToken(configured string) (string, bool, error) {
	if configured != "" {
		return configured, false, nil
	}
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", false, fmt.Errorf("generate EUPHONY_TOKEN: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(bytes), true, nil
}

func browserURL(address, token string) string {
	url := url.URL{Scheme: "http", Host: address}
	query := url.Query()
	query.Set("token", token)
	url.RawQuery = query.Encode()
	return url.String()
}

func openBrowser(url string) error {
	command := "xdg-open"
	if runtime.GOOS == "darwin" {
		command = "open"
	}
	return exec.Command(command, url).Start()
}
