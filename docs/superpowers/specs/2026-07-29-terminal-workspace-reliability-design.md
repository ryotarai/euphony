# Terminal Workspace Reliability Design

## Goal

Resolve the captured Euphony workflow and terminal-compatibility issues as one
cohesive reliability pass. Preserve the current visual language while making
agent state, navigation, repository grouping, terminal sizing, history replay,
Unicode output, and multiline input deterministic.

## Scope

- Replace disruptive navigation confirmation with direct workspace navigation.
- Add a Command-K palette for terminal switching, status-only views, and
  terminal creation.
- Let users choose the working directory for a new terminal.
- Promote an agent transition from `running` to `waiting` to `attention`,
  notify the user, and optionally play a short local tone.
- Order activity groups as Attention, Running, Waiting, and Terminal.
- Group sessions by the main Git repository directory. Linked worktrees share
  the repository returned by `git rev-parse --git-common-dir`.
- Keep status-filter selections synchronized as sessions move between states.
- Preserve agent titles when hook events omit a title.
- Fix terminal sizing, replay-generated input, UTF-8 rendering, scroll speed,
  Shift+Enter multiline input, and visibility-toggle corruption.

## Architecture

### Session metadata

The backend remains the source of truth. `Metadata` gains `RepoRoot`. Session
creation accepts an optional validated `cwd`; the manager resolves the path and
derives the main repository directory without treating a linked worktree as a
separate repository.

`UpdateAgent` performs the state transition. A `running` to `waiting`
transition becomes `attention`; later `running` and explicit terminal lifecycle
events clear it naturally. Empty hook titles do not erase the last useful
title.

### Workspace state

The frontend normalizes activity values and sorts them by a fixed rank:
`attention`, `running`, `waiting`, then `terminal`, followed by exceptional
process states. Repository groups contain those status groups.

Status filters are live queries, not append-only selections. On each poll,
selected terminal IDs are recalculated from active filters so a terminal that
leaves a checked status disappears automatically.

The Command-K palette is a keyboard-accessible dialog backed by existing
selection and creation actions. New-terminal creation includes a working
directory field initialized from the focused terminal.

### Attention notifications

The client compares consecutive polling snapshots. A newly observed
`attention` session triggers a browser notification when permission is already
granted, requests permission only from an explicit user action, and plays a
short Web Audio tone when enabled. Selecting the terminal does not mutate the
agent state; the next agent hook remains authoritative.

### Terminal I/O

The implementation follows the proven Oriel lifecycle:

- expose current terminal columns and rows and send them on WebSocket open;
- fit once after open and again through a coalesced `ResizeObserver`;
- intercept Shift+Enter outside IME composition and send LF;
- keep the standard Enter behavior unchanged;
- keep input forwarding disabled until asynchronous history writes complete;
- use a UTF-8 locale for every PTY and use a CJK-capable monospace font stack;
- raise wheel scroll sensitivity without enabling smooth scrolling.

History replay suppression specifically prevents device-attribute replies such
as `1;2c` from being written into the shell when a hidden terminal is shown
again.

## Error Handling

- Reject a missing, non-directory, or inaccessible creation `cwd` with a stable
  400 response.
- If Git repository detection fails, use the session `cwd` as its group root.
- Notification and audio failures are non-fatal and never interrupt polling.
- Ignore terminal input and resize messages until the socket is open.

## Verification

- Go unit and HTTP tests cover custom working directories, repository roots,
  attention transitions, and title preservation.
- Vitest covers live status selections, ordering/grouping, command palette
  actions, notifications, open-time resizing, history replay suppression, and
  Shift+Enter.
- Playwright verifies the real xterm lifecycle, terminal resizing, filtering,
  command navigation, and absence of injected device-attribute text.
- `make test` and a production build must pass.

## Visual Direction

Retain Euphony's dark instrument-panel design: carbon background, muted steel
labels, and acid-lime focus. The palette is an operational overlay rather than
a new page, so it uses the existing typography and sharp geometry. Its
signature is a compact status rail in each search result, encoding live agent
state without introducing decorative cards.
