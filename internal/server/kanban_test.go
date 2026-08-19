package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"path/filepath"
	"testing"
	"time"

	"github.com/ryotarai/euphony/internal/session"
)

func TestKanbanListsOpenNonArchivedAgentSessionsAndArchivesByIdentity(t *testing.T) {
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

	created := performRequest(t, srv, http.MethodPost, "/api/sessions", `{"name":"Kanban terminal"}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("POST /api/sessions status = %d, body = %s", created.Code, created.Body.String())
	}
	var terminal struct {
		ID string `json:"id"`
	}
	decodeResponse(t, created, &terminal)
	sessionID := "kanban-session-1"
	hook := performRequest(t, srv, http.MethodPost, "/api/hooks/terminal",
		`{"terminalId":`+jsonString(terminal.ID)+`,"agent":"codex","agentSessionId":`+
			jsonString(sessionID)+`,"status":"waiting","title":"Kanban rollout"}`)
	if hook.Code != http.StatusOK {
		t.Fatalf("POST /api/hooks/terminal status = %d, body = %s", hook.Code, hook.Body.String())
	}

	list := performRequest(t, srv, http.MethodGet, "/api/kanban/sessions", "")
	if list.Code != http.StatusOK {
		t.Fatalf("GET /api/kanban/sessions status = %d, body = %s", list.Code, list.Body.String())
	}
	var sessions []struct {
		TerminalID string `json:"terminalId"`
		SessionID  string `json:"sessionId"`
		Status     string `json:"status"`
		Archived   bool   `json:"archived"`
	}
	decodeResponse(t, list, &sessions)
	if len(sessions) != 1 || sessions[0].TerminalID != terminal.ID ||
		sessions[0].SessionID != sessionID || sessions[0].Status != "waiting" || sessions[0].Archived {
		t.Fatalf("Kanban sessions = %#v, want one open waiting session", sessions)
	}

	identityPath := "/api/kanban/sessions/" + url.PathEscape(terminal.ID) + "/" + url.PathEscape(sessionID)
	archived := performRequest(t, srv, http.MethodPatch, identityPath, `{"archived":true}`)
	if archived.Code != http.StatusOK {
		t.Fatalf("PATCH archive status = %d, body = %s", archived.Code, archived.Body.String())
	}
	var archivedSession struct {
		Archived bool   `json:"archived"`
		Status   string `json:"status"`
	}
	decodeResponse(t, archived, &archivedSession)
	if !archivedSession.Archived || archivedSession.Status != "waiting" {
		t.Fatalf("archive response = %#v, want archived waiting session", archivedSession)
	}
	legacyList := performRequest(t, srv, http.MethodGet, "/api/sessions", "")
	if legacyList.Code != http.StatusOK {
		t.Fatalf("GET /api/sessions after archive status = %d, body = %s", legacyList.Code, legacyList.Body.String())
	}
	var legacySessions []session.Metadata
	decodeResponse(t, legacyList, &legacySessions)
	if len(legacySessions) != 0 {
		t.Fatalf("legacy session list after archive = %#v, want archived session excluded", legacySessions)
	}
	allSessions := performRequest(t, srv, http.MethodGet, "/api/all-sessions", "")
	if allSessions.Code != http.StatusOK {
		t.Fatalf("GET /api/all-sessions after archive status = %d, body = %s", allSessions.Code, allSessions.Body.String())
	}
	var indexed []allSession
	decodeResponse(t, allSessions, &indexed)
	if len(indexed) != 1 || !indexed[0].Archived || indexed[0].State != allSessionOpen ||
		indexed[0].TerminalID != terminal.ID || indexed[0].SessionID != sessionID {
		t.Fatalf("all sessions after archive = %#v, want archived open record", indexed)
	}

	list = performRequest(t, srv, http.MethodGet, "/api/kanban/sessions", "")
	decodeResponse(t, list, &sessions)
	if len(sessions) != 0 {
		t.Fatalf("Kanban sessions after archive = %#v, want empty", sessions)
	}
	archives := performRequest(t, srv, http.MethodGet, "/api/kanban/archives", "")
	if archives.Code != http.StatusOK {
		t.Fatalf("GET /api/kanban/archives status = %d, body = %s", archives.Code, archives.Body.String())
	}
	decodeResponse(t, archives, &sessions)
	if len(sessions) != 1 || !sessions[0].Archived || sessions[0].Status != "waiting" {
		t.Fatalf("Kanban archives = %#v, want archived waiting session", sessions)
	}

	unarchived := performRequest(t, srv, http.MethodPatch, identityPath, `{"archived":false}`)
	if unarchived.Code != http.StatusOK {
		t.Fatalf("PATCH unarchive status = %d, body = %s", unarchived.Code, unarchived.Body.String())
	}
	list = performRequest(t, srv, http.MethodGet, "/api/kanban/sessions", "")
	decodeResponse(t, list, &sessions)
	if len(sessions) != 1 || sessions[0].Archived || sessions[0].Status != "waiting" {
		t.Fatalf("Kanban sessions after unarchive = %#v, want one waiting session", sessions)
	}
}

func TestKanbanArchivesIncludeExitedArchivedAgentSessions(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "euphony.sqlite3")
	store, err := session.OpenSQLiteStore(databasePath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	createdAt := time.Now().UTC().Add(-time.Minute)
	if err := store.Save(context.Background(), session.Metadata{
		ID: "terminal-exited", Name: "Archived history", State: session.StateExited,
		CWD: t.TempDir(), Agent: "claude", ResumeAgent: "claude",
		AgentSessionID: "archived-history", AgentStatus: "waiting", Archived: true,
		CreatedAt: createdAt, UpdatedAt: createdAt,
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	srv, err := New(Config{
		Token:        "token",
		Shell:        "/bin/sh",
		DatabasePath: databasePath,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	archives := performRequest(t, srv, http.MethodGet, "/api/kanban/archives", "")
	if archives.Code != http.StatusOK {
		t.Fatalf("GET /api/kanban/archives status = %d, body = %s", archives.Code, archives.Body.String())
	}
	var items []struct {
		SessionID string `json:"sessionId"`
		Status    string `json:"status"`
		State     string `json:"state"`
		Archived  bool   `json:"archived"`
	}
	decodeResponse(t, archives, &items)
	if len(items) != 1 || items[0].SessionID != "archived-history" ||
		items[0].Status != "waiting" || items[0].State != "resume" || !items[0].Archived {
		t.Fatalf("Kanban exited archives = %#v, want one archived resumable record", items)
	}
}

func jsonString(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
