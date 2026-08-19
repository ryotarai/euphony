package server

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/ryotarai/euphony/internal/selection"
	"github.com/ryotarai/euphony/internal/session"
)

func TestAllSessionsListsPersistedAgentSessionsOnly(t *testing.T) {
	root := t.TempDir()
	databasePath := filepath.Join(root, "euphony.sqlite3")
	codexRoot := filepath.Join(root, "codex", "sessions")
	claudeRoot := filepath.Join(root, "claude", "projects")
	codexIndex := filepath.Join(root, "codex", "session_index.jsonl")
	codexTranscript := filepath.Join(codexRoot, "2026", "08", "13", "session-current.jsonl")
	claudeTranscript := filepath.Join(claudeRoot, "repo", "session-history-only.jsonl")
	writeAllSessionsFixture(t, codexIndex, strings.Join([]string{
		`{"id":"session-current","thread_name":"Current rollout","updated_at":"2026-08-13T09:00:00Z"}`,
	}, "\n"))
	writeAllSessionsFixture(t, codexTranscript, strings.Join([]string{
		`{"type":"session_meta","timestamp":"2026-08-13T08:55:00Z","payload":{"id":"session-current","cwd":"` + t.TempDir() + `"}}`,
		`{"type":"response_item","timestamp":"2026-08-13T08:56:00Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Build the session index"}]}}`,
	}, "\n"))
	writeAllSessionsFixture(t, claudeTranscript, strings.Join([]string{
		`{"type":"user","sessionId":"session-history-only","cwd":"/workspace/old","timestamp":"2026-08-12T08:00:00Z","message":{"role":"user","content":"Review the old session"}}`,
		`{"type":"assistant","sessionId":"session-history-only","timestamp":"2026-08-12T08:01:00Z","message":{"role":"assistant","content":"The old session is complete."}}`,
	}, "\n"))
	store, err := session.OpenSQLiteStore(databasePath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	closedAt := time.Now().UTC().Add(-time.Minute)
	if err := store.Save(t.Context(), session.Metadata{
		ID: "closed-agent", Name: "Closed DB agent", State: session.StateExited,
		CWD: t.TempDir(), Agent: "claude", ResumeAgent: "claude",
		AgentSessionID: "session-db-only", AgentTitle: "Closed DB agent",
		CreatedAt: closedAt.Add(-time.Hour), UpdatedAt: closedAt, ExitedAt: &closedAt,
	}); err != nil {
		t.Fatalf("Save(exited agent) error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	srv, err := New(Config{
		Token:              "token",
		Shell:              "/bin/sh",
		DatabasePath:       databasePath,
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
	if _, err := srv.sessions.Create(t.Context(), "Plain terminal", t.TempDir()); err != nil {
		t.Fatalf("Create(plain terminal) error = %v", err)
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
		t.Fatalf("all sessions = %#v, want current and closed DB agents", items)
	}
	var currentItem, closedItem *allSession
	for index := range items {
		switch items[index].SessionID {
		case "session-current":
			currentItem = &items[index]
		case "session-db-only":
			closedItem = &items[index]
		}
	}
	if currentItem == nil || currentItem.State != allSessionOpen ||
		currentItem.TerminalID != current.ID || currentItem.Agent != "codex" ||
		currentItem.Purpose != "Build the session index" ||
		currentItem.Summary != "The current terminal is waiting." {
		t.Fatalf("current all session = %#v", currentItem)
	}
	if closedItem == nil || closedItem.ID != "closed-agent" ||
		closedItem.Agent != "claude" || closedItem.State != allSessionResume ||
		closedItem.Title != "Closed DB agent" {
		t.Fatalf("closed DB all session = %#v", closedItem)
	}
	if !items[0].UpdatedAt.After(items[1].UpdatedAt) {
		t.Fatalf("all sessions are not newest first: %#v", items)
	}
}

func TestAllSessionsRequiresPersistedDatabase(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	current, err := srv.sessions.Create(t.Context(), "In-memory agent", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := srv.sessions.UpdateAgent(current.ID, session.AgentUpdate{
		Agent:          "codex",
		AgentSessionID: "session-in-memory-only",
	}); err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}

	response := performRequest(t, srv, http.MethodGet, "/api/all-sessions", "")
	if response.Code != http.StatusOK {
		t.Fatalf("GET /api/all-sessions status = %d, body = %s", response.Code, response.Body.String())
	}
	var items []allSession
	decodeResponse(t, response, &items)
	if len(items) != 0 {
		t.Fatalf("all sessions = %#v, want no non-persisted sessions", items)
	}
}

func TestAllSessionsResumeStartsPersistedCodexWithSeparateArgumentsAndSelection(t *testing.T) {
	root := t.TempDir()
	databasePath := filepath.Join(root, "euphony.sqlite3")
	cwd := t.TempDir()
	argsPath := filepath.Join(root, "codex-args.txt")
	store, err := session.OpenSQLiteStore(databasePath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	createdAt := time.Now().UTC().Add(-time.Minute)
	if err := store.Save(t.Context(), session.Metadata{
		ID: "persisted-resume", Name: "Resume rollout", State: session.StateExited,
		CWD: cwd, Agent: "codex", ResumeAgent: "codex", AgentSessionID: "session-resume",
		AgentTitle: "Resume rollout", CreatedAt: createdAt, UpdatedAt: createdAt,
	}); err != nil {
		t.Fatalf("Save(exited agent) error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
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
		Token:        "token",
		Shell:        "/bin/sh",
		DatabasePath: databasePath,
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

func TestAllSessionsResumeStartsUnknownCodexFromQueryCWDAndReusesIt(t *testing.T) {
	root := t.TempDir()
	databasePath := filepath.Join(root, "euphony.sqlite3")
	cwd := t.TempDir()
	argsPath := filepath.Join(root, "codex-args.txt")
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
		Token:        "token",
		Shell:        "/bin/sh",
		DatabasePath: databasePath,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	path := "/api/all-sessions/codex/query-codex-session/resume?cwd=" + url.QueryEscape(cwd)
	response := performRequest(t, srv, http.MethodPost, path, `{"selectionMode":"replace"}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("POST query-only Codex resume status = %d, body = %s", response.Code, response.Body.String())
	}
	var result struct {
		Terminal  session.Metadata   `json:"terminal"`
		Selection selection.Snapshot `json:"selection"`
	}
	decodeResponse(t, response, &result)
	if result.Terminal.ID == "" || result.Terminal.Agent != "codex" || result.Terminal.CWD != cwd ||
		result.Terminal.State != session.StateRunning {
		t.Fatalf("query-only Codex terminal = %#v", result.Terminal)
	}
	if !reflect.DeepEqual(result.Selection.TerminalIDs, []string{result.Terminal.ID}) ||
		result.Selection.FocusedTerminalID != result.Terminal.ID {
		t.Fatalf("query-only Codex selection = %#v", result.Selection)
	}
	persisted := srv.sessions.ListPersisted()
	if len(persisted) != 1 || persisted[0].Agent != "codex" ||
		persisted[0].ResumeAgent != "codex" || persisted[0].AgentSessionID != "query-codex-session" {
		t.Fatalf("query-only Codex persisted metadata = %#v", persisted)
	}

	repeated := performRequest(t, srv, http.MethodPost, path, `{"selectionMode":"replace"}`)
	if repeated.Code != http.StatusOK {
		t.Fatalf("repeated query-only Codex resume status = %d, body = %s", repeated.Code, repeated.Body.String())
	}
	var repeatedResult struct {
		Terminal session.Metadata `json:"terminal"`
	}
	decodeResponse(t, repeated, &repeatedResult)
	if repeatedResult.Terminal.ID != result.Terminal.ID {
		t.Fatalf("repeated query-only Codex terminal = %#v, want %q", repeatedResult.Terminal, result.Terminal.ID)
	}
	waitForServer(t, 3*time.Second, func() bool {
		data, err := os.ReadFile(argsPath)
		return err == nil && string(data) == "resume\nquery-codex-session\n"
	})
}

func TestAllSessionsResumeStartsUnknownClaudeFromQueryCWDWithSeparateArguments(t *testing.T) {
	root := t.TempDir()
	databasePath := filepath.Join(root, "euphony.sqlite3")
	cwd := t.TempDir()
	argsPath := filepath.Join(root, "claude-args.txt")
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("MkdirAll(bin) error = %v", err)
	}
	claudeCommand := filepath.Join(binDir, "claude")
	if err := os.WriteFile(claudeCommand, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \""+argsPath+"\"\nsleep 30\n"), 0o700); err != nil {
		t.Fatalf("WriteFile(claude) error = %v", err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	srv, err := New(Config{
		Token:        "token",
		Shell:        "/bin/sh",
		DatabasePath: databasePath,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	response := performRequest(t, srv, http.MethodPost,
		"/api/all-sessions/claude/query-claude-session/resume?cwd="+url.QueryEscape(cwd), "")
	if response.Code != http.StatusCreated {
		t.Fatalf("POST query-only Claude resume status = %d, body = %s", response.Code, response.Body.String())
	}
	var result struct {
		Terminal session.Metadata `json:"terminal"`
	}
	decodeResponse(t, response, &result)
	if result.Terminal.ID == "" || result.Terminal.Agent != "claude" || result.Terminal.CWD != cwd ||
		result.Terminal.State != session.StateRunning {
		t.Fatalf("query-only Claude terminal = %#v", result.Terminal)
	}
	waitForServer(t, 3*time.Second, func() bool {
		data, err := os.ReadFile(argsPath)
		return err == nil && string(data) == "--resume\nquery-claude-session\n"
	})
}

func TestAllSessionsResumeUnknownSessionRequiresQueryCWD(t *testing.T) {
	root := t.TempDir()
	srv, err := New(Config{
		Token:        "token",
		Shell:        "/bin/sh",
		DatabasePath: filepath.Join(root, "euphony.sqlite3"),
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	response := performRequest(t, srv, http.MethodPost,
		"/api/all-sessions/codex/missing-from-db/resume", "")
	if response.Code != http.StatusNotFound {
		t.Fatalf("POST resume without query cwd status = %d, body = %s", response.Code, response.Body.String())
	}
	if terminals := srv.sessions.List(); len(terminals) != 0 {
		t.Fatalf("terminals after rejected query-only resume = %#v", terminals)
	}
}

func TestAllSessionsResumeUnknownSessionRejectsMissingQueryCWD(t *testing.T) {
	root := t.TempDir()
	srv, err := New(Config{
		Token:        "token",
		Shell:        "/bin/sh",
		DatabasePath: filepath.Join(root, "euphony.sqlite3"),
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	missingCWD := filepath.Join(root, "does-not-exist")
	response := performRequest(t, srv, http.MethodPost,
		"/api/all-sessions/codex/missing-from-db/resume?cwd="+url.QueryEscape(missingCWD), "")
	if response.Code != http.StatusBadRequest {
		t.Fatalf("POST resume with missing query cwd status = %d, body = %s", response.Code, response.Body.String())
	}
	if terminals := srv.sessions.List(); len(terminals) != 0 {
		t.Fatalf("terminals after rejected query-only resume = %#v", terminals)
	}
}

func TestAllSessionsResumeReusesOpenMatchingAgentTerminal(t *testing.T) {
	root := t.TempDir()
	databasePath := filepath.Join(root, "euphony.sqlite3")
	codexRoot := filepath.Join(root, "codex", "sessions")
	transcript := filepath.Join(codexRoot, "session-open.jsonl")
	writeAllSessionsFixture(t, transcript, strings.Join([]string{
		`{"type":"session_meta","timestamp":"2026-08-13T08:00:00Z","payload":{"id":"session-open","cwd":"` + t.TempDir() + `"}}`,
		`{"type":"response_item","timestamp":"2026-08-13T08:01:00Z","payload":{"type":"message","role":"user","content":"Keep this terminal open"}}`,
	}, "\n"))

	srv, err := New(Config{
		Token:             "token",
		Shell:             "/bin/sh",
		DatabasePath:      databasePath,
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

func TestTruncateAllSessionNameRespectsManagerByteLimit(t *testing.T) {
	name := truncateAllSessionName(strings.Repeat("再", 100))
	if len(name) > 80 || !utf8.ValidString(name) {
		t.Fatalf("truncated name length/validity = %d/%t", len(name), utf8.ValidString(name))
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
