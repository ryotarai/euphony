package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLocalHandlerAllowsProtectedAPIWithoutBearerToken(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	request := httptest.NewRequest(http.MethodGet, "/api/v1/selection", nil)
	response := httptest.NewRecorder()
	srv.LocalHandler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("local request = %d, %s", response.Code, response.Body.String())
	}

	remote := httptest.NewRecorder()
	srv.Handler().ServeHTTP(remote, request)
	if remote.Code != http.StatusUnauthorized {
		t.Fatalf("remote request = %d, want 401", remote.Code)
	}
}
