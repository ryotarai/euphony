package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ryotarai/euphony/internal/agentlog"
	"github.com/ryotarai/euphony/internal/session"
)

func TestAgentLogEndpointReturnsLinkedTranscriptAndSupportsETag(t *testing.T) {
	claudeRoot := filepath.Join(t.TempDir(), "claude-projects")
	transcriptPath := filepath.Join(claudeRoot, "repo", "session-1.jsonl")
	if err := os.MkdirAll(filepath.Dir(transcriptPath), 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	initial := `{"type":"assistant","timestamp":"2026-07-30T01:02:03Z","message":{"role":"assistant","content":[{"type":"text","text":"First"}]}}` + "\n"
	if err := os.WriteFile(transcriptPath, []byte(initial), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	srv, err := New(Config{
		Token: "token", Shell: "/bin/sh", ClaudeProjectsRoot: claudeRoot,
		CodexSessionsRoot: filepath.Join(t.TempDir(), "codex-sessions"),
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	terminal, err := srv.sessions.Create(t.Context(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	_, err = srv.sessions.UpdateAgent(terminal.ID, session.AgentUpdate{
		Agent: "claude", AgentSessionID: "session-1", TranscriptPath: transcriptPath,
	})
	if err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}

	first := performAgentLogRequest(t, srv, terminal.ID, "")
	if first.Code != http.StatusOK {
		t.Fatalf("GET agent log status = %d, body = %s", first.Code, first.Body.String())
	}
	etag := first.Header().Get("ETag")
	if etag == "" {
		t.Fatal("GET agent log ETag is empty")
	}
	if first.Header().Get("Cache-Control") != "private, no-cache" {
		t.Fatalf("Cache-Control = %q", first.Header().Get("Cache-Control"))
	}
	var transcript agentlog.Transcript
	if err := json.NewDecoder(first.Body).Decode(&transcript); err != nil {
		t.Fatalf("decode transcript: %v", err)
	}
	if transcript.Agent != "claude" || transcript.SessionID != "session-1" ||
		len(transcript.Entries) != 1 || transcript.Entries[0].Content != "First" {
		t.Fatalf("transcript = %#v", transcript)
	}

	unchanged := performAgentLogRequest(t, srv, terminal.ID, etag)
	if unchanged.Code != http.StatusNotModified || unchanged.Body.Len() != 0 {
		t.Fatalf("conditional GET = %d, %q, want 304 empty", unchanged.Code, unchanged.Body.String())
	}

	file, err := os.OpenFile(transcriptPath, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatalf("OpenFile() error = %v", err)
	}
	_, writeErr := file.WriteString(`{"type":"assistant","timestamp":"2026-07-30T01:02:04Z","message":{"role":"assistant","content":[{"type":"text","text":"Second"}]}}` + "\n")
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		t.Fatalf("append transcript errors = %v, %v", writeErr, closeErr)
	}
	changed := performAgentLogRequest(t, srv, terminal.ID, etag)
	if changed.Code != http.StatusOK || changed.Header().Get("ETag") == etag {
		t.Fatalf("changed GET = %d, ETag %q, old %q", changed.Code, changed.Header().Get("ETag"), etag)
	}
	if err := json.NewDecoder(changed.Body).Decode(&transcript); err != nil {
		t.Fatalf("decode changed transcript: %v", err)
	}
	if len(transcript.Entries) != 2 || transcript.Entries[1].Content != "Second" {
		t.Fatalf("changed transcript = %#v", transcript)
	}
}

func TestAgentLogEndpointRejectsMissingTerminalOrLinkage(t *testing.T) {
	srv, err := New(Config{
		Token: "token", Shell: "/bin/sh",
		ClaudeProjectsRoot: t.TempDir(), CodexSessionsRoot: t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	missing := performAgentLogRequest(t, srv, "missing", "")
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing terminal status = %d, want 404", missing.Code)
	}
	terminal, err := srv.sessions.Create(t.Context(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	unlinked := performAgentLogRequest(t, srv, terminal.ID, "")
	if unlinked.Code != http.StatusNotFound {
		t.Fatalf("unlinked terminal status = %d, want 404", unlinked.Code)
	}
}

func TestAgentLogEndpointSerializesEmptyEntriesAsAnArray(t *testing.T) {
	claudeRoot := filepath.Join(t.TempDir(), "claude-projects")
	transcriptPath := filepath.Join(claudeRoot, "repo", "session-1.jsonl")
	if err := os.MkdirAll(filepath.Dir(transcriptPath), 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(transcriptPath, nil, 0o600); err != nil {
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
	terminal, err := srv.sessions.Create(t.Context(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	_, err = srv.sessions.UpdateAgent(terminal.ID, session.AgentUpdate{
		Agent: "claude", AgentSessionID: "session-1", TranscriptPath: transcriptPath,
	})
	if err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}

	response := performAgentLogRequest(t, srv, terminal.ID, "")
	if response.Code != http.StatusOK {
		t.Fatalf("GET agent log status = %d, body = %s", response.Code, response.Body.String())
	}
	var payload struct {
		Entries json.RawMessage `json:"entries"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode transcript: %v", err)
	}
	if string(payload.Entries) != "[]" {
		t.Fatalf("entries = %s, want []", payload.Entries)
	}
}

func TestAgentLogETagChangesWhenLinkedAgentSessionChanges(t *testing.T) {
	claudeRoot := filepath.Join(t.TempDir(), "claude-projects")
	content := []byte(`{"type":"assistant","message":{"role":"assistant","content":"Same size"}}` + "\n")
	firstPath := filepath.Join(claudeRoot, "repo", "session-1.jsonl")
	secondPath := filepath.Join(claudeRoot, "repo", "session-2.jsonl")
	for _, path := range []string{firstPath, secondPath} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("MkdirAll() error = %v", err)
		}
		if err := os.WriteFile(path, content, 0o600); err != nil {
			t.Fatalf("WriteFile() error = %v", err)
		}
		stamp := time.Date(2026, 7, 30, 1, 2, 3, 0, time.UTC)
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatalf("Chtimes() error = %v", err)
		}
	}
	srv, err := New(Config{
		Token: "token", Shell: "/bin/sh", ClaudeProjectsRoot: claudeRoot,
		CodexSessionsRoot: t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	terminal, err := srv.sessions.Create(t.Context(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	_, _ = srv.sessions.UpdateAgent(terminal.ID, session.AgentUpdate{
		Agent: "claude", AgentSessionID: "session-1", TranscriptPath: firstPath,
	})
	first := performAgentLogRequest(t, srv, terminal.ID, "")
	etag := first.Header().Get("ETag")

	_, _ = srv.sessions.UpdateAgent(terminal.ID, session.AgentUpdate{
		Agent: "claude", AgentSessionID: "session-2", TranscriptPath: secondPath,
	})
	second := performAgentLogRequest(t, srv, terminal.ID, etag)
	if second.Code != http.StatusOK || second.Header().Get("ETag") == etag {
		t.Fatalf("second session GET = %d, ETag %q, old %q", second.Code, second.Header().Get("ETag"), etag)
	}
	var transcript agentlog.Transcript
	if err := json.NewDecoder(second.Body).Decode(&transcript); err != nil {
		t.Fatalf("decode transcript: %v", err)
	}
	if transcript.SessionID != "session-2" {
		t.Fatalf("SessionID = %q, want session-2", transcript.SessionID)
	}
}

func performAgentLogRequest(t *testing.T, srv *Server, terminalID, etag string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/sessions/"+terminalID+"/agent-log", nil)
	request.Header.Set("Authorization", "Bearer token")
	if etag != "" {
		request.Header.Set("If-None-Match", etag)
	}
	response := httptest.NewRecorder()
	srv.Handler().ServeHTTP(response, request)
	return response
}
