package agentlog

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

const maxEntryContentBytes = 48 << 10

type parser struct {
	agent     string
	toolNames map[string]string
}

func Parse(agent string, reader io.Reader) ([]Entry, error) {
	return parse(agent, reader, 0, func(lineNumber int, _ int64, index int) string {
		return fmt.Sprintf("%d-%d", lineNumber, index)
	})
}

func ParseAt(agent string, reader io.Reader, startOffset int64) ([]Entry, error) {
	return parse(agent, reader, startOffset, func(_ int, lineOffset int64, index int) string {
		return fmt.Sprintf("%d-%d", lineOffset, index)
	})
}

func parse(
	agent string,
	reader io.Reader,
	startOffset int64,
	entryID func(lineNumber int, lineOffset int64, index int) string,
) ([]Entry, error) {
	if agent != "claude" && agent != "codex" {
		return nil, fmt.Errorf("unsupported agent %q", agent)
	}
	state := parser{agent: agent, toolNames: make(map[string]string)}
	buffered := bufio.NewReaderSize(reader, 64<<10)
	entries := make([]Entry, 0)
	lineNumber := 0
	lineOffset := startOffset
	for {
		line, readErr := buffered.ReadBytes('\n')
		if len(line) == 0 && errors.Is(readErr, io.EOF) {
			break
		}
		lineNumber++
		var record map[string]json.RawMessage
		if json.Unmarshal(bytes.TrimSuffix(line, []byte{'\n'}), &record) == nil {
			var parsed []Entry
			if agent == "claude" {
				parsed = state.parseClaude(record)
			} else {
				parsed = state.parseCodex(record)
			}
			for index := range parsed {
				parsed[index].ID = entryID(lineNumber, lineOffset, index)
				if parsed[index].Kind == "tool" || parsed[index].Kind == "tool_result" {
					parsed[index].Content = truncateContent(parsed[index].Content)
				}
				entries = append(entries, parsed[index])
			}
		}
		lineOffset += int64(len(line))
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			return nil, fmt.Errorf("read transcript: %w", readErr)
		}
	}
	return entries, nil
}

func (p *parser) parseClaude(record map[string]json.RawMessage) []Entry {
	if rawBool(record["isMeta"]) {
		return nil
	}
	recordType := rawString(record["type"])
	if recordType != "user" && recordType != "assistant" {
		return nil
	}
	var message struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(record["message"], &message) != nil {
		return nil
	}
	timestamp := rawString(record["timestamp"])
	if len(message.Content) == 0 {
		return nil
	}
	var plain string
	if json.Unmarshal(message.Content, &plain) == nil {
		if strings.TrimSpace(plain) == "" {
			return nil
		}
		return []Entry{{
			Kind: "message", Role: message.Role, Content: plain, Timestamp: timestamp,
		}}
	}
	var blocks []map[string]json.RawMessage
	if json.Unmarshal(message.Content, &blocks) != nil {
		return nil
	}
	entries := make([]Entry, 0, len(blocks))
	for _, block := range blocks {
		switch rawString(block["type"]) {
		case "text":
			if text := rawString(block["text"]); strings.TrimSpace(text) != "" {
				entries = append(entries, Entry{
					Kind: "message", Role: message.Role, Content: text, Timestamp: timestamp,
				})
			}
		case "thinking":
			if text := rawString(block["thinking"]); strings.TrimSpace(text) != "" {
				entries = append(entries, Entry{
					Kind: "thinking", Role: message.Role, Content: text, Timestamp: timestamp,
				})
			}
		case "tool_use":
			callID := rawString(block["id"])
			name := rawString(block["name"])
			if callID != "" {
				p.toolNames[callID] = name
			}
			entries = append(entries, Entry{
				Kind: "tool", CallID: callID, Title: name, Content: formatJSON(block["input"]), Timestamp: timestamp,
			})
		case "tool_result":
			callID := rawString(block["tool_use_id"])
			entries = append(entries, Entry{
				Kind: "tool_result", CallID: callID, Title: p.toolNames[callID],
				Content: textContent(block["content"]), Timestamp: timestamp,
			})
		}
	}
	return entries
}

func (p *parser) parseCodex(record map[string]json.RawMessage) []Entry {
	if rawString(record["type"]) != "response_item" {
		return nil
	}
	var payload map[string]json.RawMessage
	if json.Unmarshal(record["payload"], &payload) != nil {
		return nil
	}
	timestamp := rawString(record["timestamp"])
	switch rawString(payload["type"]) {
	case "message":
		role := rawString(payload["role"])
		if role != "user" && role != "assistant" {
			return nil
		}
		var content []map[string]json.RawMessage
		if json.Unmarshal(payload["content"], &content) != nil {
			return nil
		}
		var entries []Entry
		for _, block := range content {
			blockType := rawString(block["type"])
			if blockType != "input_text" && blockType != "output_text" {
				continue
			}
			if text := rawString(block["text"]); strings.TrimSpace(text) != "" {
				entries = append(entries, Entry{
					Kind: "message", Role: role, Content: text, Timestamp: timestamp,
				})
			}
		}
		return entries
	case "reasoning":
		var summaries []map[string]json.RawMessage
		if json.Unmarshal(payload["summary"], &summaries) != nil {
			return nil
		}
		var entries []Entry
		for _, summary := range summaries {
			if text := rawString(summary["text"]); strings.TrimSpace(text) != "" {
				entries = append(entries, Entry{
					Kind: "thinking", Role: "assistant", Content: text, Timestamp: timestamp,
				})
			}
		}
		return entries
	case "function_call", "custom_tool_call":
		callID := rawString(payload["call_id"])
		name := rawString(payload["name"])
		if callID != "" {
			p.toolNames[callID] = name
		}
		content := payload["arguments"]
		if len(content) == 0 {
			content = payload["input"]
		}
		return []Entry{{
			Kind: "tool", CallID: callID, Title: name, Content: formatJSON(content), Timestamp: timestamp,
		}}
	case "function_call_output", "custom_tool_call_output":
		callID := rawString(payload["call_id"])
		return []Entry{{
			Kind: "tool_result", CallID: callID, Title: p.toolNames[callID],
			Content: textContent(payload["output"]), Timestamp: timestamp,
		}}
	}
	return nil
}

func rawString(raw json.RawMessage) string {
	var value string
	_ = json.Unmarshal(raw, &value)
	return value
}

func rawBool(raw json.RawMessage) bool {
	var value bool
	_ = json.Unmarshal(raw, &value)
	return value
}

func textContent(raw json.RawMessage) string {
	if text := rawString(raw); text != "" {
		return text
	}
	var blocks []map[string]json.RawMessage
	if json.Unmarshal(raw, &blocks) == nil {
		var texts []string
		for _, block := range blocks {
			if text := rawString(block["text"]); text != "" {
				texts = append(texts, text)
			}
		}
		return strings.Join(texts, "\n")
	}
	return formatJSON(raw)
}

func formatJSON(raw json.RawMessage) string {
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return ""
	}
	value := raw
	if decoded := rawString(raw); decoded != "" {
		trimmed := strings.TrimSpace(decoded)
		if !strings.HasPrefix(trimmed, "{") && !strings.HasPrefix(trimmed, "[") {
			return decoded
		}
		value = []byte(trimmed)
	}
	var output bytes.Buffer
	if json.Indent(&output, value, "", "  ") == nil {
		return output.String()
	}
	return string(raw)
}

func truncateContent(content string) string {
	if len(content) <= maxEntryContentBytes {
		return content
	}
	suffix := "\n\n[output truncated]"
	limit := maxEntryContentBytes - len(suffix)
	for limit > 0 && !utf8Boundary(content[limit]) {
		limit--
	}
	return content[:limit] + suffix
}

func utf8Boundary(value byte) bool {
	return value&0xc0 != 0x80
}
