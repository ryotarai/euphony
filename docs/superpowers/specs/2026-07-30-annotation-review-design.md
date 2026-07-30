# Annotation Review Design

## Summary

Add a transient review workflow that lets a Codex or Claude process open a
local Markdown or HTML file in the third tab of its Euphony terminal pane,
wait while the user annotates it, and receive the submitted comments as
structured JSON on standard output.

The primary interaction is:

```text
euphony annotate path/to/document.md
```

The command requires `EUPHONY_TERMINAL_ID`, reads the file once, creates an
annotation session through the existing local API, and blocks until the user
submits comments. The command then prints one stable v1 success envelope and
exits with status 0.

## Goals

- Display Markdown and HTML inside the terminal pane that launched the
  command.
- Add an Annotation source as the third pane-local tab only while a review is
  active.
- Automatically switch the target pane to a newly created annotation.
- Let the user attach a comment to selected text or add a global comment.
- Return all submitted comments to the waiting process as stable JSON.
- Install a small Codex/Claude skill that teaches agents when and how to use
  the command.
- Keep local HTML inert: scripts, event handlers, forms, embeds, and unsafe
  URLs must not execute.

## Non-goals

- Persisting reviews across Euphony server restarts.
- Editing the source document from Euphony.
- Supporting binary, PDF, image, or remote URL inputs.
- Resolving comments, threaded replies, authorship, or multi-user review.
- Maintaining annotations after the waiting CLI has received the result.
- Mapping rendered text selections back to exact Markdown or HTML source
  syntax.

## Architecture

### Transient annotation store

Create an `internal/annotation` package that owns active sessions in memory.
Each session contains:

```go
type Session struct {
    ID         string    `json:"id"`
    TerminalID string    `json:"terminalId"`
    Filename   string    `json:"filename"`
    Format     string    `json:"format"`
    Content    string    `json:"content"`
    CreatedAt  time.Time `json:"createdAt"`
}
```

Only one active annotation may exist per terminal. Creating another returns a
409 `annotation_active` error instead of replacing a review whose CLI is
still waiting.

The store has separate create, lookup, complete, cancel, and wait operations.
Waiters receive exactly one immutable result. Completion removes the session
from the active terminal index but retains the result until the creator
consumes it. A canceled request wakes its waiter with a typed cancellation
error.

The server process is the lifecycle boundary. Restarting Euphony cancels all
active reviews, which is acceptable for this interactive workflow.

### HTTP API

Add bearer-authenticated v1 endpoints:

```text
POST   /api/v1/annotations
GET    /api/v1/terminals/{terminal-id}/annotation
GET    /api/v1/annotations/{annotation-id}/wait
POST   /api/v1/annotations/{annotation-id}/complete
DELETE /api/v1/annotations/{annotation-id}
```

Create accepts:

```json
{
  "terminalId": "terminal-id",
  "filename": "proposal.md",
  "format": "markdown",
  "content": "# Proposal"
}
```

The terminal must exist. `format` must be `markdown` or `html`, the filename
must be non-empty, and UTF-8 content must not exceed 1 MiB. The API never
accepts or reads a filesystem path.

The current-annotation endpoint returns `{ "annotation": null }` when the
terminal has no active review so the browser can initialize without treating
the normal state as an error.

Complete accepts an ordered comments array. Each comment is either:

```json
{
  "kind": "selection",
  "body": "Clarify this claim.",
  "quote": "selected rendered text",
  "startOffset": 42,
  "endOffset": 64
}
```

or:

```json
{
  "kind": "global",
  "body": "The overall structure works."
}
```

Bodies must be non-empty after trimming. Selection comments require a
non-empty quote and non-negative ordered offsets. The result returned by wait
contains the annotation ID and the same ordered comments.

Create, complete, and cancel publish `annotation.created`,
`annotation.completed`, and `annotation.canceled` on the existing v1 event
stream. Event data contains identifiers and terminal ID, never document
content.

### CLI

`euphony annotate FILE` is a finite-but-blocking automation command. It:

1. Requires `EUPHONY_TERMINAL_ID`.
2. Resolves and reads `FILE` from the process working directory.
3. Accepts only `.md`, `.markdown`, `.html`, and `.htm` extensions.
4. Rejects invalid UTF-8 and files larger than 1 MiB before contacting the
   API.
5. Creates the review through the normal Unix-socket-first API client.
6. Waits until completion or cancellation.
7. Prints one success envelope:

```json
{
  "ok": true,
  "result": {
    "annotationId": "annotation-id",
    "path": "/absolute/path/to/document.md",
    "comments": []
  }
}
```

On SIGINT or context cancellation, the command best-effort deletes the active
annotation before exiting. API and usage errors use the existing stable error
envelopes on stderr.

### Browser synchronization

The app increments an annotation revision when it receives any annotation
event. Each `TerminalPane` fetches its current annotation on mount and when
that revision changes.

When a pane receives a different non-null annotation ID, it automatically
selects the third tab. Terminal and agent-log surfaces remain mounted, so the
existing PTY and transcript behavior is preserved. Completing or canceling a
review removes the third tab and returns the pane to Terminal.

Opening a browser after the command has already started works because every
pane performs an initial current-annotation fetch.

## Annotation UI

### Layout

`AnnotationView` uses a flat document surface and a comment rail:

```text
┌─────────────────────────────────────┬──────────────────────┐
│ filename                            │ Comments             │
│                                     │                      │
│ rendered Markdown or safe HTML      │ selected quote       │
│                                     │ comment editor       │
│                                     │ saved comments       │
│                                     │                      │
│                                     │ [Send comments]      │
└─────────────────────────────────────┴──────────────────────┘
```

At pane widths below 720px the comment rail becomes a lower section and the
document remains the primary scroll region. The design keeps Euphony's black
operator-console palette, hairline separators, Geist typography, and lime
signal color. Comments use amber accents so they remain distinct from Codex
and Claude status colors.

### Rendering and selection

Markdown uses `react-markdown` with `remark-gfm`; raw HTML in Markdown is not
enabled. HTML uses DOMPurify with an allowlist that removes active content,
forms, embedded resources, inline style, and unsafe URL schemes before
`dangerouslySetInnerHTML`.

On selection inside the document root, the browser records:

- normalized selected text as `quote`;
- a UTF-16 `startOffset` and `endOffset` measured across the rendered root's
  text content.

The offsets are hints into the rendered representation. The quote is the
authoritative anchor agents should use when locating the source.

After selection, the comment rail displays the quote and focuses the comment
editor. Adding the comment clears the selection draft. A separate global
comment action is always available. Comments can be removed before submission.

`Send comments` is enabled with zero comments so the user can explicitly
approve without feedback. While submission is in progress, editing controls
are disabled. A failed submission keeps all drafts and shows an inline retry
message.

## Agent Skill

`euphony setup` installs the same English `euphony-annotate` skill for each
detected agent:

- Codex: `$CODEX_HOME/skills/euphony-annotate/SKILL.md`
- Claude: `$CLAUDE_CONFIG_DIR/skills/euphony-annotate/SKILL.md`

The skill tells the agent to use `euphony annotate <file>` when it has produced
a Markdown or HTML artifact that benefits from human review, to wait for the
command to finish, and to use the returned JSON comments before continuing.
Installation is idempotent and preserves all unrelated agent configuration.

## Error Handling

- Missing terminal environment: CLI `invalid_request`.
- Unsupported extension or invalid UTF-8: CLI `invalid_request`.
- Missing terminal: API `terminal_not_found`.
- Concurrent review in one terminal: API `annotation_active`.
- Unknown or already-finished annotation: API `annotation_not_found`.
- Invalid comments: API `invalid_request`.
- Browser fetch failure: third-tab discovery retries on the next event and
  exposes a quiet pane-local error only when an annotation was already shown.
- Submission failure: comments remain editable and the user can retry.
- CLI disconnection: best-effort cancellation prevents a stale third tab.

## Testing

- Annotation store tests cover one-active-per-terminal, wait/complete,
  cancellation, duplicate completion, immutable results, and context
  cancellation.
- Server tests cover authentication, validation, terminal ownership, the
  current lookup, completion, cancellation, and event publication.
- API client and CLI tests cover Markdown/HTML format inference, invalid files,
  terminal environment requirements, blocking completion, stdout envelopes,
  and cancellation cleanup over both normal HTTP and the existing Unix-socket
  transport suite.
- React tests cover initial discovery, third-tab appearance and auto-selection,
  Markdown rendering, HTML sanitization, selection anchoring, global comments,
  removal, empty approval, submission retry, and terminal mount preservation.
- Playwright starts Euphony with an isolated SQLite database, launches
  `euphony annotate` in a terminal, comments on selected text, adds a global
  comment, submits, and asserts the terminal receives the structured output.

## Security and Limits

- Document content is limited to 1 MiB at both CLI and server boundaries.
- The API accepts content, never a path, so it cannot read arbitrary server
  files.
- HTML active content is removed before insertion.
- Document links open in a new tab with `noopener noreferrer`.
- Comments share the existing 1 MiB v1 request-body limit.
- Annotation content is omitted from event payloads and logs.
