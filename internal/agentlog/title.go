package agentlog

import (
	"bytes"
	"encoding/json"
	"os"
)

// titleTailBytes bounds how much of a transcript is inspected. Claude Code
// re-emits its title entries every turn, so the newest ones are always near the
// end of the file, and transcripts themselves grow to tens of megabytes.
const titleTailBytes = 1 << 20

// ClaudeTranscriptTitle returns the newest session title recorded in a Claude
// Code transcript. Hook payloads carry only transcript_path, so the title has to
// be read back out of the transcript itself.
//
// A `/rename` is recorded as a custom-title entry while Claude Code's own guess
// is an ai-title entry, and the rename never clears the guess. Claude Code
// resolves the pair the same way, so a rename outranks a generated title
// regardless of which entry was appended last.
func ClaudeTranscriptTitle(path string) string {
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
	offset := max(info.Size()-titleTailBytes, 0)
	tail := make([]byte, info.Size()-offset)
	if _, err := file.ReadAt(tail, offset); err != nil {
		return ""
	}
	lines := bytes.Split(tail, []byte("\n"))
	if offset > 0 && len(lines) > 0 {
		// The window starts mid-line unless it starts at the beginning.
		lines = lines[1:]
	}
	// Both entry types are last-wins, so only the newest of each counts: an
	// entry that names an empty title retires the older ones rather than
	// deferring to them.
	var renamed, generated string
	var sawRenamed, sawGenerated bool
	for index := len(lines) - 1; index >= 0 && !(sawRenamed && sawGenerated); index-- {
		var entry struct {
			Type        string `json:"type"`
			CustomTitle string `json:"customTitle"`
			AITitle     string `json:"aiTitle"`
		}
		if json.Unmarshal(lines[index], &entry) != nil {
			continue
		}
		switch entry.Type {
		case "custom-title":
			if !sawRenamed {
				renamed, sawRenamed = entry.CustomTitle, true
			}
		case "ai-title":
			if !sawGenerated {
				generated, sawGenerated = entry.AITitle, true
			}
		}
	}
	if renamed != "" {
		return renamed
	}
	return generated
}
