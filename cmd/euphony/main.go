package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/mattn/go-isatty"
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
	return runServer(stdin, stdout)
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
	config := euphonysetup.Config{
		HomeDir:    home,
		CodexDir:   os.Getenv("CODEX_HOME"),
		ClaudeDir:  os.Getenv("CLAUDE_CONFIG_DIR"),
		Executable: executable,
		Path:       os.Getenv("PATH"),
	}
	writeSetupExplanation(stdout)
	result, err := installAgentSetup(config, stdout)
	if err != nil {
		return err
	}
	if len(result.Installed) == 0 {
		_, _ = fmt.Fprintln(stdout, "No supported coding agents found.")
	}
	return nil
}

func installAgentSetup(
	config euphonysetup.Config, stdout io.Writer,
) (euphonysetup.Result, error) {
	result, err := euphonysetup.Install(config)
	if err != nil {
		return result, err
	}
	if len(result.Installed) == 0 {
		return result, nil
	}
	for _, agent := range result.Installed {
		_, _ = fmt.Fprintf(stdout, "Installed %s hooks and skills.\n", agent)
	}
	return result, nil
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

func runServer(stdin io.Reader, stdout io.Writer) error {
	runAgentSetupPreflight(
		isTerminalReader(stdin),
		func() error {
			return offerAgentSetupOnStartup(stdin, stdout)
		},
		func(err error) {
			log.Printf("Agent setup warning: %v", err)
		},
	)
	address := os.Getenv("EUPHONY_ADDR")
	if address == "" {
		address = "127.0.0.1:8080"
	}
	tcpListener, actualAddress, err := listenTCP(address)
	if err != nil {
		return err
	}
	defer func() { _ = tcpListener.Close() }()
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
		HookURL:            "http://" + actualAddress + "/api/hooks/terminal",
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
		_ = srv.Close(context.Background())
		return err
	}
	unixListener, cleanupSocket, err := localapi.Listen(socketPath)
	if err != nil {
		_ = srv.Close(context.Background())
		return err
	}
	defer cleanupSocket()

	log.Printf("Euphony listening on http://%s and unix://%s", actualAddress, socketPath)
	requestContext, cancelRequests := context.WithCancel(context.Background())
	defer cancelRequests()
	httpServer := newHTTPServer(actualAddress, srv.Handler(), requestContext, cancelRequests)
	unixServer := newHTTPServer("", srv.LocalHandler(), requestContext, cancelRequests)
	result := make(chan error, 2)
	go func() {
		result <- httpServer.Serve(tcpListener)
	}()
	go func() {
		result <- unixServer.Serve(unixListener)
	}()
	readyFile := os.Getenv("EUPHONY_READY_FILE")
	if readyFile != "" {
		if err := writeReadyFile(readyFile, "http://"+actualAddress); err != nil {
			_ = httpServer.Close()
			_ = unixServer.Close()
			_ = srv.Close(context.Background())
			return err
		}
		defer func() { _ = os.Remove(readyFile) }()
	}
	if generatedToken {
		url := browserURL(actualAddress, token)
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
		log.Printf("Shutting down Euphony (timeout: %s)", shutdownTimeout)
	}

	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	shutdownErr := shutdownStep(ctx, "HTTP server", httpServer.Shutdown, log.Printf)
	unixShutdownErr := shutdownStep(ctx, "Unix HTTP server", unixServer.Shutdown, log.Printf)
	sessionErr := shutdownStep(ctx, "session manager", srv.Close, log.Printf)
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

const shutdownTimeout = 5 * time.Second

func newHTTPServer(
	address string,
	handler http.Handler,
	requestContext context.Context,
	cancelRequests context.CancelFunc,
) *http.Server {
	server := &http.Server{
		Addr:              address,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext: func(net.Listener) context.Context {
			return requestContext
		},
	}
	server.RegisterOnShutdown(cancelRequests)
	return server
}

func shutdownStep(
	ctx context.Context,
	name string,
	shutdown func(context.Context) error,
	logf func(string, ...any),
) error {
	started := time.Now()
	err := shutdown(ctx)
	elapsed := time.Since(started).Round(time.Millisecond)
	if err == nil {
		logf("Euphony shutdown: %s completed in %s", name, elapsed)
		return nil
	}
	if errors.Is(err, context.DeadlineExceeded) {
		logf(
			"Euphony shutdown: %s timed out after %s; long-lived connections or processes may still be active",
			name, elapsed,
		)
	} else {
		logf("Euphony shutdown: %s failed after %s: %v", name, elapsed, err)
	}
	return fmt.Errorf("shutdown %s: %w", name, err)
}

func listenTCP(address string) (net.Listener, string, error) {
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return nil, "", fmt.Errorf("listen on %s: %w", address, err)
	}
	return listener, listener.Addr().String(), nil
}

func writeReadyFile(path, baseURL string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create readiness directory: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".euphony-ready-*")
	if err != nil {
		return fmt.Errorf("create readiness file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("protect readiness file: %w", err)
	}
	if _, err := io.WriteString(temporary, baseURL+"\n"); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write readiness file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close readiness file: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("publish readiness file: %w", err)
	}
	return nil
}

func runAgentSetupPreflight(
	interactive bool, offer func() error, warn func(error),
) {
	if !interactive {
		return
	}
	if err := offer(); err != nil {
		warn(err)
	}
}

func offerAgentSetupOnStartup(stdin io.Reader, stdout io.Writer) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("resolve home directory for agent setup: %w", err)
	}
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve executable for agent setup: %w", err)
	}
	return maybeOfferAgentSetup(euphonysetup.Config{
		HomeDir:    home,
		CodexDir:   os.Getenv("CODEX_HOME"),
		ClaudeDir:  os.Getenv("CLAUDE_CONFIG_DIR"),
		Executable: executable,
		Path:       os.Getenv("PATH"),
	}, stdin, stdout)
}

func maybeOfferAgentSetup(
	config euphonysetup.Config, stdin io.Reader, stdout io.Writer,
) error {
	declinedPath := setupPromptDeclinedPath(config.HomeDir)
	if _, err := os.Stat(declinedPath); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("check setup prompt preference: %w", err)
	}
	status, err := euphonysetup.Inspect(config)
	if err != nil {
		return err
	}
	if len(status.NeedsSetup) == 0 {
		return nil
	}

	writeSetupExplanation(stdout)
	reader := bufio.NewReader(stdin)
	for {
		_, _ = fmt.Fprint(
			stdout,
			"Euphony hooks or skills are missing or outdated. Install them now? (Y/n) ",
		)
		response, readErr := reader.ReadString('\n')
		response = strings.ToLower(strings.TrimSpace(response))
		switch response {
		case "", "y", "yes":
			if readErr != nil && errors.Is(readErr, io.EOF) {
				_, _ = fmt.Fprintln(stdout)
				return nil
			}
			_, err := installAgentSetup(config, stdout)
			return err
		case "n", "no":
			if err := persistSetupPromptDecline(declinedPath); err != nil {
				return err
			}
			_, _ = fmt.Fprintln(
				stdout,
				"Skipped. Run 'euphony setup' to install hooks and skills later.",
			)
			return nil
		default:
			if readErr != nil {
				return fmt.Errorf("read setup response: %w", readErr)
			}
			_, _ = fmt.Fprintln(stdout, "Please answer y or n.")
		}
	}
}

func writeSetupExplanation(stdout io.Writer) {
	_, _ = fmt.Fprintln(stdout, "Euphony can install coding-agent integrations:")
	_, _ = fmt.Fprintln(
		stdout, "  Hooks: report agent status and session metadata to Euphony.",
	)
	_, _ = fmt.Fprintln(
		stdout,
		"  Skill: lets coding agents ask you to annotate Markdown and HTML files in Euphony.",
	)
	_, _ = fmt.Fprintln(stdout, "Existing agent settings are preserved.")
}

func setupPromptDeclinedPath(home string) string {
	return filepath.Join(home, ".local", "euphony", "setup-prompt-declined")
}

func persistSetupPromptDecline(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create setup preference directory: %w", err)
	}
	if err := os.WriteFile(path, []byte("declined\n"), 0o600); err != nil {
		return fmt.Errorf("save setup prompt preference: %w", err)
	}
	return nil
}

func isTerminalReader(reader io.Reader) bool {
	file, ok := reader.(*os.File)
	if !ok {
		return false
	}
	return isatty.IsTerminal(file.Fd()) || isatty.IsCygwinTerminal(file.Fd())
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
	command, args := browserCommand(runtime.GOOS, url)
	return exec.Command(command, args...).Start()
}

func browserCommand(goos, url string) (string, []string) {
	switch goos {
	case "darwin":
		return "open", []string{url}
	case "windows":
		return "rundll32.exe", []string{"url.dll,FileProtocolHandler", url}
	default:
		return "xdg-open", []string{url}
	}
}
