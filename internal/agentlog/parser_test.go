package agentlog

import (
	"strconv"
	"strings"
	"testing"
)

func TestParseClaudeTranscriptNormalizesMessagesAndTools(t *testing.T) {
	input := strings.Join([]string{
		`{"type":"user","timestamp":"2026-07-30T01:02:03Z","message":{"role":"user","content":"Ship it"}}`,
		`{"type":"assistant","timestamp":"2026-07-30T01:02:04Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Checking the suite"},{"type":"text","text":"Running tests."},{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"go test ./..."}}]}}`,
		`{"type":"user","timestamp":"2026-07-30T01:02:05Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"ok"}]}}`,
	}, "\n")

	got, err := Parse("claude", strings.NewReader(input))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	want := []Entry{
		{ID: "1-0", Kind: "message", Role: "user", Content: "Ship it", Timestamp: "2026-07-30T01:02:03Z"},
		{ID: "2-0", Kind: "thinking", Role: "assistant", Content: "Checking the suite", Timestamp: "2026-07-30T01:02:04Z"},
		{ID: "2-1", Kind: "message", Role: "assistant", Content: "Running tests.", Timestamp: "2026-07-30T01:02:04Z"},
		{ID: "2-2", Kind: "tool", Title: "Bash", Content: "{\n  \"command\": \"go test ./...\"\n}", Timestamp: "2026-07-30T01:02:04Z"},
		{ID: "3-0", Kind: "tool_result", Title: "Bash", Content: "ok", Timestamp: "2026-07-30T01:02:05Z"},
	}
	if !entriesEqual(got, want) {
		t.Fatalf("Parse() = %#v, want %#v", got, want)
	}
}

func TestParseCodexTranscriptNormalizesMessagesAndTools(t *testing.T) {
	input := strings.Join([]string{
		`{"type":"session_meta","timestamp":"2026-07-30T01:02:02Z","payload":{"id":"session-1"}}`,
		`{"type":"response_item","timestamp":"2026-07-30T01:02:03Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Ship it"}]}}`,
		`{"type":"response_item","timestamp":"2026-07-30T01:02:04Z","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"Checking the suite"}]}}`,
		`{"type":"response_item","timestamp":"2026-07-30T01:02:05Z","payload":{"type":"function_call","call_id":"call-1","name":"exec_command","arguments":"{\"cmd\":\"go test ./...\"}"}}`,
		`{"type":"response_item","timestamp":"2026-07-30T01:02:06Z","payload":{"type":"function_call_output","call_id":"call-1","output":"ok"}}`,
		`{"type":"response_item","timestamp":"2026-07-30T01:02:07Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done."}]}}`,
	}, "\n")

	got, err := Parse("codex", strings.NewReader(input))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	want := []Entry{
		{ID: "2-0", Kind: "message", Role: "user", Content: "Ship it", Timestamp: "2026-07-30T01:02:03Z"},
		{ID: "3-0", Kind: "thinking", Role: "assistant", Content: "Checking the suite", Timestamp: "2026-07-30T01:02:04Z"},
		{ID: "4-0", Kind: "tool", Title: "exec_command", Content: "{\n  \"cmd\": \"go test ./...\"\n}", Timestamp: "2026-07-30T01:02:05Z"},
		{ID: "5-0", Kind: "tool_result", Title: "exec_command", Content: "ok", Timestamp: "2026-07-30T01:02:06Z"},
		{ID: "6-0", Kind: "message", Role: "assistant", Content: "Done.", Timestamp: "2026-07-30T01:02:07Z"},
	}
	if !entriesEqual(got, want) {
		t.Fatalf("Parse() = %#v, want %#v", got, want)
	}
}

func TestParseSkipsMalformedAndUnknownRecords(t *testing.T) {
	input := "{\"type\":\"unknown\"}\nnot-json\n" +
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Still readable"}]}}`

	got, err := Parse("claude", strings.NewReader(input))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	want := []Entry{{ID: "3-0", Kind: "message", Role: "assistant", Content: "Still readable"}}
	if !entriesEqual(got, want) {
		t.Fatalf("Parse() = %#v, want %#v", got, want)
	}
}

func TestParseTruncatesOversizedToolOutput(t *testing.T) {
	content := strings.Repeat("x", maxEntryContentBytes+100)
	input := `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"` +
		content + `"}]}}`

	got, err := Parse("claude", strings.NewReader(input))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("Parse() returned %d entries, want 1", len(got))
	}
	if len(got[0].Content) > maxEntryContentBytes+64 ||
		!strings.HasSuffix(got[0].Content, "\n\n[output truncated]") {
		t.Fatalf("truncated content length/suffix = %d, %q", len(got[0].Content), got[0].Content[len(got[0].Content)-32:])
	}
}

func TestParseKeepsReadingAfterAMultiMegabyteRecord(t *testing.T) {
	content := strings.Repeat("x", (4<<20)+100)
	input := `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"` +
		content + `"}]}}` + "\n" +
		`{"type":"assistant","message":{"role":"assistant","content":"After large output"}}`

	got, err := Parse("claude", strings.NewReader(input))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("Parse() returned %d entries, want 2", len(got))
	}
	if got[1].Content != "After large output" {
		t.Fatalf("last entry = %#v", got[1])
	}
}

func TestParseRejectsUnsupportedAgent(t *testing.T) {
	if _, err := Parse("other", strings.NewReader("{}")); err == nil {
		t.Fatal("Parse() error = nil, want unsupported agent error")
	}
}

func TestParseReturnsAnEmptySliceForAnEmptyTranscript(t *testing.T) {
	got, err := Parse("claude", strings.NewReader(""))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if got == nil || len(got) != 0 {
		t.Fatalf("Parse() = %#v, want non-nil empty slice", got)
	}
}

func TestParseDoesNotTruncateAssistantMessages(t *testing.T) {
	content := strings.Repeat("x", maxEntryContentBytes+100)
	input := `{"type":"assistant","message":{"role":"assistant","content":` +
		strconv.Quote(content) + `}}`

	got, err := Parse("claude", strings.NewReader(input))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if len(got) != 1 || got[0].Content != content {
		t.Fatalf("Parse() message length = %d, want %d", len(got[0].Content), len(content))
	}
}

func entriesEqual(left, right []Entry) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
