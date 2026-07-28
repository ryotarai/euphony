package server

import (
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
