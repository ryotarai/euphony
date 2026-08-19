# Kanban View Design

## Goal

Add a Kanban view for agent sessions that lets users understand what needs
attention at a glance, move sessions out of the sidebar when they are no
longer relevant, and restore them from All sessions without losing the saved
agent session.

## Cognitive model

The board uses four stable columns in this order:

1. **Running** — the agent is actively processing work.
2. **Waiting** — the agent is idle and may be waiting for the next prompt.
3. **Blocked** — the agent needs permission, input, or recovery.
4. **Archived** — the user intentionally put the session out of the way.

The first three columns are read-only projections of agent lifecycle state.
They must not be used as manual labels because a manually overridden status
would become stale and compete with the live agent signal. Archived is the only
user-controlled transition. A stable four-column layout, including empty
columns, keeps the location of each state predictable and reduces re-scanning.
Attention remains a small card indicator rather than a fifth column, and
`Done` is not introduced because it overlaps with Waiting and Archived.

## User experience

The sidebar footer order is New terminal (when available), Kanban, All
sessions, Settings. Kanban has a visible `⌘⇧K` hint and the global shortcut
also accepts `Ctrl+Shift+K` on non-macOS platforms. The shortcut is ignored
while typing in an editable control and toggles the modal when the board is
already open.

Kanban opens a responsive modal sized to `80vw` by `80dvh` (with small-screen
fallbacks). Its header contains the title, a short explanation, and the
shortcut hint. The board keeps all four columns mounted and scrolls
horizontally when needed; each column has its own vertical card list. Cards
contain only the agent, title, purpose/summary text, working-directory
metadata, update time, and one status signal.

Active cards are draggable to Archived. The Archived column is the only valid
drop target and provides a visible empty-state drop hint. Every drag action
has an equivalent button labelled Archive, so keyboard and assistive
technology users do not depend on native drag-and-drop. Archived cards expose
Restore; restoring makes the terminal visible in the sidebar again and keeps
the board open. The same restore action is available from All sessions.

## Data and API

Persist a boolean `archived` flag with terminal metadata. Existing databases
default it to false through a SQLite migration. `GET /api/sessions` excludes
archived metadata so the left sidebar and its normal selection model do not
show it. `GET /api/all-sessions` includes archived agent sessions with
`archived: true`; open records retain their terminal ID and exited records
remain resumable as before.

Add authenticated Kanban reads and an archive mutation for an agent session:

```http
GET /api/kanban/sessions
GET /api/kanban/archives

PATCH /api/kanban/sessions/{terminalId}/{agentSessionId}
Content-Type: application/json

{"archived": true}
```

The same mutation with `{"archived": false}` restores the session. It
accepts only supported agent sessions, persists the flag, emits the normal
terminal update event, and returns the updated All-session metadata. The App
removes an archived terminal from the active selection when needed and
explicitly selects it after a successful restore.

The browser adds `archived` to `Session` and `AllSession`, exposes a
`KanbanSession` type, and provides Kanban list/archive methods. Kanban
composes live session data with archived All-session records and the latest
`AgentSummary` for purpose/summary text. The board does not keep a second
server status store.

## Failure handling

- A failed list request leaves the modal open and shows an inline error while
  preserving the four-column layout.
- A failed archive or restore leaves the card in its original column and
  reports the error without changing the sidebar optimistically.
- If an archived card no longer has a managed terminal ID, All sessions keeps
  the existing agent/session resume path available; otherwise the archive
  action reports that the saved session is unavailable.
- Duplicate archive/restore requests are disabled while the same mutation is
  in flight.

## Accessibility and responsive behavior

The modal has a named dialog, visible focus rings, `aria-keyshortcuts`, and
column headings with counts. Cards expose keyboard-focusable Archive/Restore
buttons; drag affordances are supplementary. Reduced motion disables card
translation and spinner animations. At narrow widths the board remains a
horizontal scroll surface with a minimum card/column width instead of
compressing titles until they are unreadable.

## Testing

- Go tests cover the SQLite default/migration, archive persistence, active
  list exclusion, All sessions archived state, agent-only validation, and
  restore behavior.
- API tests cover archive/unarchive requests and response decoding.
- Component tests cover fixed column assignment, search-free status projection,
  card callbacks, drag-to-Archived, keyboard fallback actions, modal sizing,
  sidebar placement, and shortcut toggling.
- App tests cover loading the board, archiving a live agent out of the sidebar,
  restoring it from the board/All sessions, and preserving the modal on errors.
- The full Go suite, Vitest suite, web typecheck/build, and targeted Playwright
  behavior checks run before integration.
