package apiclient

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/ryotarai/euphony/internal/localapi"
	"github.com/ryotarai/euphony/internal/server"
)

func TestClientSendsBearerTokenAndDecodesEnvelope(t *testing.T) {
	testServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret" {
			t.Fatalf("Authorization = %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"result":{"apiVersion":"v1","status":"ok"}}`))
	}))
	t.Cleanup(testServer.Close)
	client, err := New(Config{BaseURL: testServer.URL, Token: "secret"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	status, err := client.Status(context.Background())
	if err != nil || status.APIVersion != "v1" || status.Status != "ok" {
		t.Fatalf("Status() = %#v, %v", status, err)
	}
}

func TestClientUsesUnixSocketWithoutBearerToken(t *testing.T) {
	directory, err := os.MkdirTemp("/tmp", "euphony-client-")
	if err != nil {
		t.Fatalf("MkdirTemp() error = %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	socketPath := filepath.Join(directory, "api.sock")
	listener, cleanup, err := localapi.Listen(socketPath)
	if err != nil {
		t.Fatalf("Listen() error = %v", err)
	}
	t.Cleanup(func() { _ = cleanup() })
	apiServer, err := server.New(server.Config{Token: "remote-secret", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("server.New() error = %v", err)
	}
	t.Cleanup(func() { _ = apiServer.Close(t.Context()) })
	httpServer := &http.Server{Handler: apiServer.LocalHandler()}
	go func() { _ = httpServer.Serve(listener) }()
	t.Cleanup(func() { _ = httpServer.Shutdown(context.Background()) })

	client, err := New(Config{SocketPath: socketPath})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	status, err := client.Status(context.Background())
	if err != nil || status.Status != "ok" {
		t.Fatalf("Status() = %#v, %v", status, err)
	}
	selection, err := client.Selection(context.Background())
	if err != nil || selection.TerminalIDs == nil {
		t.Fatalf("Selection() = %#v, %v", selection, err)
	}
}

func TestClientReturnsStructuredAPIError(t *testing.T) {
	testServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(
			`{"ok":false,"error":{"code":"revision_conflict","message":"stale","details":{"current":3}}}`,
		))
	}))
	t.Cleanup(testServer.Close)
	client, err := New(Config{BaseURL: testServer.URL})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	_, err = client.Selection(context.Background())
	apiError, ok := err.(*APIError)
	if !ok || apiError.Code != "revision_conflict" || apiError.StatusCode != http.StatusConflict {
		t.Fatalf("Selection() error = %#v", err)
	}
}
