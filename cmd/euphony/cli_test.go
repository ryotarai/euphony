package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
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
