package agentsummary

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"

	"github.com/ryotarai/euphony/internal/agentlog"
	"github.com/ryotarai/euphony/internal/session"
)

const (
	maxTerminalContextBytes   = 24 << 10
	maxTranscriptContextBytes = 64 << 10
	maxTranscriptEntries      = 40
	maxPromptBytes            = 128 << 10
	maxGeneratedSummaryRunes  = 1200
	maxGeneratedActionRunes   = 600
)

var ansiSequence = regexp.MustCompile(`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))`)

func BuildPrompt(metadata session.Metadata, entries []agentlog.Entry, terminalTail []byte) string {
	transcript := formatTranscript(entries)
	if len(transcript) > maxTranscriptContextBytes {
		transcript = transcript[len(transcript)-maxTranscriptContextBytes:]
	}
	terminal := sanitizeTerminalText(string(terminalTail))
	if len(terminal) > maxTerminalContextBytes {
		terminal = terminal[len(terminal)-maxTerminalContextBytes:]
	}
	prompt := fmt.Sprintf(`You are an assistant for a local terminal workspace. Summarize what one coding agent is doing right now for a human who is monitoring several terminals.

Return exactly one JSON object and no markdown:
{"summary":"what the agent is doing now","action":"what the user should do next, or an empty string","priority":"high, medium, low, or an empty string"}

Rules:
- Keep summary concrete and short. Mention the current goal, file, command, or blocker when the context supports it.
- For running agents, action must be an empty string.
- For running agents, priority must be an empty string.
- For waiting or blocked agents, action must describe the user's next action in plain language and priority must be exactly high, medium, or low based on the urgency and impact of that action.
- Priority describes the user's action urgency, not the agent lifecycle status. Use high for blocking or time-sensitive decisions, medium for important but non-blocking work, and low for routine follow-up.
- Do not invent details that are absent from the context. Say that context is unavailable when necessary.

Session name: %s
Agent: %s
Agent status: %s
Agent title: %s
Working directory: %s

Recent agent transcript:
%s

Terminal output tail:
%s
`, metadata.Name, metadata.Agent, metadata.AgentStatus, metadata.AgentTitle, metadata.CWD, transcript, terminal)
	if len(prompt) <= maxPromptBytes {
		return prompt
	}
	return prompt[:maxPromptBytes]
}

func formatTranscript(entries []agentlog.Entry) string {
	if len(entries) > maxTranscriptEntries {
		entries = entries[len(entries)-maxTranscriptEntries:]
	}
	var builder strings.Builder
	for _, entry := range entries {
		builder.WriteString("- ")
		if entry.Role != "" {
			builder.WriteString(entry.Role)
			builder.WriteByte(' ')
		}
		builder.WriteString(entry.Kind)
		if entry.Title != "" {
			builder.WriteString(" / ")
			builder.WriteString(entry.Title)
		}
		builder.WriteByte('\n')
		if entry.Content != "" {
			builder.WriteString(sanitizeTerminalText(entry.Content))
			builder.WriteByte('\n')
		}
		for _, nested := range entry.Entries {
			builder.WriteString("  - ")
			builder.WriteString(nested.Kind)
			if nested.Title != "" {
				builder.WriteString(" / ")
				builder.WriteString(nested.Title)
			}
			builder.WriteByte('\n')
			if nested.Content != "" {
				builder.WriteString("    ")
				builder.WriteString(sanitizeTerminalText(nested.Content))
				builder.WriteByte('\n')
			}
		}
	}
	if builder.Len() == 0 {
		return "(no transcript available)"
	}
	return builder.String()
}

func sanitizeTerminalText(value string) string {
	value = ansiSequence.ReplaceAllString(value, "")
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' || !unicode.IsControl(r) {
			return r
		}
		return -1
	}, value)
}
