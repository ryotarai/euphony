package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
