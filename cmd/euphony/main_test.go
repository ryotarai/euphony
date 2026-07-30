package main

import (
	"net/url"
	"path/filepath"
	"testing"
)

func TestResolveTokenGeneratesSecureTokenWhenUnset(t *testing.T) {
	token, generated, err := resolveToken("")
	if err != nil {
		t.Fatalf("resolveToken() error = %v", err)
	}
	if !generated {
		t.Fatal("resolveToken() generated = false, want true")
	}
	if len(token) < 32 {
		t.Fatalf("resolveToken() token length = %d, want at least 32", len(token))
	}
}

func TestResolveTokenPreservesConfiguredToken(t *testing.T) {
	token, generated, err := resolveToken("configured-token")
	if err != nil {
		t.Fatalf("resolveToken() error = %v", err)
	}
	if generated {
		t.Fatal("resolveToken() generated = true, want false")
	}
	if token != "configured-token" {
		t.Fatalf("resolveToken() token = %q, want configured token", token)
	}
}

func TestBrowserURLIncludesEscapedToken(t *testing.T) {
	rawURL := browserURL("127.0.0.1:8080", "a token&value")
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("browserURL() returned invalid URL %q: %v", rawURL, err)
	}
	if parsed.Scheme != "http" || parsed.Host != "127.0.0.1:8080" {
		t.Fatalf("browserURL() = %q, want local HTTP URL", rawURL)
	}
	if got := parsed.Query().Get("token"); got != "a token&value" {
		t.Fatalf("browserURL() token = %q, want escaped token", got)
	}
}

func TestAgentLogRootsRespectConfiguredAgentHomes(t *testing.T) {
	codex, claude := agentLogRoots(
		"/home/me", "/profiles/codex", "/profiles/claude",
	)
	if codex != filepath.Join("/profiles/codex", "sessions") ||
		claude != filepath.Join("/profiles/claude", "projects") {
		t.Fatalf("agentLogRoots() = %q, %q", codex, claude)
	}

	codex, claude = agentLogRoots("/home/me", "", "")
	if codex != filepath.Join("/home/me", ".codex", "sessions") ||
		claude != filepath.Join("/home/me", ".claude", "projects") {
		t.Fatalf("default agentLogRoots() = %q, %q", codex, claude)
	}
}
