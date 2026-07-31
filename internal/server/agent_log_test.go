package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ryotarai/euphony/internal/agentlog"
	"github.com/ryotarai/euphony/internal/session"
)

func TestAgentLogEndpointPagesNewestOlderAndAppendedRecords(t *testing.T) {
	claudeRoot := filepath.Join(t.TempDir(), "claude-projects")
	transcriptPath := filepath.Join(claudeRoot, "repo", "session-page.jsonl")
	if err := os.MkdirAll(filepath.Dir(transcriptPath), 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	var content string
	for index := 1; index <= 105; index++ {
		content += fmt.Sprintf(
			"{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":\"Message %03d\"}}\n",
			index,
		)
	}
	if err := os.WriteFile(transcriptPath, []byte(content), 0o600); err != nil {
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
	if _, err := srv.sessions.UpdateAgent(terminal.ID, session.AgentUpdate{
		Agent: "claude", AgentSessionID: "session-page", TranscriptPath: transcriptPath,
	}); err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}

	newest := performAgentLogRequestPath(t, srv, terminal.ID, "", "")
	if newest.Code != http.StatusOK {
		t.Fatalf("newest status = %d, body = %s", newest.Code, newest.Body.String())
	}
	var newestLog agentlog.Transcript
	if err := json.NewDecoder(newest.Body).Decode(&newestLog); err != nil {
		t.Fatalf("decode newest transcript: %v", err)
	}
	if len(newestLog.Entries) != 100 ||
		newestLog.Entries[0].Content != "Message 006" ||
		newestLog.Entries[99].Content != "Message 105" {
		t.Fatalf("newest entries = %#v", newestLog.Entries)
	}
	if newestLog.StartCursor == "" ||
		newestLog.EndCursor == "" ||
		newestLog.NextCursor != newestLog.StartCursor {
		t.Fatalf("newest cursors = %#v", newestLog)
	}

	older := performAgentLogRequestPath(
		t,
		srv,
		terminal.ID,
		"?before="+newestLog.NextCursor,
		"",
	)
	if older.Code != http.StatusOK {
		t.Fatalf("older status = %d, body = %s", older.Code, older.Body.String())
	}
	var olderLog agentlog.Transcript
	if err := json.NewDecoder(older.Body).Decode(&olderLog); err != nil {
		t.Fatalf("decode older transcript: %v", err)
	}
	if len(olderLog.Entries) != 5 ||
		olderLog.Entries[0].Content != "Message 001" ||
		olderLog.Entries[4].Content != "Message 005" ||
		olderLog.NextCursor != "" {
		t.Fatalf("older transcript = %#v", olderLog)
	}

	var appended strings.Builder
	for index := 106; index <= 210; index++ {
		fmt.Fprintf(
			&appended,
			"{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":\"Message %03d\"}}\n",
			index,
		)
	}
	file, err := os.OpenFile(transcriptPath, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatalf("OpenFile() error = %v", err)
	}
	_, writeErr := file.WriteString(appended.String())
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		t.Fatalf("append errors = %v, %v", writeErr, closeErr)
	}
	addition := performAgentLogRequestPath(
		t,
		srv,
		terminal.ID,
		"?after="+newestLog.EndCursor,
		newest.Header().Get("ETag"),
	)
	if addition.Code != http.StatusOK {
		t.Fatalf("after status = %d, body = %s", addition.Code, addition.Body.String())
	}
	var additionLog agentlog.Transcript
	if err := json.NewDecoder(addition.Body).Decode(&additionLog); err != nil {
		t.Fatalf("decode appended transcript: %v", err)
	}
	if len(additionLog.Entries) != agentLogPageRecords ||
		additionLog.Entries[0].Content != "Message 106" ||
		additionLog.Entries[99].Content != "Message 205" ||
		additionLog.StartCursor != newestLog.EndCursor {
		t.Fatalf("first appended transcript = %#v", additionLog)
	}
	firstEnd, err := strconv.ParseInt(additionLog.EndCursor, 10, 64)
	if err != nil {
		t.Fatalf("parse first appended end cursor: %v", err)
	}
	if firstEnd >= int64(len(content)+appended.Len()) {
		t.Fatalf(
			"first appended end cursor = %d, want before %d",
			firstEnd,
			len(content)+appended.Len(),
		)
	}

	remainder := performAgentLogRequestPath(
		t,
		srv,
		terminal.ID,
		"?after="+additionLog.EndCursor,
		addition.Header().Get("ETag"),
	)
	if remainder.Code != http.StatusOK {
		t.Fatalf("remainder status = %d, body = %s", remainder.Code, remainder.Body.String())
	}
	var remainderLog agentlog.Transcript
	if err := json.NewDecoder(remainder.Body).Decode(&remainderLog); err != nil {
		t.Fatalf("decode appended remainder: %v", err)
	}
	if len(remainderLog.Entries) != 5 ||
		remainderLog.Entries[0].Content != "Message 206" ||
		remainderLog.Entries[4].Content != "Message 210" ||
		remainderLog.StartCursor != additionLog.EndCursor {
		t.Fatalf("appended remainder = %#v", remainderLog)
	}

	allAppended := append(
		append([]agentlog.Entry(nil), additionLog.Entries...),
		remainderLog.Entries...,
	)
	if len(allAppended) != 105 {
		t.Fatalf("combined appended records = %d, want 105", len(allAppended))
	}
	for index, entry := range allAppended {
		want := fmt.Sprintf("Message %03d", index+106)
		if entry.Content != want {
			t.Fatalf("combined appended record %d = %q, want %q", index, entry.Content, want)
		}
	}
}

func TestAgentLogEndpointRejectsInvalidCursors(t *testing.T) {
	srv, err := New(Config{
		Token: "token", Shell: "/bin/sh",
		ClaudeProjectsRoot: t.TempDir(), CodexSessionsRoot: t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	terminal, err := srv.sessions.Create(t.Context(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	for _, query := range []string{
		"?before=not-a-number",
		"?after=-1",
		"?before=1&after=2",
	} {
		response := performAgentLogRequestPath(t, srv, terminal.ID, query, "")
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, want 400", query, response.Code)
		}
		var body struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
			t.Fatalf("%s decode error = %v", query, err)
		}
		if body.Code != "invalid_agent_log_cursor" {
			t.Fatalf("%s code = %q", query, body.Code)
		}
	}
}

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
	return performAgentLogRequestPath(t, srv, terminalID, "", etag)
}

func performAgentLogRequestPath(
	t *testing.T,
	srv *Server,
	terminalID string,
	query string,
	etag string,
) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(
		http.MethodGet,
		"/api/sessions/"+terminalID+"/agent-log"+query,
		nil,
	)
	request.Header.Set("Authorization", "Bearer token")
	if etag != "" {
		request.Header.Set("If-None-Match", etag)
	}
	response := httptest.NewRecorder()
	srv.Handler().ServeHTTP(response, request)
	return response
}
