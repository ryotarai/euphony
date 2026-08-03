# Terminal Performance Design

## Problem

Terminal input and switching slow down as more terminals are visited and as
sessions run longer. The browser currently retains every visited xterm
instance and WebSocket. The server also performs terminal-wide metadata I/O
from the synchronous session-list path, and two of those operations contend
with PTY input locks.

The optimization must cover both frontend and backend behavior without
changing terminal selection, pinning, shared sizing, source tabs, or terminal
byte fidelity.

## Evidence

- `App` retains every visited terminal ID and mounts every retained
  `TerminalPane`, so xterm buffers, WebGL contexts, observers, listeners, and
  WebSockets grow with lifetime visits.
- Carousel panes outside the viewport use `visibility: hidden`; their content
  remains mounted and keeps processing output.
- `PaneCarousel` searches the selected pane array once per mounted pane.
- `GET /api/sessions` synchronously calls `Manager.List()` every 1.5 seconds.
- `refreshCodexTitles` scans up to 2 MiB per Codex transcript while holding the
  manager lock that `WriteTerminal` needs.
- `ForegroundCommand` holds the PTY file mutex while waiting for `ps`; terminal
  input needs the same mutex.

The existing cleanup paths work when a terminal unmounts. The dominant
frontend issue is therefore unbounded retention, not a missing cleanup.

## Considered Approaches

### 1. Keep every terminal alive and micro-optimize callbacks

This preserves the fastest possible revisit but cannot bound xterm buffers,
WebGL contexts, WebSockets, or output parsing. It does not address the observed
lifetime scaling and is rejected.

### 2. Unmount every non-visible terminal

This gives the smallest steady-state resource use. However, every ordinary
two-terminal switch reconnects and replays history, regressing the deliberate
warm-switch behavior and making long-history revisits expensive.

### 3. Virtualized panes with a bounded warm LRU (recommended)

Mount all currently visible panes plus up to four recently visited,
non-selected terminals. Unmount selected carousel panes outside the viewport
until they become visible. Cached panes remain measurable but do not claim a
terminal size. This keeps common A/B switching warm while placing a hard bound
on background xterm and WebSocket work.

On the server, make session-list responses read the current in-memory snapshot
and trigger at most one asynchronous metadata refresh. Move transcript scans
and `ps` execution outside locks needed by terminal input. This keeps metadata
eventually fresh while making the input path independent of slow filesystem
and process inspection.

## Architecture

### Frontend residency

- `App` owns a recency-ordered set of opened terminal IDs.
- The selected terminal list remains the source of carousel layout.
- At most four non-selected IDs become warm cached panes.
- `PaneCarousel` computes ID-to-index lookup once per selected-pane change.
- It mounts content only when the pane is visible or explicitly warm-cached.
- Hidden warm panes retain xterm state and their WebSocket, but visibility
  checks suppress refresh, dimension proposals, and resize claims.
- Existing visual tokens, pane geometry, keyboard behavior, and animation stay
  unchanged. The frontend-design constraint is deliberately visual
  preservation: the memorable terminal-first interface must not pay for this
  performance work with new decoration or motion.

Resource growth becomes:

`visible split panes + 4 warm panes`

rather than:

`every terminal visited since page load`.

### Backend isolation

- `Manager.ListCurrent()` remains a cheap in-memory snapshot.
- `Manager.RefreshMetadata()` serializes refresh work with a non-blocking
  single-flight guard.
- The HTTP session-list handler returns `ListCurrent()` immediately and starts
  `RefreshMetadata()` asynchronously only when no refresh is already running.
- `Manager.List()` retains synchronous refresh semantics for internal callers
  and existing tests.
- Codex title resolution snapshots candidate identity under the manager lock,
  performs bounded file reads outside the lock, then conditionally applies the
  result if the terminal identity is unchanged.
- Foreground process group lookup stays protected by the PTY file mutex, but
  the external `ps` command runs after that mutex is released.

Terminal input therefore waits only for a short map lookup and PTY write, not
for transcript scanning or `ps`.

## Data Flow

Input:

`xterm onData -> WebSocket input -> Manager session lookup -> PTY write`

Metadata:

`poll -> immediate in-memory list response -> single-flight async refresh ->
change event -> client snapshot refresh`

The two flows share terminal identity but no slow operation or long-lived lock.

## Failure Handling

- If asynchronous metadata refresh fails for one terminal, the last in-memory
  metadata remains valid and later polls retry.
- A refresh result is discarded if the terminal was deleted or its agent
  session/transcript changed while I/O was in progress.
- Evicted frontend terminals reconnect through the existing ticket, history,
  and live handoff protocol when shown again.
- The existing bounded initial history queue and subscriber lag recovery remain
  unchanged.

## Verification

- A frontend regression test visits more terminals than the warm-cache limit
  and asserts mounted terminal content plateaus.
- A carousel test asserts offscreen selected content is unmounted and becomes
  mounted when navigated into view.
- Existing warm A/B switching tests continue to assert one mount and one
  WebSocket inside the cache window.
- A backend concurrency test blocks Codex title resolution and proves metadata
  lookup/terminal input are not blocked.
- A backend concurrency test blocks foreground `ps` execution and proves PTY
  input is not blocked.
- A server test proves session-list response completion does not wait for a
  blocked metadata refresh and overlapping requests do not start duplicate
  refreshes.
- Focused unit tests, all Go tests, frontend typecheck/build, and Playwright
  terminal reliability tests verify integration.

