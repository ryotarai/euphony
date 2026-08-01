package agentlog

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
)

const (
	maxCodexInterruptScanBytes = 1 << 20
	maxCodexInterruptLineBytes = 64 << 10
	CodexActivityRunning       = "running"
	CodexActivityWaiting       = "waiting"
)

// CodexActivitySince returns the latest durable activity appended after offset.
// PermissionRequest and hook lifecycle records are intentionally ignored:
// Codex emits those before its approval UI, so they do not prove that a tool
// was approved or that a turn ended.
func CodexActivitySince(path string, offset int64) (string, error) {
	if offset < 0 {
		return "", errors.New("transcript offset must not be negative")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return "", err
	}
	if info.Size() <= offset {
		return "", nil
	}
	start := offset
	if info.Size()-start > maxCodexInterruptScanBytes {
		start = info.Size() - maxCodexInterruptScanBytes
	}
	var activity string
	_, err = scanCodexFile(file, start, info.Size(), start > offset, func(line []byte) bool {
		if candidate := codexActivity(line); candidate != "" {
			activity = candidate
		}
		return false
	})
	return activity, err
}

// CodexTurnIDAt returns the latest turn ID recorded at or before offset. The
// scan is deliberately bounded to the tail of the file so lifecycle polling
// stays cheap even for large transcripts.
func CodexTurnIDAt(path string, offset int64) (string, error) {
	if offset < 0 {
		return "", errors.New("transcript offset must not be negative")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return "", err
	}
	end := info.Size()
	if end > offset {
		end = offset
	}
	start := end - maxCodexInterruptScanBytes
	if start < 0 {
		start = 0
	}
	var turnID string
	_, err = scanCodexFile(file, start, end, start > 0, func(line []byte) bool {
		if candidate := codexTurnID(line); candidate != "" {
			turnID = candidate
		}
		return false
	})
	if err != nil {
		return "", err
	}
	return turnID, nil
}

// CodexTurnAbortedSince reports whether Codex appended a turn_aborted event
// for turnID after offset. The scan is deliberately bounded to the tail of the
// file so lifecycle polling stays cheap even for large transcripts.
func CodexTurnAbortedSince(path string, offset int64, turnID string) (bool, error) {
	if offset < 0 {
		return false, errors.New("transcript offset must not be negative")
	}
	if turnID == "" {
		return false, errors.New("turn ID must not be empty")
	}
	file, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return false, err
	}
	if info.Size() <= offset {
		return false, nil
	}
	start := offset
	if info.Size()-start > maxCodexInterruptScanBytes {
		start = info.Size() - maxCodexInterruptScanBytes
	}
	found, err := scanCodexFile(file, start, info.Size(), start > offset, func(line []byte) bool {
		return codexTurnAborted(line, turnID)
	})
	return found, err
}

func scanCodexFile(
	file *os.File,
	start, end int64,
	skipFirstPartialLine bool,
	match func([]byte) bool,
) (bool, error) {
	if end <= start {
		return false, nil
	}
	reader := bufio.NewReaderSize(
		io.NewSectionReader(file, start, end-start), maxCodexInterruptLineBytes,
	)
	if skipFirstPartialLine {
		line, err := readCodexLine(reader)
		if len(line) > 0 && match(line) {
			return true, nil
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return false, nil
			}
			return false, err
		}
	}
	for {
		line, readErr := readCodexLine(reader)
		if len(line) > 0 && match(line) {
			return true, nil
		}
		if errors.Is(readErr, io.EOF) {
			return false, nil
		}
		if readErr != nil {
			return false, readErr
		}
	}
}

func readCodexLine(reader *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		chunk, err := reader.ReadSlice('\n')
		if len(line)+len(chunk) <= maxCodexInterruptLineBytes {
			line = append(line, chunk...)
		} else {
			line = nil
		}
		if err != bufio.ErrBufferFull {
			return line, err
		}
	}
}

func codexTurnID(line []byte) string {
	var record struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if json.Unmarshal(bytes.TrimSpace(line), &record) != nil {
		return ""
	}
	var payload struct {
		TurnID                                 string `json:"turn_id"`
		InternalChatMessageMetadataPassthrough struct {
			TurnID string `json:"turn_id"`
		} `json:"internal_chat_message_metadata_passthrough"`
	}
	if json.Unmarshal(record.Payload, &payload) != nil {
		return ""
	}
	if payload.TurnID != "" {
		return payload.TurnID
	}
	return payload.InternalChatMessageMetadataPassthrough.TurnID
}

func codexTurnAborted(line []byte, turnID string) bool {
	var record struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if json.Unmarshal(bytes.TrimSpace(line), &record) != nil || record.Type != "event_msg" {
		return false
	}
	var payload struct {
		Type   string `json:"type"`
		TurnID string `json:"turn_id"`
	}
	return json.Unmarshal(record.Payload, &payload) == nil &&
		payload.Type == "turn_aborted" && payload.TurnID == turnID
}

func codexActivity(line []byte) string {
	var record struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if json.Unmarshal(bytes.TrimSpace(line), &record) != nil {
		return ""
	}
	if record.Type == "event_msg" {
		var payload struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(record.Payload, &payload) != nil {
			return ""
		}
		switch payload.Type {
		case "task_started":
			return CodexActivityRunning
		case "task_complete", "turn_aborted", "error":
			return CodexActivityWaiting
		case "exec_command_end", "mcp_tool_call_end", "web_search_end",
			"patch_apply_end", "image_generation_end":
			return CodexActivityRunning
		}
		return ""
	}
	if record.Type != "response_item" {
		return ""
	}
	var payload struct {
		Type string `json:"type"`
		Item struct {
			Type string `json:"type"`
		} `json:"item"`
	}
	if json.Unmarshal(record.Payload, &payload) != nil {
		return ""
	}
	if codexRunningOutputType(payload.Type) {
		return CodexActivityRunning
	}
	if payload.Type == "item_completed" && codexRunningOutputType(payload.Item.Type) {
		return CodexActivityRunning
	}
	return ""
}

func codexRunningOutputType(value string) bool {
	switch value {
	case "function_call_output", "custom_tool_call_output", "local_shell_call_output", "tool_search_output":
		return true
	default:
		return false
	}
}
