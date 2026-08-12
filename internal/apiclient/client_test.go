package apiclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ryotarai/euphony/internal/annotation"
	"github.com/ryotarai/euphony/internal/localapi"
	"github.com/ryotarai/euphony/internal/project"
	"github.com/ryotarai/euphony/internal/server"
)

func TestClientListsAndCreatesProjects(t *testing.T) {
	directory := t.TempDir()
	created := project.Project{
		ID: "project-1", Path: directory, CreatedAt: time.Date(2026, 8, 12, 0, 0, 0, 0, time.UTC),
	}
	testServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/projects":
			var body struct {
				Path string `json:"path"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode project request: %v", err)
			}
			if body.Path != directory {
				t.Fatalf("project request = %#v, want %q", body, directory)
			}
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(created)
		case r.Method == http.MethodGet && r.URL.Path == "/api/projects":
			_ = json.NewEncoder(w).Encode([]project.Project{created})
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	t.Cleanup(testServer.Close)
	client, err := New(Config{BaseURL: testServer.URL})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	got, err := client.CreateProject(context.Background(), directory)
	if err != nil || got != created {
		t.Fatalf("CreateProject() = %#v, %v; want %#v", got, err, created)
	}
	projects, err := client.ListProjects(context.Background())
	if err != nil || len(projects) != 1 || projects[0] != created {
		t.Fatalf("ListProjects() = %#v, %v; want %#v", projects, err, []project.Project{created})
	}
}

func TestClientCreateTerminalSendsProjectID(t *testing.T) {
	testServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/terminals" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var request CreateTerminalRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode terminal request: %v", err)
		}
		if request.Name != "Project terminal" || request.ProjectID != "project-1" ||
			request.CWD != "" || request.SelectionMode != "none" || request.Command != "codex" {
			t.Fatalf("terminal request = %#v", request)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"result":{"terminal":{"id":"terminal-1","projectId":"project-1"},"selection":{}}}`))
	}))
	t.Cleanup(testServer.Close)
	client, err := New(Config{BaseURL: testServer.URL})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	result, err := client.CreateTerminal(context.Background(), CreateTerminalRequest{
		Name: "Project terminal", ProjectID: "project-1", SelectionMode: "none", Command: "codex",
	})
	if err != nil || result.Terminal.ID != "terminal-1" || result.Terminal.ProjectID != "project-1" {
		t.Fatalf("CreateTerminal() = %#v, %v", result, err)
	}
}

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

func TestClientRunsAnnotationLifecycle(t *testing.T) {
	var completed []annotation.Comment
	testServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/annotations":
			var request CreateAnnotationRequest
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Fatalf("decode create request: %v", err)
			}
			if request.TerminalID != "terminal-1" || request.Filename != "review.md" ||
				request.Format != annotation.FormatMarkdown || request.Content != "# Review" {
				t.Fatalf("create request = %#v", request)
			}
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"ok":true,"result":{"annotation":{"id":"annotation-1","terminalId":"terminal-1","filename":"review.md","format":"markdown","content":"# Review","createdAt":"2026-07-30T00:00:00Z"}}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/terminals/terminal-1/annotation":
			_, _ = w.Write([]byte(`{"ok":true,"result":{"annotation":{"id":"annotation-1","terminalId":"terminal-1","filename":"review.md","format":"markdown","content":"# Review","createdAt":"2026-07-30T00:00:00Z"}}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/annotations/annotation-1/complete":
			var request struct {
				Comments []annotation.Comment `json:"comments"`
			}
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Fatalf("decode complete request: %v", err)
			}
			completed = request.Comments
			_, _ = w.Write([]byte(`{"ok":true,"result":{"annotationId":"annotation-1","comments":[{"kind":"global","body":"Approved."}]}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/annotations/annotation-1/wait":
			_, _ = w.Write([]byte(`{"ok":true,"result":{"annotationId":"annotation-1","comments":[{"kind":"global","body":"Approved."}]}}`))
		case r.Method == http.MethodDelete && r.URL.Path == "/api/v1/annotations/annotation-1":
			_, _ = w.Write([]byte(`{"ok":true,"result":{"id":"annotation-1"}}`))
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	t.Cleanup(testServer.Close)
	client, err := New(Config{BaseURL: testServer.URL})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	created, err := client.CreateAnnotation(ctx, CreateAnnotationRequest{
		TerminalID: "terminal-1",
		Filename:   "review.md",
		Format:     annotation.FormatMarkdown,
		Content:    "# Review",
	})
	if err != nil || created.ID != "annotation-1" {
		t.Fatalf("CreateAnnotation() = %#v, %v", created, err)
	}
	current, err := client.CurrentAnnotation(ctx, "terminal-1")
	if err != nil || current == nil || current.ID != created.ID {
		t.Fatalf("CurrentAnnotation() = %#v, %v", current, err)
	}
	result, err := client.CompleteAnnotation(ctx, created.ID, []annotation.Comment{
		{Kind: annotation.CommentGlobal, Body: "Approved."},
	})
	if err != nil || result.AnnotationID != created.ID ||
		len(completed) != 1 || completed[0].Body != "Approved." {
		t.Fatalf("CompleteAnnotation() = %#v, %v; request = %#v", result, err, completed)
	}
	result, err = client.WaitAnnotation(ctx, created.ID)
	if err != nil || len(result.Comments) != 1 || result.Comments[0].Body != "Approved." {
		t.Fatalf("WaitAnnotation() = %#v, %v", result, err)
	}
	if err := client.CancelAnnotation(ctx, created.ID); err != nil {
		t.Fatalf("CancelAnnotation() error = %v", err)
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
	created, err := client.CreateTerminal(context.Background(), CreateTerminalRequest{
		Name: "Stream",
		CWD:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("CreateTerminal() error = %v", err)
	}
	streamContext, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	connection, err := client.TerminalStream(
		streamContext,
		created.Terminal.ID,
		"observe",
	)
	if err != nil {
		t.Fatalf("TerminalStream() error = %v", err)
	}
	defer connection.CloseNow()
	for {
		_, payload, err := connection.Read(streamContext)
		if err != nil {
			t.Fatalf("terminal stream Read() error = %v", err)
		}
		var frame TerminalFrame
		if err := json.Unmarshal(payload, &frame); err != nil {
			t.Fatalf("decode terminal frame: %v", err)
		}
		if frame.Type == "history_end" {
			break
		}
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
