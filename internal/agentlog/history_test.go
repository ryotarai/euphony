package agentlog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestResolverDiscoversCodexHistoryFromIndexAndTranscript(t *testing.T) {
	root := t.TempDir()
	indexPath := filepath.Join(root, "session_index.jsonl")
	sessionsRoot := filepath.Join(root, "sessions")
	transcriptPath := filepath.Join(sessionsRoot, "2026", "08", "13", "rollout-session-1.jsonl")
	writeHistoryFile(t, indexPath, strings.Join([]string{
		`{"id":"session-1","thread_name":"Index title","updated_at":"2026-08-13T09:10:00Z","cwd":"/workspace/euphony"}`,
		`not-json`,
	}, "\n"))
	writeHistoryFile(t, transcriptPath, strings.Join([]string{
		`{"type":"session_meta","timestamp":"2026-08-13T09:00:00Z","payload":{"id":"session-1","cwd":"/workspace/euphony"}}`,
		`{"type":"response_item","timestamp":"2026-08-13T09:01:00Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Implement bounded session history"}]}}`,
		`{"type":"response_item","timestamp":"2026-08-13T09:11:00Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"History discovery is ready."}]}}`,
	}, "\n"))

	resolver := NewResolverWithIndex(sessionsRoot, "", indexPath)
	items, err := resolver.DiscoverHistory()
	if err != nil {
		t.Fatalf("DiscoverHistory() error = %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("DiscoverHistory() returned %d items, want 1: %#v", len(items), items)
	}
	got := items[0]
	if got.Agent != "codex" || got.SessionID != "session-1" ||
		got.Title != "Index title" || got.CWD != "/workspace/euphony" ||
		got.Purpose != "Implement bounded session history" ||
		got.Summary != "History discovery is ready." ||
		!got.UpdatedAt.Equal(time.Date(2026, 8, 13, 9, 10, 0, 0, time.UTC)) {
		t.Fatalf("Codex history = %#v", got)
	}
	if got.TranscriptPath == "" {
		t.Fatal("Codex history transcript path is empty")
	}
}

func TestResolverDiscoversClaudeProjectHistory(t *testing.T) {
	root := t.TempDir()
	transcriptPath := filepath.Join(root, "workspace-euphony", "claude-session.jsonl")
	writeHistoryFile(t, transcriptPath, strings.Join([]string{
		`{"type":"user","sessionId":"claude-session","cwd":"/workspace/euphony","timestamp":"2026-08-13T08:00:00Z","message":{"role":"user","content":"Fix the resume flow"}}`,
		`{"type":"ai-title","sessionId":"claude-session","aiTitle":"Generated resume work"}`,
		`{"type":"custom-title","sessionId":"claude-session","customTitle":"Resume sessions"}`,
		`{"type":"assistant","sessionId":"claude-session","cwd":"/workspace/euphony","timestamp":"2026-08-13T08:05:00Z","message":{"role":"assistant","content":[{"type":"text","text":"The resume endpoint now reuses open terminals."}]}}`,
	}, "\n"))

	resolver := NewResolver("", root)
	items, err := resolver.DiscoverHistory()
	if err != nil {
		t.Fatalf("DiscoverHistory() error = %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("DiscoverHistory() returned %d items, want 1: %#v", len(items), items)
	}
	got := items[0]
	if got.Agent != "claude" || got.SessionID != "claude-session" ||
		got.Title != "Resume sessions" || got.CWD != "/workspace/euphony" ||
		got.Purpose != "Fix the resume flow" ||
		got.Summary != "The resume endpoint now reuses open terminals." {
		t.Fatalf("Claude history = %#v", got)
	}
	if got.UpdatedAt.IsZero() {
		t.Fatal("Claude history UpdatedAt is zero")
	}
}

func TestResolverDiscoversArchivedCodexHistory(t *testing.T) {
	root := t.TempDir()
	sessionsRoot := filepath.Join(root, "sessions")
	archivedPath := filepath.Join(root, "archived_sessions", "archived-session.jsonl")
	writeHistoryFile(t, archivedPath, strings.Join([]string{
		`{"type":"session_meta","timestamp":"2026-08-13T07:00:00Z","payload":{"id":"archived-session","cwd":"/workspace/archived"}}`,
		`{"type":"response_item","timestamp":"2026-08-13T07:01:00Z","payload":{"type":"message","role":"user","content":"Inspect archived work"}}`,
	}, "\n"))

	items, err := NewResolver(sessionsRoot, "").DiscoverHistory()
	if err != nil {
		t.Fatalf("DiscoverHistory() error = %v", err)
	}
	if len(items) != 1 || items[0].Agent != "codex" || items[0].SessionID != "archived-session" {
		t.Fatalf("archived history = %#v, want one archived Codex session", items)
	}
}

func TestResolverSkipsMalformedHistoryRecords(t *testing.T) {
	root := t.TempDir()
	writeHistoryFile(t, filepath.Join(root, "valid-session.jsonl"), strings.Join([]string{
		`not-json`,
		`{"type":"user","sessionId":"valid-session","cwd":"/workspace","timestamp":"not-a-time","message":{"role":"user","content":"Keep this one"}}`,
		`{"type":"assistant","sessionId":"valid-session","message":{"role":"assistant","content":"Done"}}`,
	}, "\n"))
	writeHistoryFile(t, filepath.Join(root, "broken-session.jsonl"), "{\n")

	items, err := NewResolver("", root).DiscoverHistory()
	if err != nil {
		t.Fatalf("DiscoverHistory() error = %v", err)
	}
	if len(items) != 1 || items[0].SessionID != "valid-session" {
		t.Fatalf("DiscoverHistory() = %#v, want only valid-session", items)
	}
}

func TestResolverOrdersHistoryNewestFirstWithStableIDTieBreak(t *testing.T) {
	root := t.TempDir()
	for _, item := range []struct {
		id      string
		updated string
	}{
		{id: "older", updated: "2026-08-13T08:00:00Z"},
		{id: "same-z", updated: "2026-08-13T09:00:00Z"},
		{id: "same-a", updated: "2026-08-13T09:00:00Z"},
	} {
		writeHistoryFile(t, filepath.Join(root, item.id+".jsonl"),
			`{"type":"user","sessionId":"`+item.id+`","timestamp":"`+item.updated+`","message":{"role":"user","content":"`+item.id+`"}}`+"\n")
	}

	items, err := NewResolver("", root).DiscoverHistory()
	if err != nil {
		t.Fatalf("DiscoverHistory() error = %v", err)
	}
	var ids []string
	for _, item := range items {
		ids = append(ids, item.SessionID)
	}
	want := []string{"same-a", "same-z", "older"}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("history IDs = %v, want %v", ids, want)
	}
}

func TestResolverBoundsFallbackPreviewText(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "bounded.jsonl")
	large := strings.Repeat("x", 2<<20)
	writeHistoryFile(t, path, strings.Join([]string{
		`{"type":"user","sessionId":"bounded","cwd":"/workspace","message":{"role":"user","content":"` + large + `"}}`,
		`{"type":"assistant","sessionId":"bounded","message":{"role":"assistant","content":"final"}}`,
	}, "\n"))

	items, err := NewResolver("", root).DiscoverHistory()
	if err != nil {
		t.Fatalf("DiscoverHistory() error = %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("DiscoverHistory() returned %d items, want 1", len(items))
	}
	if len(items[0].Purpose) > maxHistoryPreviewBytes {
		t.Fatalf("purpose length = %d, want <= %d", len(items[0].Purpose), maxHistoryPreviewBytes)
	}
}

func writeHistoryFile(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
}

func TestHistoryScanBudgetStopsUnboundedDirectoryReads(t *testing.T) {
	budget := historyScanBudget{}
	for index := 0; index < maxHistoryScanFiles; index++ {
		if !budget.reserve(1) {
			t.Fatalf("reserve(%d) unexpectedly failed at file %d", 1, index)
		}
	}
	if budget.reserve(1) || !budget.exhausted {
		t.Fatalf("file budget = %#v, want exhausted", budget)
	}

	budget = historyScanBudget{}
	for !budget.exhausted {
		budget.reserve(maxHistoryWindowBytes)
	}
	if budget.bytes != maxHistoryScanBytes {
		t.Fatalf("byte budget = %#v, want exhausted", budget)
	}
}

func TestDiscoverHistoryFilesUsesBoundedParallelism(t *testing.T) {
	const (
		fileCount = 4
		workers   = 2
	)

	files := make([]historyFile, fileCount)
	started := make(chan struct{}, fileCount)
	release := make(chan struct{})
	completed := make(chan []HistorySession, 1)
	var active int32
	var maxActive int32

	go func() {
		items := discoverHistoryFiles(files, workers, func(_ historyFile) (HistorySession, bool) {
			current := atomic.AddInt32(&active, 1)
			for {
				previous := atomic.LoadInt32(&maxActive)
				if current <= previous || atomic.CompareAndSwapInt32(&maxActive, previous, current) {
					break
				}
			}
			started <- struct{}{}
			<-release
			atomic.AddInt32(&active, -1)
			return HistorySession{Agent: "test", SessionID: "session"}, true
		})
		completed <- items
	}()

	for index := 0; index < workers; index++ {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("history file workers did not start concurrently")
		}
	}
	close(release)

	select {
	case items := <-completed:
		if len(items) != fileCount {
			t.Fatalf("discovered history files = %d, want %d", len(items), fileCount)
		}
	case <-time.After(time.Second):
		t.Fatal("history file workers did not complete")
	}
	if got := atomic.LoadInt32(&maxActive); got != workers {
		t.Fatalf("maximum concurrent history files = %d, want %d", got, workers)
	}
}

func TestHistoryLinesKeepsTailRecordAtExactBoundary(t *testing.T) {
	head := []byte(`{"type":"session_meta"}` + "\n")
	tail := []byte(`{"type":"response_item"}` + "\n")
	lines := historyLines(head, tail)
	if len(lines) != 4 || string(lines[2]) != string(tail[:len(tail)-1]) {
		t.Fatalf("historyLines() = %#v, want the complete boundary record", lines)
	}
}

func TestHistorySessionJSONShapeIsStable(t *testing.T) {
	payload, err := json.Marshal(HistorySession{
		Agent: "codex", SessionID: "session-1", Title: "Title", CWD: "/workspace",
		UpdatedAt: time.Date(2026, 8, 13, 9, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	if !strings.Contains(string(payload), `"sessionId":"session-1"`) {
		t.Fatalf("HistorySession JSON = %s", payload)
	}
}
