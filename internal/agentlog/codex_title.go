package agentlog

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
)

const maxCodexTitleScanBytes = 1 << 20

// CodexThreadTitle returns the latest automatic title update recorded in a
// Codex rollout transcript. Codex writes explicit renames to session_index,
// while automatically generated names can arrive only as transcript events.
// The scan is bounded because transcripts can grow very large.
func CodexThreadTitle(path, sessionID string) (string, error) {
	return readCodexThreadTitle(path, sessionID, false)
}

// CodexThreadTitleFromStart performs one bounded header scan for a restored
// session. Automatic naming is usually recorded near session startup, before
// the transcript grows beyond the tail window used by normal polling.
func CodexThreadTitleFromStart(path, sessionID string) (string, error) {
	return readCodexThreadTitle(path, sessionID, true)
}

func readCodexThreadTitle(path, sessionID string, fromStart bool) (string, error) {
	if path == "" || sessionID == "" {
		return "", nil
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
	start, end := int64(0), info.Size()
	if fromStart {
		if end > maxCodexTitleScanBytes {
			end = maxCodexTitleScanBytes
		}
	} else {
		start = end - maxCodexTitleScanBytes
		if start < 0 {
			start = 0
		}
	}
	var title string
	_, err = scanCodexFile(file, start, end, start > 0, func(line []byte) bool {
		if candidate := codexThreadTitle(line, sessionID); candidate != "" {
			title = candidate
		}
		return false
	})
	return title, err
}

func codexThreadTitle(line []byte, sessionID string) string {
	var record struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if json.Unmarshal(bytes.TrimSpace(line), &record) != nil || record.Type != "event_msg" {
		return ""
	}
	var payload struct {
		Type       string `json:"type"`
		ThreadID   string `json:"thread_id"`
		ThreadName string `json:"thread_name"`
	}
	if json.Unmarshal(record.Payload, &payload) != nil ||
		payload.Type != "thread_name_updated" || payload.ThreadID != sessionID {
		return ""
	}
	return strings.TrimSpace(payload.ThreadName)
}
