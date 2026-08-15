package agentlog

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
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
		{ID: "2-2", Kind: "tool", CallID: "tool-1", Title: "Bash", Content: "{\n  \"command\": \"go test ./...\"\n}", Timestamp: "2026-07-30T01:02:04Z"},
		{ID: "3-0", Kind: "tool_result", CallID: "tool-1", Title: "Bash", Content: "ok", Timestamp: "2026-07-30T01:02:05Z"},
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
		{ID: "4-0", Kind: "tool", CallID: "call-1", Title: "exec_command", Content: "{\n  \"cmd\": \"go test ./...\"\n}", Timestamp: "2026-07-30T01:02:05Z"},
		{ID: "5-0", Kind: "tool_result", CallID: "call-1", Title: "exec_command", Content: "ok", Timestamp: "2026-07-30T01:02:06Z"},
		{ID: "6-0", Kind: "message", Role: "assistant", Content: "Done.", Timestamp: "2026-07-30T01:02:07Z"},
	}
	if !entriesEqual(got, want) {
		t.Fatalf("Parse() = %#v, want %#v", got, want)
	}
}

func TestParseClaudeTranscriptNormalizesImageAndVideoSourceBlocks(t *testing.T) {
	input := `{"type":"assistant","timestamp":"2026-07-30T01:02:04Z","message":{"role":"assistant","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"aGVsbG8="},"alt":"Screenshot"},{"type":"video","source":{"type":"url","url":"https://example.com/demo.mp4"},"alt":"Demo recording"}]}}`

	got, err := Parse("claude", strings.NewReader(input))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	assertEntriesJSON(t, got, `[
		{"id":"1-0","kind":"image","role":"assistant","url":"data:image/png;base64,aGVsbG8=","mimeType":"image/png","alt":"Screenshot","timestamp":"2026-07-30T01:02:04Z"},
		{"id":"1-1","kind":"video","role":"assistant","url":"https://example.com/demo.mp4","alt":"Demo recording","timestamp":"2026-07-30T01:02:04Z"}
	]`)
}

func TestParseCodexTranscriptNormalizesResponsesMediaBlocks(t *testing.T) {
	input := strings.Join([]string{
		`{"type":"response_item","timestamp":"2026-07-30T01:02:03Z","payload":{"type":"message","role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,aGVsbG8=","alt":"Input screenshot"},{"type":"output_image","image_url":"https://example.com/output.png","alt":"Generated image"},{"type":"input_video","video_url":"https://example.com/input.mp4","alt":"Input clip"},{"type":"output_video","video_url":"data:video/mp4;base64,AAAA","alt":"Generated clip"}]}}`,
	}, "\n")

	got, err := Parse("codex", strings.NewReader(input))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	assertEntriesJSON(t, got, `[
		{"id":"1-0","kind":"image","role":"user","url":"data:image/png;base64,aGVsbG8=","mimeType":"image/png","alt":"Input screenshot","timestamp":"2026-07-30T01:02:03Z"},
		{"id":"1-1","kind":"image","role":"user","url":"https://example.com/output.png","alt":"Generated image","timestamp":"2026-07-30T01:02:03Z"},
		{"id":"1-2","kind":"video","role":"user","url":"https://example.com/input.mp4","alt":"Input clip","timestamp":"2026-07-30T01:02:03Z"},
		{"id":"1-3","kind":"video","role":"user","url":"data:video/mp4;base64,AAAA","mimeType":"video/mp4","alt":"Generated clip","timestamp":"2026-07-30T01:02:03Z"}
	]`)
}

func TestParseCodexTranscriptNormalizesMediaInToolOutputArrays(t *testing.T) {
	input := strings.Join([]string{
		`{"type":"response_item","timestamp":"2026-07-30T01:02:03Z","payload":{"type":"function_call","call_id":"call-1","name":"view_image","arguments":"{}"}}`,
		`{"type":"response_item","timestamp":"2026-07-30T01:02:04Z","payload":{"type":"function_call_output","call_id":"call-1","output":[{"type":"input_text","text":"Screenshot and recording attached."},{"type":"input_image","image_url":"data:image/png;base64,aGVsbG8=","detail":"original","alt":"Screenshot"},{"type":"input_video","video_url":"https://example.com/recording.mp4","alt":"Recording"}]}}`,
	}, "\n")

	got, err := Parse("codex", strings.NewReader(input))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	assertEntriesJSON(t, got, `[
		{"id":"1-0","kind":"tool","callId":"call-1","title":"view_image","content":"{}","timestamp":"2026-07-30T01:02:03Z"},
		{"id":"2-0","kind":"tool_result","callId":"call-1","title":"view_image","content":"Screenshot and recording attached.","timestamp":"2026-07-30T01:02:04Z"},
		{"id":"2-1","kind":"image","url":"data:image/png;base64,aGVsbG8=","mimeType":"image/png","alt":"Screenshot","timestamp":"2026-07-30T01:02:04Z"},
		{"id":"2-2","kind":"video","url":"https://example.com/recording.mp4","alt":"Recording","timestamp":"2026-07-30T01:02:04Z"}
	]`)
}

func TestParseClaudeTranscriptExtractsMediaFromToolResultContent(t *testing.T) {
	input := strings.Join([]string{
		`{"type":"assistant","timestamp":"2026-07-30T01:02:03Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tool-1","name":"inspect","input":{}}]}}`,
		`{"type":"user","timestamp":"2026-07-30T01:02:04Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":[{"type":"text","text":"Screenshot and recording attached."},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"aGVsbG8="},"alt":"Screenshot"},{"type":"video","source":{"type":"url","url":"https://example.com/recording.mp4"},"alt":"Recording"}]}]}}`,
	}, "\n")

	got, err := Parse("claude", strings.NewReader(input))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	assertEntriesJSON(t, got, `[
		{"id":"1-0","kind":"tool","callId":"tool-1","title":"inspect","content":"{}","timestamp":"2026-07-30T01:02:03Z"},
		{"id":"2-0","kind":"tool_result","callId":"tool-1","title":"inspect","content":"Screenshot and recording attached.","timestamp":"2026-07-30T01:02:04Z"},
		{"id":"2-1","kind":"image","url":"data:image/png;base64,aGVsbG8=","mimeType":"image/png","alt":"Screenshot","timestamp":"2026-07-30T01:02:04Z"},
		{"id":"2-2","kind":"video","url":"https://example.com/recording.mp4","alt":"Recording","timestamp":"2026-07-30T01:02:04Z"}
	]`)
}

func TestParseCodexTranscriptFiltersCompleteEnvironmentContextPayload(t *testing.T) {
	input := strings.Join([]string{
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\n<cwd>/repo</cwd>\n</environment_context>"}]}}`,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Keep this ordinary request"}]}}`,
	}, "\n")

	got, err := Parse("codex", strings.NewReader(input))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	want := []Entry{{ID: "2-0", Kind: "message", Role: "user", Content: "Keep this ordinary request"}}
	if !entriesEqual(got, want) {
		t.Fatalf("Parse() = %#v, want %#v", got, want)
	}
}

func TestParseCodexTranscriptFiltersCompleteAGENTSInstructionsPayload(t *testing.T) {
	input := strings.Join([]string{
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nUse the repository rules.\n</INSTRUCTIONS>"}]}}`,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Visible user request"}]}}`,
	}, "\n")

	got, err := Parse("codex", strings.NewReader(input))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	want := []Entry{{ID: "2-0", Kind: "message", Role: "user", Content: "Visible user request"}}
	if !entriesEqual(got, want) {
		t.Fatalf("Parse() = %#v, want %#v", got, want)
	}
}

func TestParseSkipsUnsafeUnsupportedAndOversizedMedia(t *testing.T) {
	oversizedDataURL := "data:image/png;base64," + strings.Repeat("A", 1<<20)
	input := strings.Join([]string{
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"image","source":{"type":"url","url":"javascript:alert(1)"}},{"type":"image","source":{"type":"base64","media_type":"text/plain","data":"aGVsbG8="}},{"type":"audio","source":{"type":"base64","media_type":"audio/wav","data":"aGVsbG8="}}]}}`,
		fmt.Sprintf(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"image","source":{"type":"url","url":%s}}]}}`, strconv.Quote(oversizedDataURL)),
		`{"type":"assistant","message":{"role":"assistant","content":"Still readable"}}`,
	}, "\n")

	got, err := Parse("claude", strings.NewReader(input))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	want := []Entry{{ID: "3-0", Kind: "message", Role: "assistant", Content: "Still readable"}}
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

func TestParseAtUsesAbsoluteByteOffsetsForStableIDs(t *testing.T) {
	first := `{"type":"assistant","message":{"role":"assistant","content":"First"}}` + "\n"
	second := `{"type":"assistant","message":{"role":"assistant","content":"Second"}}`

	got, err := ParseAt("claude", strings.NewReader(first+second), 42)
	if err != nil {
		t.Fatalf("ParseAt() error = %v", err)
	}
	want := []Entry{
		{ID: "42-0", Kind: "message", Role: "assistant", Content: "First"},
		{
			ID:      strconv.FormatInt(42+int64(len(first)), 10) + "-0",
			Kind:    "message",
			Role:    "assistant",
			Content: "Second",
		},
	}
	if !entriesEqual(got, want) {
		t.Fatalf("ParseAt() = %#v, want %#v", got, want)
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

func TestCodexTurnAbortedSinceOnlyFindsAppendedAbortEvents(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollout-session.jsonl")
	initial := `{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}` + "\n"
	if err := os.WriteFile(path, []byte(initial), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	offset := int64(len(initial))
	turnID, err := CodexTurnIDAt(path, offset)
	if err != nil || turnID != "turn-1" {
		t.Fatalf("CodexTurnIDAt() = %q, %v; want turn-1", turnID, err)
	}
	if aborted, err := CodexTurnAbortedSince(path, offset, turnID); err != nil || aborted {
		t.Fatalf("CodexTurnAbortedSince(at end) = %t, %v; want false", aborted, err)
	}

	appended := `{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"turn-1","reason":"interrupted"}}` + "\n"
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("OpenFile() error = %v", err)
	}
	if _, err := file.WriteString(appended); err != nil {
		file.Close()
		t.Fatalf("WriteString() error = %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if aborted, err := CodexTurnAbortedSince(path, offset, turnID); err != nil || !aborted {
		t.Fatalf("CodexTurnAbortedSince(after) = %t, %v; want true", aborted, err)
	}
	if aborted, err := CodexTurnAbortedSince(path, offset, "turn-2"); err != nil || aborted {
		t.Fatalf("CodexTurnAbortedSince(other turn) = %t, %v; want false", aborted, err)
	}
}

func TestCodexActivitySinceIgnoresTransientApprovalUntilDurableProgress(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollout-session.jsonl")
	initial := `{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}` + "\n"
	if err := os.WriteFile(path, []byte(initial), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	offset := int64(len(initial))

	transient := "" +
		`{"type":"event_msg","payload":{"type":"exec_approval_request","call_id":"call-1"}}` + "\n" +
		`{"type":"response_item","payload":{"type":"function_call","call_id":"call-1","name":"shell","arguments":"{}"}}` + "\n" +
		`{"type":"event_msg","payload":{"type":"hook_completed","turn_id":"turn-1"}}` + "\n"
	if err := appendCodexTestTranscript(path, transient); err != nil {
		t.Fatalf("append transient events: %v", err)
	}
	if activity, err := CodexActivitySince(path, offset); err != nil || activity != "" {
		t.Fatalf("CodexActivitySince(transient) = %q, %v; want no activity", activity, err)
	}

	if err := appendCodexTestTranscript(path,
		`{"type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"ok"}}`+"\n",
	); err != nil {
		t.Fatalf("append durable progress: %v", err)
	}
	if activity, err := CodexActivitySince(path, offset); err != nil || activity != "running" {
		t.Fatalf("CodexActivitySince(progress) = %q, %v; want running", activity, err)
	}

	if err := appendCodexTestTranscript(path,
		`{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1"}}`+"\n",
	); err != nil {
		t.Fatalf("append completion: %v", err)
	}
	if activity, err := CodexActivitySince(path, offset); err != nil || activity != "waiting" {
		t.Fatalf("CodexActivitySince(completion) = %q, %v; want waiting", activity, err)
	}
}

func appendCodexTestTranscript(path, content string) error {
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.WriteString(content); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

func entriesEqual(left, right []Entry) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if !reflect.DeepEqual(left[index], right[index]) {
			return false
		}
	}
	return true
}

func assertEntriesJSON(t *testing.T, got []Entry, want string) {
	t.Helper()
	gotJSON, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	var gotValue any
	if err := json.Unmarshal(gotJSON, &gotValue); err != nil {
		t.Fatalf("json.Unmarshal(got) error = %v", err)
	}
	var wantValue any
	if err := json.Unmarshal([]byte(want), &wantValue); err != nil {
		t.Fatalf("json.Unmarshal(want) error = %v", err)
	}
	if !reflect.DeepEqual(gotValue, wantValue) {
		t.Fatalf("entries JSON = %s, want %s", gotJSON, want)
	}
}
