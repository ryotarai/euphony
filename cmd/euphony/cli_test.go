package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/ryotarai/euphony/internal/annotation"
	"github.com/ryotarai/euphony/internal/apiclient"
	"github.com/ryotarai/euphony/internal/server"
)

func TestAutomationCLIPrintsStableSuccessJSON(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/terminals" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		_, _ = io.WriteString(w, `{"ok":true,"result":{"terminals":[]}}`)
	}))
	t.Cleanup(api.Close)
	t.Setenv("EUPHONY_URL", api.URL)
	t.Setenv("EUPHONY_SOCKET", t.TempDir()+"/missing.sock")
	var stdout, stderr bytes.Buffer

	err := run([]string{"terminal", "list"}, bytes.NewReader(nil), &stdout, &stderr)
	if err != nil {
		t.Fatalf("run() error = %v, stderr = %s", err, stderr.String())
	}
	const want = "{\"ok\":true,\"result\":{\"terminals\":[]}}\n"
	if stdout.String() != want || stderr.Len() != 0 {
		t.Fatalf("stdout = %q, stderr = %q", stdout.String(), stderr.String())
	}
}

func TestAnnotateCLIWaitsForCommentsAndPrintsStableJSON(t *testing.T) {
	documentPath := filepath.Join(t.TempDir(), "review.md")
	if err := os.WriteFile(documentPath, []byte("# Review\n\nSelect this."), 0o644); err != nil {
		t.Fatal(err)
	}
	var createBody map[string]any
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/annotations":
			if err := json.NewDecoder(r.Body).Decode(&createBody); err != nil {
				t.Fatalf("decode create request: %v", err)
			}
			w.WriteHeader(http.StatusCreated)
			_, _ = io.WriteString(w, `{"ok":true,"result":{"annotation":{"id":"annotation-1","terminalId":"terminal-1","filename":"review.md","format":"markdown","content":"# Review\n\nSelect this.","createdAt":"2026-07-30T00:00:00Z"}}}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/annotations/annotation-1/wait":
			_, _ = io.WriteString(w, `{"ok":true,"result":{"annotationId":"annotation-1","comments":[{"kind":"selection","body":"Be specific.","quote":"Select this.","startOffset":8,"endOffset":20},{"kind":"global","body":"Approved otherwise."}]}}`)
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	t.Cleanup(api.Close)
	t.Setenv("EUPHONY_URL", api.URL)
	t.Setenv("EUPHONY_TERMINAL_ID", "terminal-1")
	var stdout, stderr bytes.Buffer

	err := run([]string{"annotate", documentPath}, bytes.NewReader(nil), &stdout, &stderr)
	if err != nil {
		t.Fatalf("run() error = %v, stderr = %s", err, stderr.String())
	}
	if createBody["terminalId"] != "terminal-1" ||
		createBody["filename"] != "review.md" ||
		createBody["format"] != "markdown" ||
		createBody["content"] != "# Review\n\nSelect this." {
		t.Fatalf("create request = %#v", createBody)
	}
	var envelope struct {
		OK     bool `json:"ok"`
		Result struct {
			AnnotationID string `json:"annotationId"`
			Path         string `json:"path"`
			Comments     []struct {
				Kind string `json:"kind"`
				Body string `json:"body"`
			} `json:"comments"`
		} `json:"result"`
	}
	if err := json.NewDecoder(&stdout).Decode(&envelope); err != nil {
		t.Fatalf("decode stdout: %v; output = %s", err, stdout.String())
	}
	if !envelope.OK || envelope.Result.AnnotationID != "annotation-1" ||
		envelope.Result.Path != documentPath || len(envelope.Result.Comments) != 2 ||
		envelope.Result.Comments[0].Kind != "selection" ||
		stderr.Len() != 0 {
		t.Fatalf("stdout = %#v, stderr = %q", envelope, stderr.String())
	}
}

func TestAnnotateCLIAcceptsOneMiBThroughTheRealServer(t *testing.T) {
	apiServer, err := server.New(server.Config{Token: "secret", Shell: "/bin/sh"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = apiServer.Close(t.Context()) })
	httpServer := httptest.NewServer(apiServer.Handler())
	t.Cleanup(httpServer.Close)
	client, err := apiclient.New(apiclient.Config{
		BaseURL: httpServer.URL,
		Token:   "secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	created, err := client.CreateTerminal(t.Context(), apiclient.CreateTerminalRequest{
		Name: "Boundary",
		CWD:  t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	documentPath := filepath.Join(t.TempDir(), "boundary.md")
	if err := os.WriteFile(
		documentPath,
		bytes.Repeat([]byte("a"), 1024*1024),
		0o644,
	); err != nil {
		t.Fatal(err)
	}
	t.Setenv("EUPHONY_URL", httpServer.URL)
	t.Setenv("EUPHONY_TOKEN", "secret")
	t.Setenv("EUPHONY_SOCKET", t.TempDir()+"/missing.sock")
	t.Setenv("EUPHONY_TERMINAL_ID", created.Terminal.ID)
	var stdout, stderr bytes.Buffer
	finished := make(chan error, 1)
	go func() {
		finished <- run(
			[]string{"annotate", documentPath},
			bytes.NewReader(nil),
			&stdout,
			&stderr,
		)
	}()
	var current *annotation.Session
	deadline := time.Now().Add(3 * time.Second)
	for current == nil && time.Now().Before(deadline) {
		current, err = client.CurrentAnnotation(t.Context(), created.Terminal.ID)
		if err != nil {
			t.Fatal(err)
		}
		if current == nil {
			time.Sleep(10 * time.Millisecond)
		}
	}
	if current == nil {
		t.Fatal("one MiB annotation was not created")
	}
	if _, err := client.CompleteAnnotation(t.Context(), current.ID, nil); err != nil {
		t.Fatal(err)
	}
	if err := <-finished; err != nil {
		t.Fatalf("run() error = %v, stderr = %s", err, stderr.String())
	}
	if !bytes.Contains(stdout.Bytes(), []byte(`"comments":[]`)) {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestAnnotateCLIValidatesInputBeforeCallingAPI(t *testing.T) {
	apiCalls := 0
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		apiCalls++
		t.Fatalf("unexpected API request: %s %s", r.Method, r.URL.Path)
	}))
	t.Cleanup(api.Close)
	t.Setenv("EUPHONY_URL", api.URL)
	temp := t.TempDir()
	textPath := filepath.Join(temp, "review.txt")
	invalidPath := filepath.Join(temp, "invalid.md")
	largePath := filepath.Join(temp, "large.html")
	if err := os.WriteFile(textPath, []byte("Review"), 0o644); err != nil {
		t.Fatal(err)
	}
	invalid := []byte{0xff, 0xfe}
	if utf8.Valid(invalid) {
		t.Fatal("invalid UTF-8 fixture is valid")
	}
	if err := os.WriteFile(invalidPath, invalid, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(largePath, bytes.Repeat([]byte("x"), 1024*1024+1), 0o644); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name       string
		args       []string
		terminalID string
	}{
		{name: "missing path", args: []string{"annotate"}, terminalID: "terminal-1"},
		{name: "missing terminal", args: []string{"annotate", textPath}},
		{name: "unsupported extension", args: []string{"annotate", textPath}, terminalID: "terminal-1"},
		{name: "invalid utf8", args: []string{"annotate", invalidPath}, terminalID: "terminal-1"},
		{name: "too large", args: []string{"annotate", largePath}, terminalID: "terminal-1"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("EUPHONY_TERMINAL_ID", test.terminalID)
			var stdout, stderr bytes.Buffer
			err := run(test.args, bytes.NewReader(nil), &stdout, &stderr)
			if err == nil || stdout.Len() != 0 || !strings.Contains(stderr.String(), `"ok":false`) {
				t.Fatalf("run() = %v, stdout = %q, stderr = %q", err, stdout.String(), stderr.String())
			}
		})
	}
	if apiCalls != 0 {
		t.Fatalf("API calls = %d, want 0", apiCalls)
	}
}

func TestAnnotateCLICancelsActiveReviewWhenWaitContextEnds(t *testing.T) {
	documentPath := filepath.Join(t.TempDir(), "review.html")
	if err := os.WriteFile(documentPath, []byte("<p>Review</p>"), 0o644); err != nil {
		t.Fatal(err)
	}
	waiting := make(chan struct{}, 1)
	canceled := make(chan struct{}, 1)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/annotations":
			w.WriteHeader(http.StatusCreated)
			_, _ = io.WriteString(w, `{"ok":true,"result":{"annotation":{"id":"annotation-1","terminalId":"terminal-1","filename":"review.html","format":"html","content":"<p>Review</p>","createdAt":"2026-07-30T00:00:00Z"}}}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/annotations/annotation-1/wait":
			waiting <- struct{}{}
			<-r.Context().Done()
		case r.Method == http.MethodDelete && r.URL.Path == "/api/v1/annotations/annotation-1":
			canceled <- struct{}{}
			_, _ = io.WriteString(w, `{"ok":true,"result":{"id":"annotation-1"}}`)
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	t.Cleanup(api.Close)
	t.Setenv("EUPHONY_URL", api.URL)
	t.Setenv("EUPHONY_TERMINAL_ID", "terminal-1")
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		result <- runAutomationContext(
			ctx,
			[]string{"annotate", documentPath},
			bytes.NewReader(nil),
			io.Discard,
			io.Discard,
		)
	}()
	select {
	case <-waiting:
	case <-time.After(time.Second):
		t.Fatal("annotation wait did not start")
	}
	cancel()
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("annotation was not canceled")
	}
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("runAutomationContext() error = nil after cancellation")
		}
	case <-time.After(time.Second):
		t.Fatal("runAutomationContext() did not return")
	}
}

func TestAutomationCLIExplicitURLUsesEnvironmentToken(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer environment-token" {
			t.Fatalf("Authorization = %q", got)
		}
		_, _ = io.WriteString(w,
			`{"ok":true,"result":{"apiVersion":"v1","status":"ok"}}`)
	}))
	t.Cleanup(api.Close)
	t.Setenv("EUPHONY_TOKEN", "environment-token")
	var stdout, stderr bytes.Buffer

	err := run(
		[]string{"--url", api.URL, "status"},
		bytes.NewReader(nil),
		&stdout,
		&stderr,
	)
	if err != nil {
		t.Fatalf("run() error = %v, stderr = %s", err, stderr.String())
	}
	if !bytes.Contains(stdout.Bytes(), []byte(`"apiVersion":"v1"`)) {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestAutomationCLIWritesSchemaAtomically(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/schema" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		_, _ = io.WriteString(w, `{"openapi":"3.1.0"}`)
	}))
	t.Cleanup(api.Close)
	t.Setenv("EUPHONY_URL", api.URL)
	path := filepath.Join(t.TempDir(), "schema.json")
	var stdout, stderr bytes.Buffer

	err := run(
		[]string{"api", "schema", "--output", path},
		bytes.NewReader(nil),
		&stdout,
		&stderr,
	)
	if err != nil {
		t.Fatalf("run() error = %v, stderr = %s", err, stderr.String())
	}
	content, err := os.ReadFile(path)
	if err != nil || string(content) != `{"openapi":"3.1.0"}` {
		t.Fatalf("schema = %q, %v", content, err)
	}
	if !bytes.Contains(stdout.Bytes(), []byte(`"path":"`)) {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestAutomationCLISyntaxErrorIsJSONWithExitCodeTwo(t *testing.T) {
	var stdout, stderr bytes.Buffer
	err := run([]string{"terminal", "get"}, bytes.NewReader(nil), &stdout, &stderr)
	exit, ok := err.(*exitError)
	if !ok || exit.code != 2 {
		t.Fatalf("run() error = %#v, want exit code 2", err)
	}
	var envelope struct {
		OK    bool `json:"ok"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if decodeErr := json.NewDecoder(&stderr).Decode(&envelope); decodeErr != nil {
		t.Fatalf("decode stderr: %v", decodeErr)
	}
	if envelope.OK || envelope.Error.Code != "cli_usage" || stdout.Len() != 0 {
		t.Fatalf("stdout = %q, envelope = %#v", stdout.String(), envelope)
	}
}

func TestAutomationCLIPropagatesStableAPIError(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w,
			`{"ok":false,"error":{"code":"terminal_not_found","message":"missing"}}`)
	}))
	t.Cleanup(api.Close)
	t.Setenv("EUPHONY_URL", api.URL)
	t.Setenv("EUPHONY_SOCKET", t.TempDir()+"/missing.sock")
	var stdout, stderr bytes.Buffer

	err := run([]string{"terminal", "get", "missing"}, bytes.NewReader(nil), &stdout, &stderr)
	exit, ok := err.(*exitError)
	if !ok || exit.code != 1 {
		t.Fatalf("run() error = %#v, want exit code 1", err)
	}
	if !bytes.Contains(stderr.Bytes(), []byte(`"code":"terminal_not_found"`)) {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestAutomationCLIRoutesAgentAndSelectionCommands(t *testing.T) {
	type requestRecord struct {
		method string
		path   string
		body   map[string]any
	}
	records := make(chan requestRecord, 2)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		records <- requestRecord{method: r.Method, path: r.URL.Path, body: body}
		if r.URL.Path == "/api/v1/selection/actions" {
			_, _ = io.WriteString(w,
				`{"ok":true,"result":{"terminalIds":[],"manualTerminalIds":[],"pinnedTerminalIds":[],"filters":{"statuses":[],"cwds":[]},"revision":2}}`)
			return
		}
		_, _ = io.WriteString(w,
			`{"ok":true,"result":{"accepted":true,"agent":{"id":"terminal-1","name":"Agent","state":"running","cwd":"/repo","agent":"codex","agentStatus":"waiting","createdAt":"2026-07-30T00:00:00Z"}}}`)
	}))
	t.Cleanup(api.Close)
	t.Setenv("EUPHONY_URL", api.URL)
	var stdout, stderr bytes.Buffer

	if err := run(
		[]string{
			"agent", "prompt", "--wait", "--until", "waiting", "--timeout", "2000",
			"terminal-1", "Review this",
		},
		bytes.NewReader(nil),
		&stdout,
		&stderr,
	); err != nil {
		t.Fatalf("agent prompt run() error = %v, stderr = %s", err, stderr.String())
	}
	stdout.Reset()
	if err := run(
		[]string{"selection", "filter", "cwd", "add", "running=/repo with space"},
		bytes.NewReader(nil),
		&stdout,
		&stderr,
	); err != nil {
		t.Fatalf("selection filter run() error = %v, stderr = %s", err, stderr.String())
	}

	prompt := <-records
	if prompt.method != http.MethodPost ||
		prompt.path != "/api/v1/agents/terminal-1/prompt" ||
		prompt.body["prompt"] != "Review this" ||
		prompt.body["wait"] != true ||
		prompt.body["timeoutMs"] != float64(2000) {
		t.Fatalf("prompt request = %#v", prompt)
	}
	filter := <-records
	filters, ok := filter.body["cwdFilters"].([]any)
	if filter.path != "/api/v1/selection/actions" ||
		filter.body["type"] != "filter_cwd_add" ||
		!ok || len(filters) != 1 {
		t.Fatalf("selection filter request = %#v", filter)
	}
	cwd := filters[0].(map[string]any)
	if cwd["status"] != "running" || cwd["cwd"] != "/repo with space" {
		t.Fatalf("cwd filter = %#v", cwd)
	}
}

func TestAutomationCLIReplacesPinnedFilters(t *testing.T) {
	requests := make(chan map[string]any, 1)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		requests <- body
		_, _ = io.WriteString(w,
			`{"ok":true,"result":{"terminalIds":[],"manualTerminalIds":[],"pinnedTerminalIds":[],"filters":{"statuses":[],"cwds":[]},"pinnedFilters":{"statuses":["waiting"],"cwds":[]},"revision":2}}`)
	}))
	t.Cleanup(api.Close)
	t.Setenv("EUPHONY_URL", api.URL)
	t.Setenv("EUPHONY_SOCKET", t.TempDir()+"/missing.sock")
	var stdout, stderr bytes.Buffer
	input := `{
		"manualTerminalIds": [],
		"pinnedTerminalIds": [],
		"filters": {"statuses":["waiting"],"cwds":[]},
		"pinnedFilters": {"statuses":["waiting"],"cwds":[]}
	}`

	if err := run(
		[]string{"selection", "replace"},
		strings.NewReader(input),
		&stdout,
		&stderr,
	); err != nil {
		t.Fatalf("selection replace run() error = %v, stderr = %s", err, stderr.String())
	}
	request := <-requests
	pinned, ok := request["pinnedFilters"].(map[string]any)
	if !ok || !reflect.DeepEqual(pinned["statuses"], []any{"waiting"}) {
		t.Fatalf("pinnedFilters = %#v", request["pinnedFilters"])
	}
}
