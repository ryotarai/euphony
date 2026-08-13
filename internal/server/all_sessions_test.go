package server

import (
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ryotarai/euphony/internal/selection"
	"github.com/ryotarai/euphony/internal/session"
)

func TestAllSessionsListsCurrentAndHistoricalAgentSessionsNewestFirst(t *testing.T) {
	root := t.TempDir()
	codexRoot := filepath.Join(root, "codex", "sessions")
	claudeRoot := filepath.Join(root, "claude", "projects")
	codexIndex := filepath.Join(root, "codex", "session_index.jsonl")
	codexTranscript := filepath.Join(codexRoot, "2026", "08", "13", "session-current.jsonl")
	claudeTranscript := filepath.Join(claudeRoot, "repo", "session-old.jsonl")
	writeAllSessionsFixture(t, codexIndex, strings.Join([]string{
		`{"id":"session-current","thread_name":"Current rollout","updated_at":"2026-08-13T09:00:00Z"}`,
	}, "\n"))
	writeAllSessionsFixture(t, codexTranscript, strings.Join([]string{
		`{"type":"session_meta","timestamp":"2026-08-13T08:55:00Z","payload":{"id":"session-current","cwd":"` + t.TempDir() + `"}}`,
		`{"type":"response_item","timestamp":"2026-08-13T08:56:00Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Build the session index"}]}}`,
	}, "\n"))
	writeAllSessionsFixture(t, claudeTranscript, strings.Join([]string{
		`{"type":"user","sessionId":"session-old","cwd":"/workspace/old","timestamp":"2026-08-12T08:00:00Z","message":{"role":"user","content":"Review the old session"}}`,
		`{"type":"assistant","sessionId":"session-old","timestamp":"2026-08-12T08:01:00Z","message":{"role":"assistant","content":"The old session is complete."}}`,
	}, "\n"))

	srv, err := New(Config{
		Token:              "token",
		Shell:              "/bin/sh",
		CodexSessionIndex:  codexIndex,
		CodexSessionsRoot:  codexRoot,
		ClaudeProjectsRoot: claudeRoot,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	currentCWD := t.TempDir()
	current, err := srv.sessions.Create(t.Context(), "Current terminal", currentCWD)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := srv.sessions.UpdateAgent(current.ID, session.AgentUpdate{
		Agent:          "codex",
		AgentSessionID: "session-current",
		TranscriptPath: codexTranscript,
		Status:         "waiting",
		Title:          "Current rollout",
	}); err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
	if err := srv.sessions.SaveAgentSummary(t.Context(), session.AgentSummary{
		TerminalID:  current.ID,
		Provider:    "codex",
		Status:      "waiting",
		Purpose:     "Build the session index",
		Summary:     "The current terminal is waiting.",
		GeneratedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("SaveAgentSummary() error = %v", err)
	}

	response := performRequest(t, srv, http.MethodGet, "/api/all-sessions", "")
	if response.Code != http.StatusOK {
		t.Fatalf("GET /api/all-sessions status = %d, body = %s", response.Code, response.Body.String())
	}
	var items []allSession
	decodeResponse(t, response, &items)
	if len(items) != 2 {
		t.Fatalf("all sessions = %#v, want current plus history", items)
	}
	if items[0].State != allSessionOpen || items[0].TerminalID != current.ID ||
		items[0].Agent != "codex" || items[0].SessionID != "session-current" ||
		items[0].Purpose != "Build the session index" ||
		items[0].Summary != "The current terminal is waiting." {
		t.Fatalf("current all session = %#v", items[0])
	}
	if items[1].Agent != "claude" || items[1].SessionID != "session-old" ||
		items[1].State != allSessionResume || items[1].Purpose != "Review the old session" ||
		items[1].Summary != "The old session is complete." {
		t.Fatalf("historical all session = %#v", items[1])
	}
	if !items[0].UpdatedAt.After(items[1].UpdatedAt) {
		t.Fatalf("all sessions are not newest first: %#v", items)
	}
}

func TestAllSessionsResumeStartsCodexWithSeparateArgumentsAndSelection(t *testing.T) {
	root := t.TempDir()
	codexRoot := filepath.Join(root, "codex", "sessions")
	codexIndex := filepath.Join(root, "codex", "session_index.jsonl")
	cwd := t.TempDir()
	transcript := filepath.Join(codexRoot, "session-resume.jsonl")
	argsPath := filepath.Join(root, "codex-args.txt")
	writeAllSessionsFixture(t, codexIndex,
		`{"id":"session-resume","thread_name":"Resume rollout","updated_at":"2026-08-13T09:00:00Z"}`+"\n")
	writeAllSessionsFixture(t, transcript, strings.Join([]string{
		`{"type":"session_meta","timestamp":"2026-08-13T08:00:00Z","payload":{"id":"session-resume","cwd":"` + cwd + `"}}`,
		`{"type":"response_item","timestamp":"2026-08-13T08:01:00Z","payload":{"type":"message","role":"user","content":"Continue the rollout"}}`,
	}, "\n"))
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("MkdirAll(bin) error = %v", err)
	}
	codexCommand := filepath.Join(binDir, "codex")
	if err := os.WriteFile(codexCommand, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \""+argsPath+"\"\nsleep 30\n"), 0o700); err != nil {
		t.Fatalf("WriteFile(codex) error = %v", err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	srv, err := New(Config{
		Token:             "token",
		Shell:             "/bin/sh",
		CodexSessionIndex: codexIndex,
		CodexSessionsRoot: codexRoot,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	response := performRequest(t, srv, http.MethodPost,
		"/api/all-sessions/codex/session-resume/resume",
		`{"selectionMode":"replace"}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("POST resume status = %d, body = %s", response.Code, response.Body.String())
	}
	var result struct {
		Terminal  session.Metadata   `json:"terminal"`
		Selection selection.Snapshot `json:"selection"`
	}
	decodeResponse(t, response, &result)
	if result.Terminal.ID == "" || result.Terminal.CWD != cwd || result.Terminal.State != session.StateRunning {
		t.Fatalf("resumed terminal = %#v", result.Terminal)
	}
	if !reflect.DeepEqual(result.Selection.TerminalIDs, []string{result.Terminal.ID}) ||
		result.Selection.FocusedTerminalID != result.Terminal.ID {
		t.Fatalf("resume selection = %#v", result.Selection)
	}
	waitForServer(t, 3*time.Second, func() bool {
		data, err := os.ReadFile(argsPath)
		return err == nil && string(data) == "resume\nsession-resume\n"
	})
}

func TestAllSessionsResumeReusesOpenMatchingAgentTerminal(t *testing.T) {
	root := t.TempDir()
	codexRoot := filepath.Join(root, "codex", "sessions")
	transcript := filepath.Join(codexRoot, "session-open.jsonl")
	writeAllSessionsFixture(t, transcript, strings.Join([]string{
		`{"type":"session_meta","timestamp":"2026-08-13T08:00:00Z","payload":{"id":"session-open","cwd":"` + t.TempDir() + `"}}`,
		`{"type":"response_item","timestamp":"2026-08-13T08:01:00Z","payload":{"type":"message","role":"user","content":"Keep this terminal open"}}`,
	}, "\n"))

	srv, err := New(Config{
		Token:             "token",
		Shell:             "/bin/sh",
		CodexSessionsRoot: codexRoot,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	current, err := srv.sessions.Create(t.Context(), "Open Codex", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := srv.sessions.UpdateAgent(current.ID, session.AgentUpdate{
		Agent:          "codex",
		AgentSessionID: "session-open",
		TranscriptPath: transcript,
		Status:         "waiting",
	}); err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}

	response := performRequest(t, srv, http.MethodPost,
		"/api/all-sessions/codex/session-open/resume", `{"selectionMode":"replace"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("POST resume existing status = %d, body = %s", response.Code, response.Body.String())
	}
	var result struct {
		Terminal  session.Metadata   `json:"terminal"`
		Selection selection.Snapshot `json:"selection"`
	}
	decodeResponse(t, response, &result)
	if result.Terminal.ID != current.ID {
		t.Fatalf("reused terminal = %#v, want %q", result.Terminal, current.ID)
	}
	if !reflect.DeepEqual(result.Selection.TerminalIDs, []string{current.ID}) {
		t.Fatalf("reused selection = %#v", result.Selection)
	}
}

func TestResumeWorkingDirectoryFallsBackToHomeWhenHistoryDirectoryDisappears(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir() error = %v", err)
	}
	if got, err := resumeWorkingDirectory(filepath.Join(t.TempDir(), "missing")); err != nil || got != home {
		t.Fatalf("resumeWorkingDirectory(missing) = %q, %v; want home %q", got, err, home)
	}
	working := t.TempDir()
	if got, err := resumeWorkingDirectory(working); err != nil || got != working {
		t.Fatalf("resumeWorkingDirectory(existing) = %q, %v; want %q", got, err, working)
	}
}

func writeAllSessionsFixture(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll(%q) error = %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("WriteFile(%q) error = %v", path, err)
	}
}
