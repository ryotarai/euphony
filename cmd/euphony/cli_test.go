package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
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
