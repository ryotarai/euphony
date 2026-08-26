package server

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ryotarai/euphony/internal/session"
	"golang.org/x/sys/unix"
)

func TestSessionAPI(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	created := performRequest(t, srv, http.MethodPost, "/api/sessions", `{"name":"Agent one"}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("POST /api/sessions status = %d, body = %s", created.Code, created.Body.String())
	}
	var metadata session.Metadata
	decodeResponse(t, created, &metadata)
	if metadata.ID == "" || metadata.Name != "Agent one" || metadata.State != session.StateRunning {
		t.Fatalf("created session = %#v", metadata)
	}

	listed := performRequest(t, srv, http.MethodGet, "/api/sessions", "")
	if listed.Code != http.StatusOK {
		t.Fatalf("GET /api/sessions status = %d", listed.Code)
	}
	var sessions []session.Metadata
	decodeResponse(t, listed, &sessions)
	if len(sessions) != 1 || sessions[0].ID != metadata.ID {
		t.Fatalf("session list = %#v", sessions)
	}

	deleted := performRequest(t, srv, http.MethodDelete, "/api/sessions/"+metadata.ID, "")
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("DELETE session status = %d", deleted.Code)
	}
	missing := performRequest(t, srv, http.MethodDelete, "/api/sessions/"+metadata.ID, "")
	if missing.Code != http.StatusNotFound {
		t.Fatalf("DELETE missing session status = %d, want 404", missing.Code)
	}
}

func TestArchiveSessionAPIStopsAgentAndKeepsItInAllSessions(t *testing.T) {
	srv, err := New(Config{
		Token:        "token",
		Shell:        "/bin/sh",
		DatabasePath: filepath.Join(t.TempDir(), "euphony.sqlite3"),
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	created := performRequest(t, srv, http.MethodPost, "/api/sessions", `{"name":"Archive me"}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("POST /api/sessions status = %d, body = %s", created.Code, created.Body.String())
	}
	var metadata session.Metadata
	decodeResponse(t, created, &metadata)
	hook := performRequest(t, srv, http.MethodPost, "/api/hooks/terminal",
		`{"terminalId":`+jsonString(metadata.ID)+`,"agent":"codex",`+
			`"agentSessionId":"archive-session","status":"waiting"}`)
	if hook.Code != http.StatusOK {
		t.Fatalf("POST /api/hooks/terminal status = %d, body = %s", hook.Code, hook.Body.String())
	}

	archiveResponse := performRequest(t, srv, http.MethodPost,
		"/api/sessions/"+metadata.ID+"/archive", "")
	if archiveResponse.Code != http.StatusOK {
		t.Fatalf("POST archive status = %d, body = %s", archiveResponse.Code, archiveResponse.Body.String())
	}
	var result struct {
		ID string `json:"id"`
	}
	decodeResponse(t, archiveResponse, &result)
	if result.ID != metadata.ID {
		t.Fatalf("archive response = %#v, want terminal ID %q", result, metadata.ID)
	}

	listed := performRequest(t, srv, http.MethodGet, "/api/sessions", "")
	if listed.Code != http.StatusOK {
		t.Fatalf("GET /api/sessions status = %d, body = %s", listed.Code, listed.Body.String())
	}
	var current []session.Metadata
	decodeResponse(t, listed, &current)
	if len(current) != 0 {
		t.Fatalf("current sessions = %#v, want archived agent hidden", current)
	}

	all := performRequest(t, srv, http.MethodGet, "/api/all-sessions", "")
	if all.Code != http.StatusOK {
		t.Fatalf("GET /api/all-sessions status = %d, body = %s", all.Code, all.Body.String())
	}
	var stored []allSession
	decodeResponse(t, all, &stored)
	if len(stored) != 1 || stored[0].ID != metadata.ID || !stored[0].Archived ||
		stored[0].State != allSessionResume || stored[0].SessionID != "archive-session" {
		t.Fatalf("all sessions = %#v, want one archived resumable agent", stored)
	}

	archivedList := performRequest(t, srv, http.MethodGet, "/api/sessions/archived", "")
	if archivedList.Code != http.StatusOK {
		t.Fatalf("GET /api/sessions/archived status = %d, body = %s", archivedList.Code, archivedList.Body.String())
	}
	var archivedItems []struct {
		session.Metadata
		AgentSessionID string `json:"agentSessionId"`
	}
	decodeResponse(t, archivedList, &archivedItems)
	if len(archivedItems) != 1 || archivedItems[0].ID != metadata.ID ||
		archivedItems[0].AgentSessionID != "archive-session" || !archivedItems[0].Archived {
		t.Fatalf("archived sessions = %#v, want one resumable archived agent", archivedItems)
	}
}

func TestArchivedSessionAPIExposesResumeAgentIdentity(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "euphony.sqlite3")
	store, err := session.OpenSQLiteStore(databasePath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	createdAt := time.Now().UTC().Add(-time.Minute)
	if err := store.Save(t.Context(), session.Metadata{
		ID: "archived-claude", Name: "Archived Claude", State: session.StateExited,
		Archived: true, CWD: t.TempDir(), ResumeAgent: "claude",
		AgentSessionID: "claude-session", CreatedAt: createdAt, UpdatedAt: createdAt,
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	srv, err := New(Config{Token: "token", Shell: "/bin/sh", DatabasePath: databasePath})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	response := performRequest(t, srv, http.MethodGet, "/api/sessions/archived", "")
	if response.Code != http.StatusOK {
		t.Fatalf("GET /api/sessions/archived status = %d, body = %s", response.Code, response.Body.String())
	}
	var archived []struct {
		session.Metadata
		AgentSessionID string `json:"agentSessionId"`
	}
	decodeResponse(t, response, &archived)
	if len(archived) != 1 || archived[0].Agent != "claude" ||
		archived[0].AgentSessionID != "claude-session" {
		t.Fatalf("archived sessions = %#v, want effective Claude identity", archived)
	}
}

func TestArchiveSessionAPIWaitsForAgentSessionIdentity(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	created := performRequest(t, srv, http.MethodPost, "/api/sessions", `{"name":"Agent starting"}`)
	var metadata session.Metadata
	decodeResponse(t, created, &metadata)
	hook := performRequest(t, srv, http.MethodPost, "/api/hooks/terminal",
		`{"terminalId":`+jsonString(metadata.ID)+`,"agent":"codex","status":"waiting"}`)
	if hook.Code != http.StatusOK {
		t.Fatalf("POST /api/hooks/terminal status = %d, body = %s", hook.Code, hook.Body.String())
	}

	response := performRequest(t, srv, http.MethodPost,
		"/api/sessions/"+metadata.ID+"/archive", "")
	if response.Code != http.StatusConflict {
		t.Fatalf("POST archive status = %d, body = %s, want 409", response.Code, response.Body.String())
	}
	current := srv.sessions.ListCurrent()
	if len(current) != 1 || current[0].ID != metadata.ID {
		t.Fatalf("current sessions after rejected archive = %#v, want live session", current)
	}
}

func TestListSessionsDoesNotWaitForMetadataRefresh(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	created := performRequest(t, srv, http.MethodPost, "/api/sessions", `{"name":"Terminal"}`)
	var terminal session.Metadata
	decodeResponse(t, created, &terminal)
	if _, err := srv.sessions.UpdateAgent(terminal.ID, session.AgentUpdate{
		Agent: "claude",
		CWD:   t.TempDir(),
	}); err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}

	directory := t.TempDir()
	entered := filepath.Join(directory, "entered")
	release := filepath.Join(directory, "release")
	count := filepath.Join(directory, "count")
	script := filepath.Join(directory, "ps")
	if err := unix.Mkfifo(entered, 0o600); err != nil {
		t.Fatalf("create metadata refresh signal: %v", err)
	}
	enteredReader, err := os.OpenFile(entered, os.O_RDWR, 0o600)
	if err != nil {
		t.Fatalf("open metadata refresh signal: %v", err)
	}
	t.Cleanup(func() { _ = enteredReader.Close() })
	enteredSignal := make(chan error, 1)
	go func() {
		var signal [1]byte
		_, readErr := enteredReader.Read(signal[:])
		enteredSignal <- readErr
	}()
	body := "#!/bin/sh\n" +
		"printf x >> \"$METADATA_REFRESH_COUNT\"\n" +
		"printf x > \"$METADATA_REFRESH_ENTERED\"\n" +
		"while [ ! -e \"$METADATA_REFRESH_RELEASE\" ]; do sleep 0.01; done\n" +
		"printf 'sleep 1\\n'\n"
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		t.Fatalf("write fake ps: %v", err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("METADATA_REFRESH_ENTERED", entered)
	t.Setenv("METADATA_REFRESH_RELEASE", release)
	t.Setenv("METADATA_REFRESH_COUNT", count)
	defer func() {
		_ = os.WriteFile(release, nil, 0o600)
	}()

	firstDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		firstDone <- performRequest(t, srv, http.MethodGet, "/api/sessions", "")
	}()
	var first *httptest.ResponseRecorder
	select {
	case first = <-firstDone:
	case <-time.After(250 * time.Millisecond):
		if err := os.WriteFile(release, nil, 0o600); err != nil {
			t.Fatalf("release blocked metadata refresh: %v", err)
		}
		<-firstDone
		t.Fatal("GET /api/sessions waited for metadata refresh")
	}
	if first.Code != http.StatusOK {
		t.Fatalf("first GET status = %d, body = %s", first.Code, first.Body.String())
	}
	var snapshot []session.Metadata
	decodeResponse(t, first, &snapshot)
	if len(snapshot) != 1 || snapshot[0].ProcessName != "sh" {
		t.Fatalf("first GET snapshot = %#v, want current process name", snapshot)
	}

	select {
	case err := <-enteredSignal:
		if err != nil {
			t.Fatalf("wait for metadata refresh signal: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("metadata refresh did not enter the foreground process command")
	}
	secondDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		secondDone <- performRequest(t, srv, http.MethodGet, "/api/sessions", "")
	}()
	select {
	case second := <-secondDone:
		if second.Code != http.StatusOK {
			t.Fatalf("second GET status = %d, body = %s", second.Code, second.Body.String())
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("overlapping GET /api/sessions waited for active refresh")
	}
	refreshCount, err := os.ReadFile(count)
	if err != nil {
		t.Fatalf("read metadata refresh count: %v", err)
	}
	if got := strings.Count(string(refreshCount), "x"); got != 1 {
		t.Fatalf("active metadata refreshes = %d, want single flight", got)
	}

	if err := os.WriteFile(release, nil, 0o600); err != nil {
		t.Fatalf("release metadata refresh: %v", err)
	}
	waitForServer(t, time.Second, func() bool {
		items := srv.sessions.ListCurrent()
		return len(items) == 1 && items[0].ProcessName == "sleep"
	})
}

func TestListSessionsDoesNotWaitForMetadataStore(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "euphony.sqlite3")
	srv, err := New(Config{
		Token:        "token",
		Shell:        "/bin/sh",
		DatabasePath: databasePath,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	created := performRequest(t, srv, http.MethodPost, "/api/sessions", `{"name":"Terminal"}`)
	var terminal session.Metadata
	decodeResponse(t, created, &terminal)
	transcript := filepath.Join(t.TempDir(), "rollout.jsonl")
	titleRecord := `{"type":"event_msg","payload":{"type":"thread_name_updated","thread_id":"session-1","thread_name":"Stored title"}}` + "\n"
	if err := os.WriteFile(transcript, []byte(titleRecord), 0o600); err != nil {
		t.Fatalf("write transcript: %v", err)
	}
	hook := performRequest(t, srv, http.MethodPost, "/api/hooks/terminal",
		`{"terminalId":`+strconv.Quote(terminal.ID)+
			`,"agent":"codex","agentSessionId":"session-1","agentTranscriptPath":`+
			strconv.Quote(transcript)+`,"status":"running"}`)
	if hook.Code != http.StatusOK {
		t.Fatalf("POST hook status = %d, body = %s", hook.Code, hook.Body.String())
	}

	lockDB, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatalf("open lock database: %v", err)
	}
	t.Cleanup(func() { _ = lockDB.Close() })
	connection, err := lockDB.Conn(t.Context())
	if err != nil {
		t.Fatalf("database Conn() error = %v", err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	if _, err := connection.ExecContext(t.Context(), "BEGIN IMMEDIATE"); err != nil {
		t.Fatalf("BEGIN IMMEDIATE error = %v", err)
	}
	released := false
	releaseStore := func() {
		if released {
			return
		}
		released = true
		_, _ = connection.ExecContext(t.Context(), "ROLLBACK")
	}
	defer releaseStore()

	first := performRequest(t, srv, http.MethodGet, "/api/sessions", "")
	if first.Code != http.StatusOK {
		t.Fatalf("first GET status = %d, body = %s", first.Code, first.Body.String())
	}
	waitForServer(t, time.Second, func() bool {
		current, ok := srv.sessions.Metadata(terminal.ID)
		return ok && current.AgentTitle == "Stored title"
	})
	time.Sleep(50 * time.Millisecond)

	secondDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		secondDone <- performRequest(t, srv, http.MethodGet, "/api/sessions", "")
	}()
	select {
	case second := <-secondDone:
		if second.Code != http.StatusOK {
			t.Fatalf("second GET status = %d, body = %s", second.Code, second.Body.String())
		}
		var snapshot []session.Metadata
		decodeResponse(t, second, &snapshot)
		if len(snapshot) != 1 || snapshot[0].AgentTitle != "Stored title" {
			t.Fatalf("second GET snapshot = %#v", snapshot)
		}
	case <-time.After(250 * time.Millisecond):
		releaseStore()
		<-secondDone
		t.Fatal("GET /api/sessions blocked while metadata Save() was active")
	}

	releaseStore()
	waitDone := make(chan struct{})
	go func() {
		_ = srv.sessions.List()
		close(waitDone)
	}()
	select {
	case <-waitDone:
	case <-time.After(2 * time.Second):
		t.Fatal("metadata refresh did not finish after SQLite lock release")
	}
}

func TestCreateSessionValidatesRequest(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	tests := []string{`{"name":" "}`, `{"name":`, `{"name":"valid","extra":true}`}
	for _, body := range tests {
		response := performRequest(t, srv, http.MethodPost, "/api/sessions", body)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("POST body %q status = %d, want 400", body, response.Code)
		}
	}
}

func waitForServer(t *testing.T, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition was not met before timeout")
}

func TestCreateSessionAcceptsWorkingDirectory(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	cwd := t.TempDir()

	response := performRequest(t, srv, http.MethodPost, "/api/sessions",
		`{"name":"Scoped","cwd":`+strconv.Quote(cwd)+`}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("POST status = %d, body = %s", response.Code, response.Body.String())
	}
	var metadata session.Metadata
	decodeResponse(t, response, &metadata)
	if metadata.CWD != cwd {
		t.Fatalf("CWD = %q, want %q", metadata.CWD, cwd)
	}

	invalid := performRequest(t, srv, http.MethodPost, "/api/sessions",
		`{"name":"Invalid","cwd":"/definitely/missing/euphony-directory"}`)
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid cwd status = %d, want 400", invalid.Code)
	}
}

func TestTerminalHookUpdatesSessionMetadata(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	created := performRequest(t, srv, http.MethodPost, "/api/sessions", `{"name":"Terminal"}`)
	var metadata session.Metadata
	decodeResponse(t, created, &metadata)

	hook := performRequest(t, srv, http.MethodPost, "/api/hooks/terminal",
		`{"terminalId":"`+metadata.ID+`","agent":"claude","agentSessionId":"agent-1","agentTranscriptPath":"/home/me/.claude/projects/repo/agent-1.jsonl","status":"waiting","title":"Review changes","cwd":"/repo"}`)
	if hook.Code != http.StatusOK {
		t.Fatalf("POST hook status = %d, body = %s", hook.Code, hook.Body.String())
	}

	listed := performRequest(t, srv, http.MethodGet, "/api/sessions", "")
	var sessions []session.Metadata
	decodeResponse(t, listed, &sessions)
	if len(sessions) != 1 || sessions[0].Agent != "claude" ||
		sessions[0].AgentStatus != "waiting" || sessions[0].AgentTitle != "Review changes" ||
		sessions[0].CWD != "/repo" {
		t.Fatalf("sessions after hook = %#v", sessions)
	}
	stored := srv.sessions.List()
	if len(stored) != 1 ||
		stored[0].AgentTranscriptPath != "/home/me/.claude/projects/repo/agent-1.jsonl" {
		t.Fatalf("stored sessions after hook = %#v", stored)
	}
}

func TestTerminalHookRejectsUnsupportedAgentAndStatus(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	created := performRequest(t, srv, http.MethodPost, "/api/sessions", `{"name":"Terminal"}`)
	var metadata session.Metadata
	decodeResponse(t, created, &metadata)

	for _, body := range []string{
		`{"terminalId":"` + metadata.ID + `","agent":"gemini","status":"running"}`,
		`{"terminalId":"` + metadata.ID + `","agent":"codex","status":"paused"}`,
	} {
		response := performRequest(t, srv, http.MethodPost, "/api/hooks/terminal", body)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("hook status = %d, body = %s", response.Code, response.Body.String())
		}
	}
}

func TestAcknowledgeAttention(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	created := performRequest(t, srv, http.MethodPost, "/api/sessions", `{"name":"Terminal"}`)
	var metadata session.Metadata
	decodeResponse(t, created, &metadata)
	performRequest(t, srv, http.MethodPost, "/api/hooks/terminal",
		`{"terminalId":"`+metadata.ID+`","agent":"claude","status":"running"}`)
	waiting := performRequest(t, srv, http.MethodPost, "/api/hooks/terminal",
		`{"terminalId":"`+metadata.ID+`","agent":"claude","status":"waiting"}`)
	var attention session.Metadata
	decodeResponse(t, waiting, &attention)
	if attention.AgentStatus != "waiting" || !attention.NeedsAttention {
		t.Fatalf("hook metadata = %#v, want waiting with attention", attention)
	}

	response := performRequest(t, srv, http.MethodPost,
		"/api/sessions/"+metadata.ID+"/acknowledge-attention", "")
	if response.Code != http.StatusOK {
		t.Fatalf("POST acknowledge attention status = %d, body = %s",
			response.Code, response.Body.String())
	}
	var acknowledged session.Metadata
	decodeResponse(t, response, &acknowledged)
	if acknowledged.AgentStatus != "waiting" {
		t.Fatalf("AgentStatus = %q, want waiting", acknowledged.AgentStatus)
	}
	if acknowledged.NeedsAttention {
		t.Fatal("NeedsAttention = true, want false")
	}
}

func performRequest(t *testing.T, srv *Server, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	request.Header.Set("Authorization", "Bearer token")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	srv.Handler().ServeHTTP(response, request)
	return response
}

func decodeResponse(t *testing.T, response *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.NewDecoder(response.Body).Decode(target); err != nil {
		t.Fatalf("decode response: %v; body = %q", err, response.Body.String())
	}
}

func jsonString(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func TestSessionListHealsStaleClaudeTitleFromTranscript(t *testing.T) {
	// `/rename` appends a custom-title entry to the transcript and fires no
	// hook, so the sidebar keeps whatever title was last reported until the list
	// re-reads the transcript.
	transcript := filepath.Join(t.TempDir(), "agent-1.jsonl")
	if err := os.WriteFile(transcript, []byte(
		`{"type":"ai-title","aiTitle":"Add relayed webhook support","sessionId":"agent-1"}`+"\n"+
			`{"type":"custom-title","customTitle":"deploy","sessionId":"agent-1"}`+"\n",
	), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	created := performRequest(t, srv, http.MethodPost, "/api/sessions", `{"name":"Terminal"}`)
	var metadata session.Metadata
	decodeResponse(t, created, &metadata)

	hook := performRequest(t, srv, http.MethodPost, "/api/hooks/terminal",
		`{"terminalId":"`+metadata.ID+`","agent":"claude","agentSessionId":"agent-1",`+
			`"agentTranscriptPath":`+strconv.Quote(transcript)+`,"status":"waiting",`+
			`"title":"Add relayed webhook support","cwd":"/repo"}`)
	if hook.Code != http.StatusOK {
		t.Fatalf("POST hook status = %d, body = %s", hook.Code, hook.Body.String())
	}

	// The list endpoint answers from the current snapshot and refreshes behind
	// the response, so the healed title lands on the next read.
	listed := performRequest(t, srv, http.MethodGet, "/api/sessions", "")
	if listed.Code != http.StatusOK {
		t.Fatalf("GET status = %d, body = %s", listed.Code, listed.Body.String())
	}
	waitForServer(t, time.Second, func() bool {
		current, ok := srv.sessions.Metadata(metadata.ID)
		return ok && current.AgentTitle == "deploy"
	})

	relisted := performRequest(t, srv, http.MethodGet, "/api/sessions", "")
	var sessions []session.Metadata
	decodeResponse(t, relisted, &sessions)
	if len(sessions) != 1 || sessions[0].AgentTitle != "deploy" {
		t.Fatalf("sessions = %#v, want the renamed Claude title", sessions)
	}
}
