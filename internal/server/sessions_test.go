package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/ryotarai/euphony/internal/session"
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
		`{"terminalId":"`+metadata.ID+`","agent":"claude","status":"waiting","title":"Review changes","cwd":"/repo"}`)
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
