package agentlog

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClaudeTranscriptTitlePrefersRenameOverGeneratedTitle(t *testing.T) {
	// Claude Code records `/rename` as a custom-title entry and its own guess as
	// an ai-title entry, then re-appends both every turn. Reading only ai-title
	// leaves a renamed session displaying the guess forever.
	tests := []struct {
		name  string
		lines []string
		want  string
	}{
		{
			name: "rename after generated title",
			lines: []string{
				`{"type":"ai-title","aiTitle":"Add relayed webhook support","sessionId":"agent-1"}`,
				`{"type":"custom-title","customTitle":"deploy","sessionId":"agent-1"}`,
			},
			want: "deploy",
		},
		{
			name: "generated title re-appended after rename",
			lines: []string{
				`{"type":"custom-title","customTitle":"deploy","sessionId":"agent-1"}`,
				`{"type":"ai-title","aiTitle":"Add relayed webhook support","sessionId":"agent-1"}`,
			},
			want: "deploy",
		},
		{
			name: "rename without any generated title",
			lines: []string{
				`{"type":"custom-title","customTitle":"pv lost issue","sessionId":"agent-1"}`,
			},
			want: "pv lost issue",
		},
		{
			name: "newest rename wins",
			lines: []string{
				`{"type":"custom-title","customTitle":"first name","sessionId":"agent-1"}`,
				`{"type":"custom-title","customTitle":"second name","sessionId":"agent-1"}`,
			},
			want: "second name",
		},
		{
			name: "cleared rename falls back to generated title",
			lines: []string{
				`{"type":"ai-title","aiTitle":"Generated","sessionId":"agent-1"}`,
				`{"type":"custom-title","customTitle":"","sessionId":"agent-1"}`,
			},
			want: "Generated",
		},
		{
			name: "generated title only",
			lines: []string{
				`{"type":"ai-title","aiTitle":"Generated","sessionId":"agent-1"}`,
			},
			want: "Generated",
		},
		{
			name:  "no title recorded",
			lines: []string{`{"type":"user","message":{"content":"hi"}}`},
			want:  "",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "session.jsonl")
			body := strings.Join(test.lines, "\n") + "\n"
			if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
				t.Fatalf("WriteFile() error = %v", err)
			}
			if got := ClaudeTranscriptTitle(path); got != test.want {
				t.Fatalf("ClaudeTranscriptTitle() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestClaudeTranscriptTitleReadsOnlyTheTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	lines := []string{
		`{"type":"custom-title","customTitle":"Stale name","sessionId":"agent-1"}`,
		`{"type":"user","message":{"content":"` + strings.Repeat("x", 2_000_000) + `"}}`,
		`{"type":"custom-title","customTitle":"Fresh name","sessionId":"agent-1"}`,
		`{"type":"assistant","message":{"content":"done"}}`,
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	if got := ClaudeTranscriptTitle(path); got != "Fresh name" {
		t.Fatalf("ClaudeTranscriptTitle() = %q, want the title inside the tail window", got)
	}
}

func TestClaudeTranscriptTitleIgnoresUnreadableTranscript(t *testing.T) {
	if got := ClaudeTranscriptTitle(""); got != "" {
		t.Fatalf("ClaudeTranscriptTitle(\"\") = %q, want empty", got)
	}
	if got := ClaudeTranscriptTitle("/does/not/exist.jsonl"); got != "" {
		t.Fatalf("ClaudeTranscriptTitle(missing) = %q, want empty", got)
	}
}
