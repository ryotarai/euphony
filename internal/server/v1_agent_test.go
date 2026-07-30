package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ryotarai/euphony/internal/agentlog"
	"github.com/ryotarai/euphony/internal/session"
)

func TestV1AgentListGetInputPromptAndWait(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	terminal, err := srv.sessions.Create(t.Context(), "Agent")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	agentPath := filepath.Join(t.TempDir(), "codex-test-agent")
	if err := os.WriteFile(agentPath, []byte("#!/bin/sh\nsleep 30\n"), 0o700); err != nil {
		t.Fatalf("WriteFile(agent) error = %v", err)
	}
	if err := srv.control.RunTerminal(terminal.ID, strconv.Quote(agentPath)); err != nil {
		t.Fatalf("RunTerminal(agent) error = %v", err)
	}
	running, _ := srv.sessions.Get(terminal.ID)
	deadline := time.Now().Add(time.Second)
	for {
		command, commandErr := running.ForegroundCommand()
		if commandErr == nil && strings.Contains(command, "codex-test-agent") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("agent did not enter foreground: %q, %v", command, commandErr)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := srv.sessions.UpdateAgent(terminal.ID, session.AgentUpdate{
		Agent: "codex", AgentSessionID: "session-1", Status: "blocked",
	}); err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}

	listed := performRequest(t, srv, http.MethodGet, "/api/v1/agents", "")
	var listEnvelope struct {
		OK     bool `json:"ok"`
		Result struct {
			Agents []session.Metadata `json:"agents"`
		} `json:"result"`
	}
	decodeResponse(t, listed, &listEnvelope)
	if !listEnvelope.OK || len(listEnvelope.Result.Agents) != 1 ||
		listEnvelope.Result.Agents[0].ID != terminal.ID {
		t.Fatalf("list response = %#v", listEnvelope)
	}

	got := performRequest(t, srv, http.MethodGet, "/api/v1/agents/"+terminal.ID, "")
	if got.Code != http.StatusOK || !strings.Contains(got.Body.String(), `"agent":"codex"`) {
		t.Fatalf("get response = %d, %s", got.Code, got.Body.String())
	}
	waited := performRequest(t, srv, http.MethodPost, "/api/v1/agents/"+terminal.ID+"/wait",
		`{"until":["blocked"],"timeoutMs":100}`)
	if waited.Code != http.StatusOK {
		t.Fatalf("wait response = %d, %s", waited.Code, waited.Body.String())
	}
	input := performRequest(t, srv, http.MethodPost, "/api/v1/agents/"+terminal.ID+"/input",
		`{"keys":["escape"]}`)
	if input.Code != http.StatusOK {
		t.Fatalf("input response = %d, %s", input.Code, input.Body.String())
	}
	prompt := performRequest(t, srv, http.MethodPost, "/api/v1/agents/"+terminal.ID+"/prompt",
		`{"prompt":"Summarize the result.","wait":false}`)
	if prompt.Code != http.StatusOK {
		t.Fatalf("prompt response = %d, %s", prompt.Code, prompt.Body.String())
	}
}

func TestV1AgentTranscriptAndTerminalOutput(t *testing.T) {
	claudeRoot := filepath.Join(t.TempDir(), "claude-projects")
	transcriptPath := filepath.Join(claudeRoot, "repo", "session-1.jsonl")
	if err := os.MkdirAll(filepath.Dir(transcriptPath), 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(transcriptPath, []byte(
		`{"type":"assistant","message":{"role":"assistant","content":"Done"}}`+"\n",
	), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	srv, err := New(Config{
		Token: "token", Shell: "/bin/sh", ClaudeProjectsRoot: claudeRoot,
		CodexSessionsRoot: t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	terminal, err := srv.sessions.Create(t.Context(), "Claude")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := srv.sessions.UpdateAgent(terminal.ID, session.AgentUpdate{
		Agent: "claude", AgentSessionID: "session-1",
		TranscriptPath: transcriptPath, Status: "waiting",
	}); err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}

	response := performRequest(t, srv, http.MethodGet,
		"/api/v1/agents/"+terminal.ID+"/output?source=transcript", "")
	var envelope struct {
		Result agentlog.Transcript `json:"result"`
	}
	decodeResponse(t, response, &envelope)
	if response.Code != http.StatusOK || len(envelope.Result.Entries) != 1 ||
		envelope.Result.Entries[0].Content != "Done" {
		t.Fatalf("transcript response = %d, %#v", response.Code, envelope)
	}

	terminalOutput := performRequest(t, srv, http.MethodGet,
		"/api/v1/agents/"+terminal.ID+"/output?source=terminal&maxBytes="+strconv.Itoa(1024), "")
	if terminalOutput.Code != http.StatusOK ||
		!strings.Contains(terminalOutput.Body.String(), `"terminalId":"`+terminal.ID+`"`) {
		t.Fatalf("terminal output = %d, %s", terminalOutput.Code, terminalOutput.Body.String())
	}
}

func TestV1AgentValidationUsesStableErrors(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	terminal, err := srv.sessions.Create(t.Context(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	tests := []struct {
		name, path, body, code string
	}{
		{"unsupported kind", "/api/v1/agents/" + terminal.ID + "/start",
			`{"kind":"gemini"}`, "unsupported_agent"},
		{"unknown field", "/api/v1/agents/" + terminal.ID + "/start",
			`{"kind":"codex","extra":true}`, "invalid_request"},
		{"until without wait", "/api/v1/agents/" + terminal.ID + "/prompt",
			`{"prompt":"x","until":["waiting"]}`, "invalid_request"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := performRequest(t, srv, http.MethodPost, test.path, test.body)
			var envelope struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if response.Code != http.StatusBadRequest || envelope.Error.Code != test.code {
				t.Fatalf("response = %d %#v", response.Code, envelope)
			}
		})
	}
}
