package agenthook

import (
	"bytes"
	"encoding/json"
	"os"
)

// transcriptTailBytes bounds how much of a transcript is inspected. Claude Code
// re-emits its ai-title entry every turn, so the newest one is always near the
// end of the file, and transcripts themselves grow to tens of megabytes.
const transcriptTailBytes = 1 << 20

// transcriptTitle returns the newest session title recorded in a Claude Code
// transcript. Hook payloads carry only transcript_path, so the title has to be
// read back out of the transcript itself.
func transcriptTitle(path string) string {
	if path == "" {
		return ""
	}
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return ""
	}
	offset := max(info.Size()-transcriptTailBytes, 0)
	tail := make([]byte, info.Size()-offset)
	if _, err := file.ReadAt(tail, offset); err != nil {
		return ""
	}
	lines := bytes.Split(tail, []byte("\n"))
	if offset > 0 && len(lines) > 0 {
		// The window starts mid-line unless it starts at the beginning.
		lines = lines[1:]
	}
	for index := len(lines) - 1; index >= 0; index-- {
		var entry struct {
			Type    string `json:"type"`
			AITitle string `json:"aiTitle"`
		}
		if json.Unmarshal(lines[index], &entry) != nil {
			continue
		}
		if entry.Type == "ai-title" && entry.AITitle != "" {
			return entry.AITitle
		}
	}
	return ""
}
