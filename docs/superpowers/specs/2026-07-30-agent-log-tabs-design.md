# Agent Log Tabs Design

## Summary

Add a compact tab rail to every terminal pane. The existing terminal remains
the default tab, while a new agent-log tab renders the linked Claude Code or
Codex transcript as a readable, live HTML document.

The server reads only the transcript associated with the Euphony terminal's
stored agent session ID. The browser never supplies a filesystem path.

## Research Findings

### Claude Code

- Claude Code stores each message, tool use, and result in a plaintext JSONL
  transcript under `~/.claude/projects/`.
- Hook payloads include `session_id`, `transcript_path`, and `cwd`.
- The observed transcript uses top-level `user` and `assistant` records.
  Message content can be a string or an array containing `text`, `thinking`,
  `tool_use`, and `tool_result` blocks.

Primary references:

- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [Hooks reference](https://code.claude.com/docs/en/hooks)

### Codex

- `CODEX_HOME` defaults to `~/.codex` and contains Codex sessions and logs.
- Session transcripts are stored below `$CODEX_HOME/sessions`; archived
  transcripts are stored below `$CODEX_HOME/archived_sessions`.
- Hook payloads include `session_id` and `transcript_path`, but the transcript
  format is explicitly not a stable hook interface and may change.
- The observed rollout JSONL uses `response_item` records. User and assistant
  messages are `payload.type == "message"` records, while function/custom tool
  calls and outputs use their own payload types.

Primary reference:

- [Codex hooks](https://developers.openai.com/codex/config-advanced#hooks)
- [Codex troubleshooting](https://developers.openai.com/codex/troubleshooting)

## Architecture

### Transcript identity and path safety

Euphony already persists an agent session ID for each terminal. Extend the
hook bridge to capture `transcript_path` and persist it as hidden terminal
metadata.

For a log request, the server:

1. Resolves the terminal by Euphony terminal ID.
2. Chooses the persisted resume agent and agent session ID.
3. Accepts the persisted transcript path only when it resolves below the
   configured Claude or Codex root.
4. Falls back to a bounded root search by exact agent session ID for older
   Euphony sessions that predate transcript-path capture.
5. Opens the transcript read-only.

No route accepts an arbitrary path or agent session ID from the browser.

### Parsing boundary

Create an `internal/agentlog` package with independent Claude and Codex
parsers. Both produce the same transport model:

```go
type Entry struct {
    ID        string `json:"id"`
    Kind      string `json:"kind"`
    Role      string `json:"role,omitempty"`
    Title     string `json:"title,omitempty"`
    Content   string `json:"content,omitempty"`
    Timestamp string `json:"timestamp,omitempty"`
}

type Transcript struct {
    Agent     string  `json:"agent"`
    SessionID string  `json:"sessionId"`
    Entries   []Entry `json:"entries"`
}
```

Supported kinds are `message`, `thinking`, `tool`, and `tool_result`.
Unknown JSONL records and unknown content blocks are skipped. Malformed lines
do not make the rest of the transcript unreadable. Large tool payloads are
truncated at a visible boundary so a single command cannot dominate the UI.

### HTTP refresh

Add:

```text
GET /api/sessions/{terminal-id}/agent-log
```

The endpoint requires the existing bearer token. It returns `404` when the
terminal has no linked agent transcript, and `200` with the normalized
transcript otherwise. An ETag derived from the transcript path, size, and
modification time allows the client to send `If-None-Match`; unchanged polls
return `304`.

The web client polls once per second only while the log tab is visible.
Polling stops when the component unmounts or the terminal tab becomes active.

### Pane composition

Introduce `TerminalPane`, which owns tab state and composes the existing
`TerminalView` with `AgentLogView`.

The terminal stays mounted while hidden so its WebSocket and xterm history are
preserved. Switching back increments a layout version so xterm fits the
visible pane. Each pane remembers its own tab locally.

The rail uses accessible tabs:

```text
┌─[ terminal icon ][ agent-log icon ]────────────────────────────┐
│                                                                │
│  terminal surface or structured agent transcript              │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

The rail is 30px tall, icon-led, keyboard navigable, and visually subordinate
to the pane. The active log tab carries a restrained agent-colored indicator:
coral for Claude and cool green for Codex.

### Log presentation

Use the shadcn `MessageScroller` primitive with `autoScroll` and
`defaultScrollPosition="end"`. Its behavior matches the requirement:

- Initial position is the latest entry.
- New entries remain in view while the reader is at the live edge.
- User scrolling, keyboard scrolling, selection, or other reader interaction
  releases auto-follow.
- A jump-to-latest button appears while the reader is away from the end.

Message text is rendered as Markdown-derived React elements with raw HTML
disabled. User and assistant messages use quiet typographic hierarchy rather
than chat bubbles. Tool calls and results use compact collapsible rows.
Thinking entries are visually muted and collapsed by default.

### Empty and error states

- No linked session: explain that the log will appear after Claude or Codex
  starts in this terminal.
- Transcript not found yet: keep polling and show the linked agent/session
  status without exposing a local path.
- Parse/read failure: show a concise inline error and retry automatically.
- Agent session changes: replace the displayed transcript and return to the
  newest entry.

## Visual Direction

The subject is a local operator console for developers supervising coding
agents. The pane's job is to switch between raw terminal control and a legible
record of agent intent and actions without looking like a separate chat app.

Palette:

- Signal black `#050505`
- Raised black `#0B0D0F`
- Hairline `#262626`
- Paper white `#F5F5F5`
- Instrument gray `#8A8A8A`
- Claude coral `#D97757`
- Codex mint `#A3E635`

Typography keeps the existing Geist face for prose and the existing terminal
monospace stack for timestamps, tool names, and code.

The signature element is the narrow pane-local signal rail: it reads as a
hardware source selector, with the active source indicated by one precise
colored line. The rest stays flat, dense, and undecorated to match Euphony's
flush terminal workspace.

## Testing

- Go unit tests cover Claude and Codex normalization, malformed records,
  truncation, root confinement, and fallback resolution.
- Go handler tests cover authentication-bound terminal lookup, `404`, `200`,
  ETag, and `304`.
- Hook and SQLite tests cover transcript path capture and persistence.
- React tests cover tab switching, terminal mount preservation, polling,
  semantic Markdown output, empty/error states, and latest-entry refresh.
- Playwright verifies pane switching, initial latest position, live follow,
  scroll release, and return-to-latest behavior against an isolated test
  database and fixture transcript.

## Out of Scope

- Editing or deleting transcript files.
- Resuming an agent from the log view.
- Search, filtering, exporting, or cross-session browsing.
- Rendering arbitrary raw HTML from transcripts.
- Archived transcript browsing when it is not linked to an active Euphony
  terminal.
