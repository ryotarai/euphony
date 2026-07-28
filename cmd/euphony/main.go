package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ryotarai/euphony/internal/agenthook"
	"github.com/ryotarai/euphony/internal/server"
	euphonysetup "github.com/ryotarai/euphony/internal/setup"
)

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		log.Fatal(err)
	}
}

func run(args []string, stdin io.Reader, stdout io.Writer) error {
	if len(args) > 0 {
		switch args[0] {
		case "setup":
			return runSetup(stdout)
		case "hook":
			return runHook(args[1:], stdin)
		default:
			return fmt.Errorf("unknown command %q; use euphony setup or run euphony without arguments", args[0])
		}
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
	srv, err := server.New(server.Config{
		Token:   os.Getenv("EUPHONY_TOKEN"),
		Shell:   os.Getenv("SHELL"),
		HookURL: "http://" + address + "/api/hooks/terminal",
	})
	if err != nil {
		log.Fatal(err)
	}

	log.Printf("Euphony listening on http://%s", address)
	httpServer := &http.Server{
		Addr:              address,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	result := make(chan error, 1)
	go func() {
		result <- httpServer.ListenAndServe()
	}()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)

	select {
	case err := <-result:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-signals:
		log.Print("Shutting down Euphony")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	shutdownErr := httpServer.Shutdown(ctx)
	sessionErr := srv.Close(ctx)
	if shutdownErr != nil {
		return shutdownErr
	}
	return sessionErr
}
