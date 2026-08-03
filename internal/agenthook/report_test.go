package agenthook

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReportTranslatesAgentHookInputToTerminalActivity(t *testing.T) {
	var authorization string
	var payload map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode payload: %v", err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	err := Report(context.Background(), Config{
		URL:        server.URL,
		Token:      "secret",
		TerminalID: "terminal-123",
		Agent:      "claude",
		Status:     "running",
	}, strings.NewReader(`{"cwd":"/repo","session_id":"agent-1","session_title":"Fix setup","transcript_path":"/home/me/.claude/projects/repo/agent-1.jsonl"}`))
	if err != nil {
		t.Fatalf("Report() error = %v", err)
	}
	if authorization != "Bearer secret" {
		t.Fatalf("Authorization = %q", authorization)
	}
	want := map[string]string{
		"terminalId":          "terminal-123",
		"agent":               "claude",
		"agentSessionId":      "agent-1",
		"agentTranscriptPath": "/home/me/.claude/projects/repo/agent-1.jsonl",
		"status":              "running",
		"title":               "Fix setup",
		"cwd":                 "/repo",
	}
	for key, value := range want {
		if payload[key] != value {
			t.Fatalf("payload[%q] = %q, want %q; payload = %#v", key, payload[key], value, payload)
		}
	}
}

func TestReportFallsBackToClaudeTranscriptTitle(t *testing.T) {
	transcript := filepath.Join(t.TempDir(), "session.jsonl")
	lines := []string{
		`{"type":"ai-title","aiTitle":"First guess","sessionId":"agent-1"}`,
		`{"type":"user","message":{"content":"` + strings.Repeat("x", 200_000) + `"}}`,
		`{"type":"ai-title","aiTitle":"Add relayed webhook support","sessionId":"agent-1"}`,
		`{"type":"assistant","message":{"content":"done"}}`,
	}
	if err := os.WriteFile(transcript, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatalf("write transcript: %v", err)
	}

	var payload map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&payload)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	input := `{"cwd":"/repo","session_id":"agent-1","transcript_path":` + quote(transcript) + `}`
	err := Report(context.Background(), Config{
		URL:        server.URL,
		Token:      "secret",
		TerminalID: "terminal-123",
		Agent:      "claude",
		Status:     "running",
	}, strings.NewReader(input))
	if err != nil {
		t.Fatalf("Report() error = %v", err)
	}
	if payload["title"] != "Add relayed webhook support" {
		t.Fatalf("payload[title] = %q, want latest transcript title; payload = %#v", payload["title"], payload)
	}
}

func TestReportPrefersHookInputTitleOverTranscript(t *testing.T) {
	transcript := filepath.Join(t.TempDir(), "session.jsonl")
	if err := os.WriteFile(transcript, []byte(`{"type":"ai-title","aiTitle":"Transcript title"}`+"\n"), 0o600); err != nil {
		t.Fatalf("write transcript: %v", err)
	}

	var payload map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&payload)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	input := `{"cwd":"/repo","session_title":"Hook title","transcript_path":` + quote(transcript) + `}`
	err := Report(context.Background(), Config{
		URL: server.URL, Token: "secret", TerminalID: "terminal-123",
		Agent: "claude", Status: "running",
	}, strings.NewReader(input))
	if err != nil {
		t.Fatalf("Report() error = %v", err)
	}
	if payload["title"] != "Hook title" {
		t.Fatalf("payload[title] = %q, want hook input title", payload["title"])
	}
}

func TestReportIgnoresUnreadableTranscript(t *testing.T) {
	var payload map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&payload)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	input := `{"cwd":"/repo","transcript_path":"/does/not/exist.jsonl"}`
	err := Report(context.Background(), Config{
		URL: server.URL, Token: "secret", TerminalID: "terminal-123",
		Agent: "claude", Status: "running",
	}, strings.NewReader(input))
	if err != nil {
		t.Fatalf("Report() error = %v", err)
	}
	if payload["title"] != "" {
		t.Fatalf("payload[title] = %q, want empty", payload["title"])
	}
}

func quote(value string) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

func TestReportIsNoopOutsideEuphonyTerminal(t *testing.T) {
	err := Report(context.Background(), Config{}, io.NopCloser(strings.NewReader("{}")))
	if err != nil {
		t.Fatalf("Report() error = %v, want nil", err)
	}
}

func TestReportClearsAgentWhenSessionEnds(t *testing.T) {
	var payload map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&payload)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	err := Report(context.Background(), Config{
		URL:        server.URL,
		Token:      "secret",
		TerminalID: "terminal-123",
		Agent:      "claude",
		Status:     "idle",
	}, strings.NewReader(`{"cwd":"/repo"}`))
	if err != nil {
		t.Fatalf("Report() error = %v", err)
	}
	if payload["agent"] != "" || payload["status"] != "" {
		t.Fatalf("session-end payload = %#v, want cleared agent and status", payload)
	}
	if payload["resumeAgent"] != "claude" {
		t.Fatalf("session-end payload = %#v, want resumable claude agent", payload)
	}
}

func TestReportPrefersRenamedClaudeSessionTitle(t *testing.T) {
	transcript := filepath.Join(t.TempDir(), "session.jsonl")
	lines := []string{
		`{"type":"ai-title","aiTitle":"Add relayed webhook support","sessionId":"agent-1"}`,
		`{"type":"custom-title","customTitle":"deploy","sessionId":"agent-1"}`,
		`{"type":"ai-title","aiTitle":"Add relayed webhook support","sessionId":"agent-1"}`,
	}
	if err := os.WriteFile(transcript, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatalf("write transcript: %v", err)
	}

	var payload map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&payload)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	input := `{"cwd":"/repo","session_id":"agent-1","transcript_path":` + quote(transcript) + `}`
	err := Report(context.Background(), Config{
		URL: server.URL, Token: "secret", TerminalID: "terminal-123",
		Agent: "claude", Status: "running",
	}, strings.NewReader(input))
	if err != nil {
		t.Fatalf("Report() error = %v", err)
	}
	if payload["title"] != "deploy" {
		t.Fatalf("payload[title] = %q, want the renamed session title", payload["title"])
	}
}
