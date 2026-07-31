# CWD-First Sidebar Tree Design

## Goal

Refresh the left navigation so it presents the workspace as a two-level tree:
exact working directory groups contain terminal or agent sessions. Lifecycle
status moves from a separate hierarchy level into the leading icon of each
session row, unread attention moves to a trailing blue dot, and every working
directory gets a direct create-terminal action.

## Chosen Approach

Keep `App` as the owner of shared selection, URL, and filter state, but make
`SessionNavigation` a cwd-first projection of the current session list. Build
the groups in first-seen session order, using the exact `cwd` as the key and
`displayPath` only for presentation. Each group renders one cwd heading and
one child row per session.

The sidebar no longer renders status headings or status/cwd filter checkboxes.
Existing URL and server selection filter fields remain parsed, persisted, and
available to the existing command-palette and shared-selection paths, so
saved workspaces remain compatible. Terminal split/pin checkboxes, row
selection, deletion, mobile behavior, and sidebar controls remain unchanged.

The existing creation callback becomes `onCreate(cwd?: string)`. The footer
continues to call it without an argument; a cwd heading calls it with the
exact full path. `App` forwards that path to `createSession(false, cwd)`, so
explicit cwd creation follows the existing API error path and does not inherit
the focused terminal's cwd.

## Sidebar Structure

```text
▾ ~/work/euphony                                      +
    [split]  ◌  [Codex icon]  Implement v0.2       •
    [split]  🚫  [Claude icon] Needs approval
▾ /workspace/plain-shell                              +
    [split]  ▣  Terminal
```

- Cwd headings are the only tree parent level. They show the shortened path,
  preserve the full path in `title`, and place a compact plus button at the
  far right with the accessible name `Create terminal in <display path>`.
- Session rows retain the existing terminal selection checkbox at the leading
  edge and the delete action. Inside the row, the lifecycle status icon comes
  before the provider icon and title. The title is `agentTitle || name`, as it
  is today.
- `running` uses a `LoaderCircle` icon with a linear rotation animation.
  `blocked` uses the literal `🚫` symbol. `waiting`, plain `terminal`,
  `starting`, `exited`, `failed`, and unknown values use quiet static Lucide
  fallbacks with status labels exposed to assistive technology.
- `needsAttention` renders one 6px `#38bdf8` dot at the far right of the
  session row. It remains decorative; the row's accessible description is
  `Needs attention`. It does not replace the lifecycle status icon.
- Empty status groups are no longer rendered because status is not a tree
  level. Empty cwd groups cannot occur because groups are derived from
  sessions.

## Components and Data Flow

`SessionList` owns only presentation grouping and row interactions:

1. `groupSessionsByCwd(sessions)` returns ordered `{ cwd, sessions }` groups.
2. A cwd plus button invokes `onCreate(cwd)` and stops its own click event.
3. A session row calls the existing `onSelect` and `onDelete` callbacks.
4. `StatusIcon` maps `activity(session)` to the visual and accessible status
   marker.

`SessionNavigationContent` keeps the existing scroll overflow observation,
sidebar resize, collapse, footer, and mobile drawer wiring. `App` only changes
the callback signature at the render boundary; its filter and selection
reducers remain untouched.

## Accessibility and Motion

- Every session remains a named selection button, and the attention description
  is attached with `aria-describedby` only when needed.
- Every cwd create control is a real button with a visible focus ring and a
  tooltip/title containing the displayed cwd.
- Status icons have explicit accessible labels but do not change the button's
  existing selection name.
- The running animation is disabled by the existing global
  `prefers-reduced-motion: reduce` rule.
- The tree keeps the existing compact Geist typography, dark blue sidebar
  surface, active-row treatment, and responsive drawer layout. The memorable
  visual signature is the live status glyph at the left of every child row;
  attention remains deliberately quiet at the opposite edge.

## Error Handling

The plus action does not optimistically add a fake row. `App.createSession`
handles the API request and existing `requestError` state. The explicit cwd is
passed through unchanged; only the existing implicit focused-cwd flow may use
the invalid-cwd fallback to home.

## Testing

- Component tests prove cwd-first ordering, absence of status headings, status
  icon mapping (including the rotating class and blocked symbol), right-edge
  attention markup, terminal selection/pin behavior, and cwd plus callback
  arguments.
- App tests prove a cwd plus action posts a terminal with that exact cwd and
  keeps the created terminal selected.
- Existing mobile, deletion, settings, selection, typecheck, and build tests
  remain green.
- Playwright verifies the real sidebar has one cwd heading per exact path,
  child rows carry the expected status/attention markers, and clicking the
  cwd plus button creates a terminal in that directory through the isolated
  test backend.
