package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNewRequiresToken(t *testing.T) {
	t.Parallel()

	_, err := New(Config{})
	if err == nil {
		t.Fatal("New() error = nil, want an error for an empty token")
	}
}

func TestNewAllowsEmptyTokenInNoAuthMode(t *testing.T) {
	t.Parallel()

	srv, err := New(Config{AuthMode: AuthModeNone, Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	request := httptest.NewRequest(http.MethodGet, "/api/sessions", nil)
	response := httptest.NewRecorder()
	srv.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("GET /api/sessions status = %d, want %d", response.Code, http.StatusOK)
	}
}

func TestAuthConfigIsPublicInBothModes(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		mode  AuthMode
		token string
		want  string
	}{
		{name: "token", token: "correct-token", want: string(AuthModeToken)},
		{name: "none", mode: AuthModeNone, want: string(AuthModeNone)},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			srv, err := New(Config{AuthMode: test.mode, Token: test.token, Shell: "/bin/sh"})
			if err != nil {
				t.Fatalf("New() error = %v", err)
			}
			t.Cleanup(func() { _ = srv.Close(t.Context()) })

			request := httptest.NewRequest(http.MethodGet, "/api/auth/config", nil)
			response := httptest.NewRecorder()
			srv.Handler().ServeHTTP(response, request)

			if response.Code != http.StatusOK {
				t.Fatalf("GET /api/auth/config status = %d, want %d", response.Code, http.StatusOK)
			}
			var body struct {
				Mode string `json:"mode"`
			}
			if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
				t.Fatalf("decode auth config: %v", err)
			}
			if body.Mode != test.want {
				t.Fatalf("auth config mode = %q, want %q", body.Mode, test.want)
			}
		})
	}
}

func TestNewRejectsUnknownAuthMode(t *testing.T) {
	t.Parallel()

	_, err := New(Config{AuthMode: AuthMode("invalid"), Token: "correct-token"})
	if err == nil {
		t.Fatal("New() error = nil, want invalid auth mode error")
	}
}

func TestHealthIsPublic(t *testing.T) {
	t.Parallel()

	srv, err := New(Config{Token: "correct-token"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	response := httptest.NewRecorder()
	srv.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("GET /api/health status = %d, want %d", response.Code, http.StatusOK)
	}
}

func TestAuthentication(t *testing.T) {
	t.Parallel()

	srv, err := New(Config{Token: "correct-token"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	tests := []struct {
		name          string
		authorization string
		wantStatus    int
	}{
		{name: "missing", wantStatus: http.StatusUnauthorized},
		{name: "incorrect", authorization: "Bearer wrong-token", wantStatus: http.StatusUnauthorized},
		{name: "correct", authorization: "Bearer correct-token", wantStatus: http.StatusOK},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/sessions", nil)
			request.Header.Set("Authorization", test.authorization)
			response := httptest.NewRecorder()
			srv.Handler().ServeHTTP(response, request)

			if response.Code != test.wantStatus {
				t.Fatalf("GET /api/sessions status = %d, want %d", response.Code, test.wantStatus)
			}
		})
	}
}

func TestRemovedAutomationRoutesUseTheBrowserAPIError(t *testing.T) {
	t.Parallel()

	srv, err := New(Config{Token: "correct-token"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/removed-automation", nil)
	request.Header.Set("Authorization", "Bearer correct-token")
	response := httptest.NewRecorder()
	srv.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusNotFound {
		t.Fatalf("GET removed automation route status = %d, want %d", response.Code, http.StatusNotFound)
	}
	var body errorResponse
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode removed automation route response: %v", err)
	}
	if body.Code != "api_not_found" {
		t.Fatalf("removed automation route error code = %q, want api_not_found", body.Code)
	}
}
