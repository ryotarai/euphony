package agentlog

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/url"
	"strings"
)

const (
	maxEntryContentBytes = 48 << 10
	maxMediaURLBytes     = 1 << 20
	maxMediaDataBytes    = 1 << 20
)

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
			content, media := normalizeToolResultContent(block["content"], "", timestamp)
			entries = append(entries, Entry{
				Kind: "tool_result", CallID: callID, Title: p.toolNames[callID],
				Content: content, Timestamp: timestamp,
			})
			entries = append(entries, media...)
		case "image", "video":
			if entry, ok := normalizeClaudeMedia(block, rawString(block["type"]), message.Role, timestamp); ok {
				entries = append(entries, entry)
			}
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
		if role == "user" && codexRuntimeInjectedContent(content) {
			return nil
		}
		var entries []Entry
		for _, block := range content {
			switch blockType := rawString(block["type"]); blockType {
			case "input_text", "output_text":
				if text := rawString(block["text"]); strings.TrimSpace(text) != "" {
					entries = append(entries, Entry{
						Kind: "message", Role: role, Content: text, Timestamp: timestamp,
					})
				}
			case "input_image", "output_image", "input_video", "output_video":
				if entry, ok := normalizeCodexMedia(block, blockType, role, timestamp); ok {
					entries = append(entries, entry)
				}
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
		content, media := normalizeToolResultContent(payload["output"], "", timestamp)
		entries := []Entry{{
			Kind: "tool_result", CallID: callID, Title: p.toolNames[callID],
			Content: content, Timestamp: timestamp,
		}}
		return append(entries, media...)
	}
	return nil
}

func normalizeClaudeMedia(
	block map[string]json.RawMessage,
	kind string,
	role string,
	timestamp string,
) (Entry, bool) {
	var source map[string]json.RawMessage
	if json.Unmarshal(block["source"], &source) != nil {
		source = nil
	}
	mimeType := firstMediaRawString(
		block["mime_type"], block["mimeType"],
		source["media_type"], source["mime_type"], source["mimeType"],
	)
	mediaURL := firstMediaRawString(source["url"], block["url"])
	if mediaURL == "" {
		data := rawString(source["data"])
		if data != "" {
			if strings.HasPrefix(strings.TrimSpace(data), "data:") {
				mediaURL = strings.TrimSpace(data)
			} else if mimeType != "" && len(data) <= maxMediaURLBytes {
				mediaURL = "data:" + mimeType + ";base64," + data
			}
		}
	}
	alt := mediaAlt(block, source, kind)
	return newMediaEntry(kind, mediaURL, mimeType, alt, role, timestamp)
}

func normalizeCodexMedia(
	block map[string]json.RawMessage,
	blockType string,
	role string,
	timestamp string,
) (Entry, bool) {
	kind := "image"
	if strings.HasSuffix(blockType, "_video") {
		kind = "video"
	}
	mimeType := firstMediaRawString(block["mime_type"], block["mimeType"])
	mediaURL := firstMediaRawString(
		block["image_url"], block["video_url"], block["url"], block["result"],
	)
	alt := mediaAlt(block, nil, kind)
	return newMediaEntry(kind, mediaURL, mimeType, alt, role, timestamp)
}

func normalizeToolResultContent(
	raw json.RawMessage,
	role string,
	timestamp string,
) (string, []Entry) {
	if text := rawString(raw); text != "" {
		return text, nil
	}
	var blocks []map[string]json.RawMessage
	if json.Unmarshal(raw, &blocks) != nil {
		return formatJSON(raw), nil
	}
	texts := make([]string, 0, len(blocks))
	media := make([]Entry, 0)
	for _, block := range blocks {
		blockType := rawString(block["type"])
		switch blockType {
		case "image", "video":
			if entry, ok := normalizeClaudeMedia(block, blockType, role, timestamp); ok {
				media = append(media, entry)
			}
		case "input_image", "output_image", "input_video", "output_video":
			if entry, ok := normalizeCodexMedia(block, blockType, role, timestamp); ok {
				media = append(media, entry)
			}
		default:
			if text := rawString(block["text"]); strings.TrimSpace(text) != "" {
				texts = append(texts, text)
			}
		}
	}
	return strings.Join(texts, "\n"), media
}

func newMediaEntry(
	kind string,
	mediaURL string,
	mimeType string,
	alt string,
	role string,
	timestamp string,
) (Entry, bool) {
	mediaURL, mimeType, ok := validateMediaURL(mediaURL, kind, mimeType)
	if !ok {
		return Entry{}, false
	}
	return Entry{
		Kind: kind, Role: role, URL: mediaURL, MimeType: mimeType,
		Alt: alt, Timestamp: timestamp,
	}, true
}

func validateMediaURL(mediaURL, kind, hintedMimeType string) (string, string, bool) {
	mediaURL = strings.TrimSpace(mediaURL)
	if mediaURL == "" || len(mediaURL) > maxMediaURLBytes {
		return "", "", false
	}
	hintedMimeType, ok := validateMediaType(hintedMimeType, kind)
	if !ok {
		return "", "", false
	}
	if strings.HasPrefix(mediaURL, "data:") {
		return validateDataMediaURL(mediaURL, kind, hintedMimeType)
	}
	parsed, err := url.Parse(mediaURL)
	if err != nil || parsed.Host == "" || parsed.User != nil ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", "", false
	}
	return mediaURL, hintedMimeType, true
}

func validateDataMediaURL(mediaURL, kind, hintedMimeType string) (string, string, bool) {
	metadataAndData := strings.TrimPrefix(mediaURL, "data:")
	separator := strings.IndexByte(metadataAndData, ',')
	if separator <= 0 {
		return "", "", false
	}
	metadata := metadataAndData[:separator]
	data := metadataAndData[separator+1:]
	parts := strings.Split(metadata, ";")
	if len(parts) < 2 || parts[len(parts)-1] != "base64" || data == "" {
		return "", "", false
	}
	mediaType, ok := validateMediaType(parts[0], kind)
	if !ok {
		return "", "", false
	}
	if hintedMimeType != "" && !sameMediaFamily(hintedMimeType, mediaType) {
		return "", "", false
	}
	if len(data) > maxMediaURLBytes {
		return "", "", false
	}
	decoded, err := base64.StdEncoding.DecodeString(data)
	if err != nil || len(decoded) == 0 || len(decoded) > maxMediaDataBytes {
		return "", "", false
	}
	return mediaURL, mediaType, true
}

func validateMediaType(value, kind string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", true
	}
	parsed, _, err := mime.ParseMediaType(value)
	if err != nil {
		return "", false
	}
	parsed = strings.ToLower(parsed)
	if !strings.HasPrefix(parsed, kind+"/") {
		return "", false
	}
	return parsed, true
}

func sameMediaFamily(left, right string) bool {
	return strings.HasPrefix(left, "image/") && strings.HasPrefix(right, "image/") ||
		strings.HasPrefix(left, "video/") && strings.HasPrefix(right, "video/")
}

func mediaAlt(
	block map[string]json.RawMessage,
	source map[string]json.RawMessage,
	kind string,
) string {
	alt := firstMediaRawString(
		block["alt"], block["description"], block["name"], block["filename"],
		source["alt"], source["description"], source["name"], source["filename"],
	)
	if strings.TrimSpace(alt) != "" {
		return strings.TrimSpace(alt)
	}
	if kind == "video" {
		return "Video attachment"
	}
	return "Image attachment"
}

func firstMediaRawString(values ...json.RawMessage) string {
	for _, value := range values {
		if text := rawString(value); text != "" {
			return text
		}
	}
	return ""
}

func codexRuntimeInjectedContent(content []map[string]json.RawMessage) bool {
	for _, block := range content {
		if rawString(block["type"]) != "input_text" {
			continue
		}
		if isCompletePayload(rawString(block["text"]), "<environment_context>", "</environment_context>") {
			return true
		}
		text := rawString(block["text"])
		heading := "# AGENTS.md instructions for "
		start := strings.Index(text, heading)
		if start < 0 {
			continue
		}
		remainder := text[start+len(heading):]
		if isCompletePayload(remainder, "<INSTRUCTIONS>", "</INSTRUCTIONS>") {
			return true
		}
	}
	return false
}

func isCompletePayload(text, opening, closing string) bool {
	start := strings.Index(text, opening)
	if start < 0 {
		return false
	}
	return strings.Index(text[start+len(opening):], closing) >= 0
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
