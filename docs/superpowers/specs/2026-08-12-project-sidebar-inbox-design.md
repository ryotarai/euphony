# Project Sidebar Inbox Design

## Goal

Make the left sidebar the primary Inbox surface by grouping terminals and
agents under their project directory. Remove the standalone Inbox/Done page
and the sidebar multi-selection controls while retaining the existing
terminal, agent-summary, selection, and Tasks APIs for compatibility.

## Scope

- A project is derived from `Session.repoRoot`, falling back to `Session.cwd`.
- Each project section lists bare terminals and agent terminals together.
- Each project header exposes actions to create a terminal or start an agent in
  that directory.
- Agent rows show a compact purpose, latest summary, and required action. An
  unread row is bold and remains independently identifiable from lifecycle
  status.
- Selecting an agent row opens its terminal and marks the corresponding agent
  summary read through the existing API.
- The `/inbox` dashboard route, Inbox/Done tabs, Done action, and sidebar
  checkboxes for terminal/agent split selection are removed from the normal
  interface.
- The Tasks dashboard remains available because it is a separate workflow and
  is not part of the Inbox/Done removal.

## Architecture

`SessionNavigation` receives `agentSummaries` and derives a summary lookup by
terminal ID. It keeps project grouping and row presentation in the navigation
component, with small pure helpers for project keys, labels, and status copy.
The existing `Session` model is sufficient; no Project table or API is added.

The application keeps its current server-selection machinery internally so
terminal panes and existing deep links do not regress. Sidebar terminal clicks
call the single-selection path. The dashboard selection state no longer
includes the Agents pane, and `/inbox` is treated as a legacy path that falls
back to the normal workspace rather than rendering a mailbox page.

Project terminal creation reuses `ApiClient.createTerminal` (or the legacy
session endpoint in tests without shared selection). Agent creation first
creates a terminal in the project directory, then calls a new
`ApiClient.startAgent` wrapper for the existing v1 agent endpoint. The returned
metadata replaces the temporary terminal row. A failed agent start leaves the
created terminal visible and reports the error; it does not delete user data.

Agent summaries continue loading and receiving events at the App level. Done
summaries remain persisted and supported by the backend, but are omitted from
the sidebar Inbox surface. A newly generated summary can reappear using the
existing revision and unread semantics.

## Visual direction

The sidebar remains the near-black Euphony workspace, but project sections are
the structural unit rather than a flat terminal tree. A project header uses a
muted monospace path and two quiet icon controls. Rows use a narrow status rail
and a three-line information hierarchy:

```text
PROJECT /workspace/euphony                 [terminal] [agent]
│  ● Implement sidebar
│    Updating the project grouping…       10:42
│    NEXT  Review the pending test result
│
│  ◉ Shell
│    Terminal · running
```

The status icon carries lifecycle color, the summary carries semantic weight,
and amber is reserved for attention/action state. No extra cards, gradients,
or new dependency are introduced. Rows have visible keyboard focus, compact
mobile layout, and `prefers-reduced-motion` support.

## Interaction and accessibility

- Project headings expose the full displayed path through `title` and a
  semantic heading.
- Header controls use labels such as `Create terminal in /repo` and `Start
  agent in /repo`.
- Each row is one keyboard-focusable button with an accessible label including
  its terminal name and current status. The required action is included in
  screen-reader text when present.
- Unread state is represented by `data-unread="true"`, bold typography, and
  text; it is never encoded by changing `waiting` or `running` to an attention
  status.
- Mobile sidebar selection closes the drawer after a single row or project
  action.
- Existing terminal delete remains per-row. No bulk delete affordance or
  split-selection checkbox is rendered by `SessionNavigation`.

## Verification

- Component tests cover project grouping by `repoRoot`/`cwd`, project header
  actions, single row selection, agent summary copy, unread emphasis, and
  required-action accessibility text.
- API tests cover the `startAgent` request path and body.
- App tests cover loading summaries into the sidebar, opening an agent row,
  marking it read, creating a terminal in a project, and creating/starting an
  agent in a project.
- Existing terminal, Tasks, API, and backend suites must remain green except
  for tests whose assertions specifically describe the removed Inbox page or
  sidebar multi-selection UI; those tests are updated to the new contract.
- Run `npm test`, `npm run typecheck`, `npm run build`, and the relevant
  Playwright tests from the isolated worktree.
