package agentlog

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestResolverAcceptsRecordedPathInsideAgentRoot(t *testing.T) {
	claudeRoot := filepath.Join(t.TempDir(), "claude-projects")
	path := filepath.Join(claudeRoot, "repo", "session-1.jsonl")
	writeTranscriptFixture(t, path)
	resolver := NewResolver("", claudeRoot)

	got, err := resolver.Resolve("claude", "session-1", path)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	want, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatalf("EvalSymlinks() error = %v", err)
	}
	if got != want {
		t.Fatalf("Resolve() = %q, want %q", got, want)
	}
}

func TestResolverRejectsRecordedPathOutsideAgentRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "claude-projects")
	outside := filepath.Join(t.TempDir(), "session-1.jsonl")
	writeTranscriptFixture(t, outside)
	resolver := NewResolver("", root)

	if _, err := resolver.Resolve("claude", "session-1", outside); !errors.Is(err, ErrTranscriptNotFound) {
		t.Fatalf("Resolve() error = %v, want ErrTranscriptNotFound", err)
	}
}

func TestResolverRejectsRecordedPathForAnotherSession(t *testing.T) {
	root := filepath.Join(t.TempDir(), "claude-projects")
	oldPath := filepath.Join(root, "repo", "session-1.jsonl")
	writeTranscriptFixture(t, oldPath)
	resolver := NewResolver("", root)

	if _, err := resolver.Resolve("claude", "session-2", oldPath); !errors.Is(err, ErrTranscriptNotFound) {
		t.Fatalf("Resolve() error = %v, want ErrTranscriptNotFound", err)
	}
}

func TestResolverFindsClaudeTranscriptByExactSessionFilename(t *testing.T) {
	root := filepath.Join(t.TempDir(), "claude-projects")
	want := filepath.Join(root, "encoded-repo", "session-1.jsonl")
	writeTranscriptFixture(t, want)
	writeTranscriptFixture(t, filepath.Join(root, "encoded-repo", "prefix-session-1.jsonl"))
	resolver := NewResolver("", root)

	got, err := resolver.Resolve("claude", "session-1", "")
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	canonical, err := filepath.EvalSymlinks(want)
	if err != nil {
		t.Fatalf("EvalSymlinks() error = %v", err)
	}
	if got != canonical {
		t.Fatalf("Resolve() = %q, want exact filename %q", got, canonical)
	}
}

func TestResolverFindsCodexTranscriptByRolloutSuffix(t *testing.T) {
	root := filepath.Join(t.TempDir(), "codex-sessions")
	want := filepath.Join(root, "2026", "07", "30", "rollout-2026-07-30T00-00-00-session-1.jsonl")
	writeTranscriptFixture(t, want)
	resolver := NewResolver(root, "")

	got, err := resolver.Resolve("codex", "session-1", "")
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	canonical, err := filepath.EvalSymlinks(want)
	if err != nil {
		t.Fatalf("EvalSymlinks() error = %v", err)
	}
	if got != canonical {
		t.Fatalf("Resolve() = %q, want %q", got, canonical)
	}
}

func TestResolverRejectsUnsafeOrEmptySessionID(t *testing.T) {
	resolver := NewResolver(t.TempDir(), t.TempDir())
	for _, sessionID := range []string{"", ".", "..", "../secret", "nested/session"} {
		if _, err := resolver.Resolve("codex", sessionID, ""); !errors.Is(err, ErrTranscriptNotFound) {
			t.Fatalf("Resolve(%q) error = %v, want ErrTranscriptNotFound", sessionID, err)
		}
	}
}

func TestResolverDoesNotTreatEmptyRootAsCurrentDirectory(t *testing.T) {
	workingDirectory := t.TempDir()
	previous, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd() error = %v", err)
	}
	if err := os.Chdir(workingDirectory); err != nil {
		t.Fatalf("Chdir() error = %v", err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(previous); err != nil {
			t.Errorf("restore working directory: %v", err)
		}
	})
	writeTranscriptFixture(t, filepath.Join(workingDirectory, "session-1.jsonl"))
	resolver := NewResolver("", "")

	if _, err := resolver.Resolve("claude", "session-1", ""); !errors.Is(err, ErrTranscriptNotFound) {
		t.Fatalf("Resolve() error = %v, want ErrTranscriptNotFound", err)
	}
}

func TestResolverRejectsSymlinkEscapingAgentRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "claude-projects")
	outside := filepath.Join(t.TempDir(), "session-1.jsonl")
	writeTranscriptFixture(t, outside)
	link := filepath.Join(root, "repo", "session-1.jsonl")
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.Symlink(outside, link); err != nil {
		t.Fatalf("Symlink() error = %v", err)
	}
	resolver := NewResolver("", root)

	if _, err := resolver.Resolve("claude", "session-1", link); !errors.Is(err, ErrTranscriptNotFound) {
		t.Fatalf("Resolve() error = %v, want ErrTranscriptNotFound", err)
	}
}

func TestResolverRejectsSymlinkToAnotherSessionInsideAgentRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "claude-projects")
	target := filepath.Join(root, "repo", "session-1.jsonl")
	writeTranscriptFixture(t, target)
	link := filepath.Join(root, "repo", "session-2.jsonl")
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("Symlink() error = %v", err)
	}
	resolver := NewResolver("", root)

	if _, err := resolver.Resolve("claude", "session-2", link); !errors.Is(err, ErrTranscriptNotFound) {
		t.Fatalf("Resolve() error = %v, want ErrTranscriptNotFound", err)
	}
}

func TestResolverBrieflyCachesFallbackMisses(t *testing.T) {
	root := filepath.Join(t.TempDir(), "claude-projects")
	path := filepath.Join(root, "repo", "session-1.jsonl")
	resolver := NewResolver("", root)
	now := time.Date(2026, 7, 30, 1, 2, 3, 0, time.UTC)
	resolver.now = func() time.Time { return now }

	if _, err := resolver.Resolve("claude", "session-1", ""); !errors.Is(err, ErrTranscriptNotFound) {
		t.Fatalf("first Resolve() error = %v, want ErrTranscriptNotFound", err)
	}
	writeTranscriptFixture(t, path)
	if _, err := resolver.Resolve("claude", "session-1", ""); !errors.Is(err, ErrTranscriptNotFound) {
		t.Fatalf("immediate Resolve() error = %v, want cached ErrTranscriptNotFound", err)
	}
	now = now.Add(fallbackMissCacheTTL)
	if _, err := resolver.Resolve("claude", "session-1", ""); err != nil {
		t.Fatalf("Resolve() after cache expiry error = %v", err)
	}
}

func writeTranscriptFixture(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
}
