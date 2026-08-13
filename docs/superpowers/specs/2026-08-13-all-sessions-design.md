# All Sessions Design

## Goal

Add an `All sessions` entry above `Settings` in the sidebar. It opens a large
modal containing every Euphony terminal and discoverable Codex or Claude Code
session, sorted by most recent activity. The modal supports incremental search
over the session title, purpose, summary, working directory, project, and agent.
Selecting an existing Euphony terminal focuses it; selecting a discovered
agent session creates a terminal and resumes it with the matching CLI.

## User experience

The sidebar footer order is:

1. New terminal (legacy non-project workspace only)
2. All sessions
3. Settings

`All sessions` is available in both desktop and mobile navigation. On mobile,
opening the modal closes the drawer first. The dialog is approximately 80% of
the viewport (`min(82vw, 82rem)` wide and `min(82vh, 56rem)` tall), but remains
usable on small screens by falling back to nearly full width and height.

The modal has a compact header with the title and result count, one autofocus
search field, and a scrollable result list. Each row shows:

- agent or terminal identity and the purpose/title;
- the latest summary, when one exists;
- project and working-directory metadata;
- relative/update time and whether the item is currently open or will resume.

The list is filtered on every keystroke. Search matching is case-insensitive
and whitespace-normalized. Empty results distinguish “no sessions exist” from
“no sessions match this search”. Rows are keyboard-focusable buttons, and the
resume row shows a busy state while the new terminal is being created.

The visual direction follows Euphony's existing terminal workspace: graphite
surfaces (`#111417`, `#1b2026`), pale text (`#dce5e8`), muted blue-grey metadata
(`#829099`), and the lime interaction accent (`#b8f34a`). The signature detail
is a narrow lime activity rail on each result row; status and metadata stay
quiet so the latest-update ordering remains the primary visual signal.

## Data model and API

The browser receives an `AllSession` record:

```ts
interface AllSession {
  id: string;
  terminalId?: string;
  agent?: "codex" | "claude";
  sessionId?: string;
  title: string;
  purpose?: string;
  summary?: string;
  cwd: string;
  project?: string;
  updatedAt: string;
  state: "open" | "resume";
}
```

`GET /api/all-sessions` returns a snapshot. The server merges current
Euphony terminals with agent transcript history. Current terminal metadata and
the latest persisted Euphony agent summary win for matching agent/session
records. Plain terminals are included even though they have no agent session
ID.

The history reader uses the configured Codex sessions root and Claude projects
root. It reads bounded transcript windows, never loads a full large transcript
just to render the list, and derives a useful fallback purpose from the first
user message and a fallback summary from the newest assistant message. Codex
titles and update times come from `session_index.jsonl` when available, with
the transcript as a fallback. Claude titles use the existing custom-title over
ai-title precedence. A missing or unreadable history file is skipped without
breaking the current terminal list.

`POST /api/all-sessions/{agent}/{sessionID}/resume` accepts a selection mode
(`none`, `add`, or `replace`; the UI uses `replace`). It reuses an already
managed terminal when the agent/session pair is open. Otherwise it validates
the agent and session record, chooses its recorded existing directory (or the
user home directory when unavailable), starts the allow-listed command with
arguments (`codex resume <id>` or `claude --resume <id>`), and returns the new
terminal plus the resulting selection snapshot. It never interpolates the
session ID into shell source.

## Failure handling

- A history scan failure returns an API error only when both current metadata
  and the history scan cannot be produced; individual malformed records are
  ignored.
- A resume request for an unknown, unsafe, or unsupported session returns a
  clear 404/400 error and leaves the modal open.
- Resume errors are shown in the modal and do not replace the existing terminal
  selection.
- If a history entry disappears between listing and clicking, the user can
  refresh the modal and the stale row is removed.

## Testing

- Agent-log tests cover Codex index/transcript discovery, Claude discovery,
  bounded fallback text, malformed records, and update ordering.
- Server tests cover the list endpoint, current/history merging, safe resume
  command arguments, reuse of an already-open session, and selection handling.
- API tests cover the browser client's list and resume requests.
- Component tests cover the footer placement, modal sizing class, incremental
  search fields, newest-first ordering, empty states, and click callbacks.
- App tests cover opening an existing terminal and resuming a history-only
  session into the focused pane.
- The full Go suite, web typecheck/build, Vitest suite, and targeted Playwright
  coverage are run before merge.
