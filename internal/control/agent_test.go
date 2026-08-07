package control

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/ryotarai/euphony/internal/session"
)

func decodeRawBase64(t *testing.T, value string) []byte {
	t.Helper()
	data, err := base64.RawStdEncoding.DecodeString(value)
	if err != nil {
		t.Fatalf("DecodeString() error = %v", err)
	}
	return data
}

func TestStartAgentQuotesArgumentsAndWaitsForExpectedHook(t *testing.T) {
	manager := session.NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(t.Context()) })
	metadata, err := manager.Create(t.Context(), "Agent", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	service, err := New(manager)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	commands := make(chan string, 1)
	service.runCommand = func(id, command string) error {
		if id != metadata.ID {
			t.Fatalf("run terminal ID = %q, want %q", id, metadata.ID)
		}
		commands <- command
		return nil
	}
	result := make(chan error, 1)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	go func() {
		_, startErr := service.StartAgent(ctx, metadata.ID, "codex",
			[]string{"--model", "model with spaces", "it's-safe"})
		result <- startErr
	}()

	command := <-commands
	const want = "codex '--model' 'model with spaces' 'it'\"'\"'s-safe'"
	if command != want {
		t.Fatalf("agent command = %q, want %q", command, want)
	}
	if _, err := manager.UpdateAgent(metadata.ID, session.AgentUpdate{
		Agent: "claude", Status: "waiting",
	}); err != nil {
		t.Fatalf("UpdateAgent(claude) error = %v", err)
	}
	select {
	case err := <-result:
		t.Fatalf("StartAgent returned for wrong agent: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	if _, err := manager.UpdateAgent(metadata.ID, session.AgentUpdate{
		Agent: "codex", Status: "waiting",
	}); err != nil {
		t.Fatalf("UpdateAgent(codex) error = %v", err)
	}
	if err := <-result; err != nil {
		t.Fatalf("StartAgent() error = %v", err)
	}
}

func TestStartAgentRejectsUnsupportedKindBeforeRunningCommand(t *testing.T) {
	manager := session.NewManager("/bin/sh")
	metadata, err := manager.Create(t.Context(), "Agent", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	t.Cleanup(func() { _ = manager.Close(t.Context()) })
	service, err := New(manager)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	called := false
	service.runCommand = func(string, string) error {
		called = true
		return nil
	}

	_, err = service.StartAgent(context.Background(), metadata.ID, "gemini", nil)
	if !errors.Is(err, ErrUnsupportedAgent) || called {
		t.Fatalf("StartAgent(gemini) = %v, called %t", err, called)
	}
}

func TestPromptAgentUsesBracketedPasteAndWaitsForRunningThenSettled(t *testing.T) {
	manager := session.NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(t.Context()) })
	metadata, err := manager.Create(t.Context(), "Agent", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	service, err := New(manager)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if _, err := manager.UpdateAgent(metadata.ID, session.AgentUpdate{
		Agent: "claude", Status: "waiting",
	}); err != nil {
		t.Fatalf("UpdateAgent(waiting) error = %v", err)
	}
	service.agentForeground = func(id, kind string) error {
		if id != metadata.ID || kind != "claude" {
			t.Fatalf("agent foreground check = %q, %q", id, kind)
		}
		return nil
	}
	inputs := make(chan TerminalInput, 1)
	service.sendInput = func(id string, input TerminalInput) error {
		if id != metadata.ID {
			t.Fatalf("input terminal ID = %q", id)
		}
		inputs <- input
		return nil
	}
	result := make(chan error, 1)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	go func() {
		_, promptErr := service.PromptAgent(ctx, metadata.ID, "Review this\ncarefully", true, nil)
		result <- promptErr
	}()

	input := <-inputs
	if input.DataBase64 == "" || input.Text != nil || len(input.Keys) != 0 {
		t.Fatalf("prompt input = %#v", input)
	}
	decoded := decodeRawBase64(t, input.DataBase64)
	if string(decoded) != "\x1b[200~Review this\ncarefully\x1b[201~\r" {
		t.Fatalf("prompt bytes = %q", decoded)
	}
	if _, err := manager.UpdateAgent(metadata.ID, session.AgentUpdate{
		Agent: "claude", Status: "running",
	}); err != nil {
		t.Fatalf("UpdateAgent(running) error = %v", err)
	}
	if _, err := manager.UpdateAgent(metadata.ID, session.AgentUpdate{
		Agent: "claude", Status: "waiting",
	}); err != nil {
		t.Fatalf("UpdateAgent(settled) error = %v", err)
	}
	if err := <-result; err != nil {
		t.Fatalf("PromptAgent() error = %v", err)
	}
}

func TestWaitAgentReturnsImmediatelyForMatchingBlockedState(t *testing.T) {
	manager := session.NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(t.Context()) })
	metadata, err := manager.Create(t.Context(), "Agent", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	service, err := New(manager)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if _, err := manager.UpdateAgent(metadata.ID, session.AgentUpdate{
		Agent: "claude", Status: "blocked",
	}); err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}

	agent, err := service.WaitAgent(context.Background(), metadata.ID, []string{"blocked"})
	if err != nil || agent.Agent != "claude" || agent.AgentStatus != "blocked" {
		t.Fatalf("WaitAgent() = %#v, %v", agent, err)
	}
}

func TestPromptAgentRejectsTerminalWithoutRecognizedAgent(t *testing.T) {
	manager := session.NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(t.Context()) })
	metadata, err := manager.Create(t.Context(), "Plain", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	service, err := New(manager)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	_, err = service.PromptAgent(context.Background(), metadata.ID, "hello", false, nil)
	if !errors.Is(err, ErrAgentNotRunning) {
		t.Fatalf("PromptAgent() error = %v, want ErrAgentNotRunning", err)
	}
}

func TestPromptAgentRejectsStaleMetadataWhenAgentDoesNotOwnForeground(t *testing.T) {
	manager := session.NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(t.Context()) })
	metadata, err := manager.Create(t.Context(), "Stale", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	service, err := New(manager)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if _, err := manager.UpdateAgent(metadata.ID, session.AgentUpdate{
		Agent: "codex", Status: "waiting",
	}); err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
	called := false
	service.sendInput = func(string, TerminalInput) error {
		called = true
		return nil
	}

	_, err = service.PromptAgent(context.Background(), metadata.ID, "hello", false, nil)
	if !errors.Is(err, ErrAgentNotRunning) || called {
		t.Fatalf("PromptAgent() error = %v, input called = %t", err, called)
	}
}

func TestAgentStartRejectsNULArgument(t *testing.T) {
	if _, err := agentCommand("codex", []string{"bad\x00arg"}); !errors.Is(err, ErrInvalidAgentInput) {
		t.Fatalf("agentCommand() error = %v", err)
	}
	if command, err := agentCommand("claude", []string{"--name", ""}); err != nil ||
		!strings.HasPrefix(command, "claude ") {
		t.Fatalf("agentCommand() = %q, %v", command, err)
	}
}
