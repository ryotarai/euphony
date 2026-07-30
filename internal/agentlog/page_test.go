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

func TestReadPageBoundsBytesWhenANewestToolResultIsHuge(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	before := `{"type":"assistant","message":{"role":"assistant","content":"Before huge result"}}` + "\n"
	hugeResult := `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"` +
		strings.Repeat("x", maxAgentLogPageBytes*2) +
		`"}]}}` + "\n"
	after := `{"type":"assistant","message":{"role":"assistant","content":"After huge result"}}` + "\n"
	transcript := before + hugeResult + after
	if err := os.WriteFile(path, []byte(transcript), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer file.Close()

	page, err := ReadPage("claude", file, int64(len(transcript)), 100)
	if err != nil {
		t.Fatalf("ReadPage() error = %v", err)
	}
	if page.ReadBytes > maxAgentLogPageBytes {
		t.Fatalf(
			"ReadPage() ReadBytes = %d, want <= %d",
			page.ReadBytes,
			maxAgentLogPageBytes,
		)
	}
	if len(page.Entries) != 1 || page.Entries[0].Content != "After huge result" {
		t.Fatalf("ReadPage() entries = %#v", page.Entries)
	}
	if !page.HasMore || page.StartCursor == 0 {
		t.Fatalf("ReadPage() page = %#v, want an older cursor", page)
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

func TestReadAfterKeepsNormalRecordsWholeAtTheByteLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	firstContent := strings.Repeat("a", maxAgentLogPageBytes*3/4)
	secondContent := strings.Repeat("b", maxAgentLogPageBytes*3/4)
	first := `{"type":"assistant","message":{"role":"assistant","content":` +
		strconv.Quote(firstContent) + `}}` + "\n"
	second := `{"type":"assistant","message":{"role":"assistant","content":` +
		strconv.Quote(secondContent) + `}}` + "\n"
	if err := os.WriteFile(path, []byte(first+second), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer file.Close()

	firstPage, err := ReadAfter("claude", file, 0)
	if err != nil {
		t.Fatalf("first ReadAfter() error = %v", err)
	}
	if firstPage.EndCursor != int64(len(first)) ||
		len(firstPage.Entries) != 1 ||
		firstPage.Entries[0].Content != firstContent {
		t.Fatalf(
			"first ReadAfter() cursor/entry count = %d, %d",
			firstPage.EndCursor,
			len(firstPage.Entries),
		)
	}

	secondPage, err := ReadAfter("claude", file, firstPage.EndCursor)
	if err != nil {
		t.Fatalf("second ReadAfter() error = %v", err)
	}
	if secondPage.EndCursor != int64(len(first)+len(second)) ||
		len(secondPage.Entries) != 1 ||
		secondPage.Entries[0].Content != secondContent {
		t.Fatalf(
			"second ReadAfter() cursor/entry count = %d, %d",
			secondPage.EndCursor,
			len(secondPage.Entries),
		)
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

func TestCompleteJSONLEndBoundsANewlineFreeOversizedRecord(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	record := `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"` +
		strings.Repeat("x", maxAgentLogPageBytes*2) +
		`"}]}}`
	if err := os.WriteFile(path, []byte(record), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer file.Close()

	end, err := completeJSONLEnd(
		file,
		int64(len(record)),
		maxAgentLogPageBytes,
	)
	if err != nil {
		t.Fatalf("completeJSONLEnd() error = %v", err)
	}
	if end != int64(len(record)) {
		t.Fatalf("completeJSONLEnd() = %d, want %d", end, len(record))
	}
}

func TestCompactToolsPreservesConsecutiveToolDetails(t *testing.T) {
	entries := []Entry{
		{ID: "2-0", Kind: "tool", CallID: "call-1", Title: "exec", Content: `{"command":"go test"}`},
		{ID: "3-0", Kind: "tool_result", CallID: "call-1", Title: "exec", Content: "ok"},
	}

	got := CompactTools(entries)
	want := []Entry{
		{
			ID: "2-0", Kind: "tool_group", ToolCalls: 1,
			Entries: entries,
		},
	}
	if !entriesEqual(got, want) {
		t.Fatalf("CompactTools() = %#v, want %#v", got, want)
	}
}

func TestCompactToolsPreservesAResultOnlyPageFragment(t *testing.T) {
	result := Entry{ID: "9-0", Kind: "tool_result", CallID: "call-1", Title: "exec", Content: "not returned"}
	got := CompactTools([]Entry{result})
	want := []Entry{{
		ID: "9-0", Kind: "tool_group", Entries: []Entry{result},
	}}
	if !entriesEqual(got, want) {
		t.Fatalf("result-only CompactTools() = %#v, want %#v", got, want)
	}
}
