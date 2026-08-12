package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	euphonysetup "github.com/ryotarai/euphony/internal/setup"
)

func TestHTTPServerShutdownCancelsLongLivedRequests(t *testing.T) {
	requestContext, cancelRequests := context.WithCancel(context.Background())
	defer cancelRequests()
	requestStarted := make(chan struct{})
	requestDone := make(chan struct{})
	server := newHTTPServer(
		"",
		http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
			close(requestStarted)
			<-request.Context().Done()
			close(requestDone)
		}),
		requestContext,
		cancelRequests,
	)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = server.Close()
		_ = listener.Close()
	})
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()
	clientDone := make(chan error, 1)
	go func() {
		response, requestErr := http.Get("http://" + listener.Addr().String())
		if response != nil {
			_ = response.Body.Close()
		}
		clientDone <- requestErr
	}()
	select {
	case <-requestStarted:
	case <-time.After(time.Second):
		t.Fatal("long-lived request did not start")
	}

	shutdownContext, cancelShutdown := context.WithTimeout(context.Background(), time.Second)
	defer cancelShutdown()
	if err := server.Shutdown(shutdownContext); err != nil {
		t.Fatalf("server.Shutdown() error = %v", err)
	}
	select {
	case <-requestDone:
	case <-time.After(time.Second):
		t.Fatal("long-lived request was not canceled")
	}
	select {
	case err := <-serveDone:
		if !errors.Is(err, http.ErrServerClosed) {
			t.Fatalf("server.Serve() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("server.Serve() did not stop")
	}
	select {
	case <-clientDone:
	case <-time.After(time.Second):
		t.Fatal("HTTP client did not observe the closed request")
	}
}

func TestShutdownStepReportsTimeoutStage(t *testing.T) {
	var messages strings.Builder
	logf := func(format string, args ...any) {
		_, _ = fmt.Fprintf(&messages, format+"\n", args...)
	}

	err := shutdownStep(
		context.Background(),
		"HTTP server",
		func(context.Context) error { return context.DeadlineExceeded },
		logf,
	)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("shutdownStep() error = %v, want context deadline exceeded", err)
	}
	if !strings.Contains(err.Error(), "shutdown HTTP server") {
		t.Fatalf("shutdownStep() error = %v, want stage name", err)
	}
	message := messages.String()
	if !strings.Contains(message, "HTTP server") ||
		!strings.Contains(message, "timed out") ||
		!strings.Contains(message, "long-lived connections") {
		t.Fatalf("shutdownStep() log = %q, want timeout guidance", message)
	}
}

func TestMaybeOfferAgentSetupDeclinePersistsAndSuppressesLaterOffers(t *testing.T) {
	config := startupSetupTestConfig(t)
	var output bytes.Buffer

	if err := maybeOfferAgentSetup(
		config, strings.NewReader("n\n"), &output,
	); err != nil {
		t.Fatalf("maybeOfferAgentSetup() error = %v", err)
	}
	if !strings.Contains(output.String(), "Install them now? (Y/n)") ||
		!strings.Contains(output.String(), "Run 'euphony setup'") {
		t.Fatalf("output = %q", output.String())
	}
	for _, explanation := range []string{
		"Hooks: report agent status and session metadata to Euphony.",
		"Skill: lets coding agents ask you to annotate Markdown and HTML files in Euphony.",
		"Existing agent settings are preserved.",
	} {
		if !strings.Contains(output.String(), explanation) {
			t.Fatalf("output does not explain %q: %q", explanation, output.String())
		}
	}
	if _, err := os.Stat(setupPromptDeclinedPath(config.HomeDir)); err != nil {
		t.Fatalf("decline marker: %v", err)
	}

	if err := os.MkdirAll(config.CodexDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(config.CodexDir, "hooks.json"), []byte(`{"hooks":[]}`), 0o600,
	); err != nil {
		t.Fatal(err)
	}
	output.Reset()
	if err := maybeOfferAgentSetup(
		config, strings.NewReader("y\n"), &output,
	); err != nil {
		t.Fatalf("second maybeOfferAgentSetup() error = %v", err)
	}
	if output.Len() != 0 {
		t.Fatalf("second output = %q, want empty", output.String())
	}
}

func TestMaybeOfferAgentSetupAcceptsDefaultAndYes(t *testing.T) {
	for _, response := range []string{"\n", "yes\n"} {
		t.Run(strings.TrimSpace(response), func(t *testing.T) {
			config := startupSetupTestConfig(t)
			var output bytes.Buffer

			if err := maybeOfferAgentSetup(
				config, strings.NewReader(response), &output,
			); err != nil {
				t.Fatalf("maybeOfferAgentSetup() error = %v", err)
			}
			skill, err := os.ReadFile(filepath.Join(
				config.CodexDir, "skills", "euphony-annotate", "SKILL.md",
			))
			if err != nil {
				t.Fatalf("read installed skill: %v", err)
			}
			if !bytes.Contains(skill, []byte("name: euphony-annotate")) {
				t.Fatalf("installed skill = %q", skill)
			}
			if !strings.Contains(output.String(), "Installed codex hooks and skills.") {
				t.Fatalf("output = %q", output.String())
			}
		})
	}
}

func TestMaybeOfferAgentSetupRetriesInvalidResponse(t *testing.T) {
	config := startupSetupTestConfig(t)
	var output bytes.Buffer

	if err := maybeOfferAgentSetup(
		config, strings.NewReader("later\ny\n"), &output,
	); err != nil {
		t.Fatalf("maybeOfferAgentSetup() error = %v", err)
	}
	if got := strings.Count(output.String(), "(Y/n)"); got != 2 {
		t.Fatalf("prompt count = %d, want 2; output = %q", got, output.String())
	}
	if !strings.Contains(output.String(), "Please answer y or n.") {
		t.Fatalf("output = %q", output.String())
	}
}

func TestMaybeOfferAgentSetupIsSilentWhenIntegrationIsCurrent(t *testing.T) {
	config := startupSetupTestConfig(t)
	if _, err := euphonysetup.Install(config); err != nil {
		t.Fatalf("Install() error = %v", err)
	}
	var output bytes.Buffer

	if err := maybeOfferAgentSetup(
		config, strings.NewReader("n\n"), &output,
	); err != nil {
		t.Fatalf("maybeOfferAgentSetup() error = %v", err)
	}
	if output.Len() != 0 {
		t.Fatalf("output = %q, want empty", output.String())
	}
	if _, err := os.Stat(setupPromptDeclinedPath(config.HomeDir)); !os.IsNotExist(err) {
		t.Fatalf("decline marker exists after silent check: %v", err)
	}
}

func TestRunSetupExplainsIntegrationsBeforeInstalling(t *testing.T) {
	config := startupSetupTestConfig(t)
	t.Setenv("HOME", config.HomeDir)
	t.Setenv("CODEX_HOME", config.CodexDir)
	t.Setenv("CLAUDE_CONFIG_DIR", config.ClaudeDir)
	t.Setenv("PATH", config.Path)
	var output bytes.Buffer

	if err := runSetup(&output); err != nil {
		t.Fatalf("runSetup() error = %v", err)
	}
	text := output.String()
	for _, expected := range []string{
		"Hooks: report agent status and session metadata to Euphony.",
		"Skill: lets coding agents ask you to annotate Markdown and HTML files in Euphony.",
		"Existing agent settings are preserved.",
		"Installed codex hooks and skills.",
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("output does not contain %q: %q", expected, text)
		}
	}
	if strings.Index(text, "Hooks:") > strings.Index(text, "Installed codex") {
		t.Fatalf("explanation follows installation result: %q", text)
	}
}

func TestRunAgentSetupPreflightSkipsNonInteractiveInput(t *testing.T) {
	called := false

	runAgentSetupPreflight(false, func() error {
		called = true
		return nil
	}, func(error) {
		t.Fatal("warning called for skipped preflight")
	})

	if called {
		t.Fatal("offer called for non-interactive input")
	}
}

func TestRunAgentSetupPreflightReportsOptionalFailureAndReturns(t *testing.T) {
	setupErr := errors.New("setup failed")
	var warning error

	runAgentSetupPreflight(true, func() error {
		return setupErr
	}, func(err error) {
		warning = err
	})

	if !errors.Is(warning, setupErr) {
		t.Fatalf("warning = %v, want setup failure", warning)
	}
}

func TestResolveTokenGeneratesSecureTokenWhenUnset(t *testing.T) {
	token, generated, err := resolveToken("")
	if err != nil {
		t.Fatalf("resolveToken() error = %v", err)
	}
	if !generated {
		t.Fatal("resolveToken() generated = false, want true")
	}
	if len(token) < 32 {
		t.Fatalf("resolveToken() token length = %d, want at least 32", len(token))
	}
}

func TestResolveTokenPreservesConfiguredToken(t *testing.T) {
	token, generated, err := resolveToken("configured-token")
	if err != nil {
		t.Fatalf("resolveToken() error = %v", err)
	}
	if generated {
		t.Fatal("resolveToken() generated = true, want false")
	}
	if token != "configured-token" {
		t.Fatalf("resolveToken() token = %q, want configured token", token)
	}
}

func TestBrowserURLIncludesEscapedToken(t *testing.T) {
	rawURL := browserURL("127.0.0.1:8080", "a token&value")
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("browserURL() returned invalid URL %q: %v", rawURL, err)
	}
	if parsed.Scheme != "http" || parsed.Host != "127.0.0.1:8080" {
		t.Fatalf("browserURL() = %q, want local HTTP URL", rawURL)
	}
	if got := parsed.Query().Get("token"); got != "a token&value" {
		t.Fatalf("browserURL() token = %q, want escaped token", got)
	}
}

func TestListenTCPResolvesEphemeralAddress(t *testing.T) {
	listener, address, err := listenTCP("127.0.0.1:0")
	if err != nil {
		t.Fatalf("listenTCP() error = %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	if address == "127.0.0.1:0" || !strings.HasPrefix(address, "127.0.0.1:") {
		t.Fatalf("listenTCP() address = %q, want an assigned loopback port", address)
	}
}

func TestWriteReadyFileCreatesPrivateAtomicURLFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "ready")
	if err := writeReadyFile(path, "http://127.0.0.1:43210"); err != nil {
		t.Fatalf("writeReadyFile() error = %v", err)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read readiness file: %v", err)
	}
	if string(content) != "http://127.0.0.1:43210\n" {
		t.Fatalf("readiness content = %q", content)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat readiness file: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("readiness mode = %o, want 600", info.Mode().Perm())
	}
}

func TestAgentLogRootsRespectConfiguredAgentHomes(t *testing.T) {
	codex, claude := agentLogRoots(
		"/home/me", "/profiles/codex", "/profiles/claude",
	)
	if codex != filepath.Join("/profiles/codex", "sessions") ||
		claude != filepath.Join("/profiles/claude", "projects") {
		t.Fatalf("agentLogRoots() = %q, %q", codex, claude)
	}

	codex, claude = agentLogRoots("/home/me", "", "")
	if codex != filepath.Join("/home/me", ".codex", "sessions") ||
		claude != filepath.Join("/home/me", ".claude", "projects") {
		t.Fatalf("default agentLogRoots() = %q, %q", codex, claude)
	}
}

func startupSetupTestConfig(t *testing.T) euphonysetup.Config {
	t.Helper()
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(binDir, "codex"), []byte("#!/bin/sh\n"), 0o755,
	); err != nil {
		t.Fatal(err)
	}
	return euphonysetup.Config{
		HomeDir:    home,
		CodexDir:   filepath.Join(home, ".codex"),
		ClaudeDir:  filepath.Join(home, ".claude"),
		Executable: "/opt/euphony/bin/euphony",
		Path:       binDir,
	}
}
