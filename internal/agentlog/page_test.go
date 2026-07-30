package agentlog

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestReadPageReturnsOnlyTheNewestRecordsWithAnOlderCursor(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	var transcript strings.Builder
	offsets := make([]int64, 105)
	for index := 1; index <= 105; index++ {
		offsets[index-1] = int64(transcript.Len())
		fmt.Fprintf(
			&transcript,
			"{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":\"Message %03d\"}}\n",
			index,
		)
	}
	if err := os.WriteFile(path, []byte(transcript.String()), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer file.Close()

	page, err := ReadPage("claude", file, int64(transcript.Len()), 100)
	if err != nil {
		t.Fatalf("ReadPage() error = %v", err)
	}
	if len(page.Entries) != 100 {
		t.Fatalf("ReadPage() entries = %d, want 100", len(page.Entries))
	}
	if page.Entries[0].Content != "Message 006" ||
		page.Entries[99].Content != "Message 105" {
		t.Fatalf(
			"ReadPage() range = %q ... %q",
			page.Entries[0].Content,
			page.Entries[99].Content,
		)
	}
	if page.StartCursor != offsets[5] || page.EndCursor != int64(transcript.Len()) {
		t.Fatalf(
			"ReadPage() cursors = %d..%d, want %d..%d",
			page.StartCursor,
			page.EndCursor,
			offsets[5],
			transcript.Len(),
		)
	}
	if !page.HasMore {
		t.Fatal("ReadPage() HasMore = false, want true")
	}
	wantID := strconv.FormatInt(offsets[5], 10) + "-0"
	if page.Entries[0].ID != wantID {
		t.Fatalf("first entry ID = %q, want %q", page.Entries[0].ID, wantID)
	}

	older, err := ReadPage("claude", file, page.StartCursor, 100)
	if err != nil {
		t.Fatalf("older ReadPage() error = %v", err)
	}
	if len(older.Entries) != 5 ||
		older.Entries[0].Content != "Message 001" ||
		older.Entries[4].Content != "Message 005" {
		t.Fatalf("older ReadPage() entries = %#v", older.Entries)
	}
	if older.StartCursor != 0 || older.EndCursor != page.StartCursor || older.HasMore {
		t.Fatalf("older ReadPage() cursors/more = %#v", older)
	}
}

func TestReadAfterReturnsOnlyAppendedRecords(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	initial := `{"type":"assistant","message":{"role":"assistant","content":"First"}}` + "\n"
	if err := os.WriteFile(path, []byte(initial), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatalf("OpenFile() error = %v", err)
	}
	defer file.Close()
	appended := `{"type":"assistant","message":{"role":"assistant","content":"Second"}}` + "\n"
	if _, err := file.WriteAt([]byte(appended), int64(len(initial))); err != nil {
		t.Fatalf("WriteAt() error = %v", err)
	}

	page, err := ReadAfter("claude", file, int64(len(initial)))
	if err != nil {
		t.Fatalf("ReadAfter() error = %v", err)
	}
	if len(page.Entries) != 1 || page.Entries[0].Content != "Second" {
		t.Fatalf("ReadAfter() entries = %#v", page.Entries)
	}
	if page.StartCursor != int64(len(initial)) ||
		page.EndCursor != int64(len(initial)+len(appended)) ||
		page.HasMore {
		t.Fatalf("ReadAfter() page = %#v", page)
	}
}

func TestReadAfterDoesNotAdvancePastAnIncompleteJSONLRecord(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	initial := `{"type":"assistant","message":{"role":"assistant","content":"First"}}` + "\n"
	partial := `{"type":"assistant","message":{"role":"assistant","content":"Sec`
	if err := os.WriteFile(path, []byte(initial+partial), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatalf("OpenFile() error = %v", err)
	}
	defer file.Close()

	incomplete, err := ReadAfter("claude", file, int64(len(initial)))
	if err != nil {
		t.Fatalf("incomplete ReadAfter() error = %v", err)
	}
	if len(incomplete.Entries) != 0 ||
		incomplete.StartCursor != int64(len(initial)) ||
		incomplete.EndCursor != int64(len(initial)) {
		t.Fatalf("incomplete ReadAfter() = %#v", incomplete)
	}

	remainder := `ond"}}` + "\n"
	if _, err := file.WriteAt(
		[]byte(remainder),
		int64(len(initial)+len(partial)),
	); err != nil {
		t.Fatalf("WriteAt() error = %v", err)
	}
	complete, err := ReadAfter("claude", file, incomplete.EndCursor)
	if err != nil {
		t.Fatalf("complete ReadAfter() error = %v", err)
	}
	if len(complete.Entries) != 1 ||
		complete.Entries[0].Content != "Second" ||
		complete.EndCursor != int64(len(initial)+len(partial)+len(remainder)) {
		t.Fatalf("complete ReadAfter() = %#v", complete)
	}
}

func TestCompactToolsCountsCallsAndDropsPayloadsAndResults(t *testing.T) {
	entries := []Entry{
		{ID: "1-0", Kind: "message", Content: "Before"},
		{ID: "2-0", Kind: "tool", Title: "exec", Content: "secret argument", Timestamp: "t1"},
		{ID: "3-0", Kind: "tool_result", Title: "exec", Content: "secret result"},
		{ID: "4-0", Kind: "tool", Title: "read", Content: "secret path"},
		{ID: "5-0", Kind: "tool_result", Title: "read", Content: "secret file"},
		{ID: "6-0", Kind: "tool", Title: "test", Content: "secret command"},
		{ID: "7-0", Kind: "tool_result", Title: "test", Content: "secret output"},
		{ID: "8-0", Kind: "message", Content: "After"},
	}

	got := CompactTools(entries)
	want := []Entry{
		{ID: "1-0", Kind: "message", Content: "Before"},
		{ID: "2-0", Kind: "tool_group", ToolCalls: 3, Timestamp: "t1"},
		{ID: "8-0", Kind: "message", Content: "After"},
	}
	if !entriesEqual(got, want) {
		t.Fatalf("CompactTools() = %#v, want %#v", got, want)
	}

	resultOnly := CompactTools([]Entry{
		{ID: "9-0", Kind: "tool_result", Content: "not returned"},
	})
	if len(resultOnly) != 0 {
		t.Fatalf("result-only CompactTools() = %#v, want empty", resultOnly)
	}
}
