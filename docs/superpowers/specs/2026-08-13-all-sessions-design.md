# All Sessions Design

## Goal

Add an `All sessions` entry above `Settings` in the sidebar. It opens a large
modal containing the Codex or Claude Code sessions known to Euphony's database,
including agent terminals whose processes have exited, sorted by most recent
activity. The modal supports incremental search over the session title, purpose,
summary, working directory, project, and agent. Selecting an open Euphony
terminal focuses it; selecting an exited agent session creates a terminal and
resumes it with the matching CLI.

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

`GET /api/all-sessions` returns a snapshot from Euphony's persisted terminal
metadata and persisted agent summaries. Only records with a supported agent and
agent session ID are included; plain terminals and sessions that exist only in
Codex or Claude transcript directories are excluded. The server merges an open
and an exited database record for the same agent/session pair, preferring the
open terminal.

When a terminal process exits, Euphony keeps its final metadata in the database
with `state: "exited"`, exit information, and the agent/session identity. This
record is not restored as a live terminal on startup, but remains available to
the All sessions index and can be resumed.

`POST /api/all-sessions/{agent}/{sessionID}/resume` accepts a selection mode
(`none`, `add`, or `replace`; the UI uses `replace`). It reuses an already
managed terminal when the agent/session pair is open. Otherwise it validates a
matching exited database record, chooses its recorded existing directory (or
the user home directory when unavailable), starts the allow-listed command with
arguments (`codex resume <id>` or `claude --resume <id>`), and returns the new
terminal plus the resulting selection snapshot. It never interpolates the
session ID into shell source.

## Failure handling

- A database read or project lookup failure returns a clear API error without
  attempting a transcript-directory scan.
- A resume request for an unknown, unsafe, or unsupported session returns a
  clear 404/400 error and leaves the modal open.
- Resume errors are shown in the modal and do not replace the existing terminal
  selection.
- If a saved database record disappears between listing and clicking, the user
  can refresh the modal and the stale row is removed.

## Testing

- Session tests cover retaining exited metadata in SQLite and keeping it out of
  live terminal restoration.
- Server tests cover the DB-only list endpoint, open/exited merging, safe resume
  command arguments, reuse of an already-open session, and selection handling.
- API tests cover the browser client's list and resume requests.
- Component tests cover the footer placement, modal sizing class, incremental
  search fields, newest-first ordering, empty states, and click callbacks.
- App tests cover opening an existing terminal and resuming an exited database
  session into the focused pane.
- The full Go suite, web typecheck/build, Vitest suite, and targeted Playwright
  coverage are run before merge.
