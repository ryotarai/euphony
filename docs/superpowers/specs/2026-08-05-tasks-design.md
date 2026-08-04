# Tasks Design

## Goal

Add a persistent task workspace that connects a TODO item to an agent terminal. A user can create a task, refine it with AI, start Claude or Codex for it, communicate with that agent, and finish the task without leaving Euphony.

## Product behavior

The left sidebar navigation order is:

1. Tasks
2. Agents
3. Terminal sessions

Tasks is the default workspace entry point for the TODO workflow. It displays open work first and keeps completed work available through a status filter. The task detail view is the place where the user can move from planning to execution:

- create or edit title, description, priority, and status;
- run AI refinement and review the proposed fields before applying them;
- start a Claude or Codex agent in a new terminal using the selected terminal's working directory;
- open the linked terminal directly;
- send an instruction to the linked agent;
- read an append-only activity stream containing user instructions and agent updates.

Tasks default to `todo` and `medium`. Supported statuses are `todo`, `in_progress`, `blocked`, and `done`; supported priorities are `low`, `medium`, and `high`. Deleting a task does not delete its terminal, because the terminal is independently useful and may contain work that must be recovered.

## Data model

`Task` is persisted with:

- `id`, `title`, `description`, `priority`, `status`;
- optional `terminalId` and `agent` (`claude` or `codex`) for the execution link;
- `createdAt` and `updatedAt`.

`TaskUpdate` is persisted separately and belongs to a task. It contains `id`, `taskId`, optional `terminalId`, `kind`, `body`, and `createdAt`. Kinds are `user_instruction`, `agent_status`, `agent_summary`, `system`, and `error`. The API includes updates in task detail responses. Repeated identical status or summary updates are coalesced when they are the latest update for that task.

Task storage uses the configured Euphony SQLite database and its own focused store/connection. This keeps task domain code separate from terminal lifecycle code while preserving one durable database file. An in-memory store is used when the server has no database path, matching the existing server tests.

## Server interfaces

Protected JSON routes use the existing bearer authentication:

- `GET /api/tasks` returns tasks with their activity updates;
- `POST /api/tasks` creates a task from `{title, description, priority, status}`;
- `PATCH /api/tasks/{id}` partially updates task fields;
- `DELETE /api/tasks/{id}` removes a task only;
- `POST /api/tasks/{id}/start` accepts `{agent, cwd}` and creates/links a terminal, starts the requested agent, and marks the task `in_progress`;
- `POST /api/tasks/{id}/prompt` accepts `{prompt}` and sends it to the linked agent, recording the instruction;
- `POST /api/tasks/{id}/refine` asks the configured summary provider for a structured proposal and does not mutate the task.

The refinement response is:

```json
{
  "title": "...",
  "description": "...",
  "priority": "low|medium|high",
  "status": "todo|in_progress|blocked|done",
  "rationale": "..."
}
```

AI commands use the configured provider and the existing fixed command settings: Claude runs Haiku with `--effort none`; Codex runs `gpt-5.6-low` with `--effort none`. Refinement output is bounded, parsed as JSON, validated against the task enums, and rejected if required fields are missing.

Task lifecycle changes publish `task.created`, `task.updated`, `task.deleted`, and `task.update.created` through the existing event stream. A task service subscribes to `agent.updated`, `agent.summary.updated`, and `terminal.deleted` so agent activity is persisted without browser polling. When a linked terminal disappears, the task remains but its terminal link is cleared and a system update explains why.

## UI design

The Tasks view uses the established Euphony terminal-first visual language: near-black canvas, hairline rules, monospace metadata, and amber as the attention color. It is intentionally editorial rather than a grid of generic cards.

```text
┌ Tasks ───────────────────────────────────────────────────────────────┐
│ TODO / 3 open                              New task                    │
├──────────────────────────────┬────────────────────────────────────────┤
│ OPEN                          │ TASK / Implement task API             │
│ ● High  Implement task API    │ High · In progress · Codex             │
│   In progress                 │ [Open terminal] [Start agent]          │
│                              │                                        │
│ ○ Medium Update docs          │ Description                            │
│   Todo                       │ ...                                    │
│                              │                                        │
│ DONE                          │ Refine with AI                         │
│ ✓ Ship Agents pane            │ [proposal] [Apply refinement]          │
│                              │                                        │
│                              │ Activity                                │
│                              │ user · agent · system entries          │
│                              │ [Tell the agent...] [Send instruction]  │
└──────────────────────────────┴────────────────────────────────────────┘
```

The task list uses a narrow priority signal and status labels; the detail pane carries the full text and controls. On small screens the list and detail stack, with the selected task kept visible. Focus rings and reduced-motion behavior follow the existing UI conventions.

## Error handling

- Invalid task fields return a 400 response with a specific validation error.
- Missing tasks and terminals return 404; missing linked agents return 409.
- Agent start failures keep the created terminal link when possible and add an error update so the user can inspect or retry it.
- Refinement failures leave the task untouched and show the provider error in the detail view.
- Prompt failures do not record a successful instruction; the response error remains actionable.
- Browser event gaps trigger a full task list refresh when Tasks is open.

## Testing strategy

- Store tests cover SQLite round trips, update ordering/coalescing, deletion, and in-memory behavior.
- Service tests cover task validation, agent linking, prompt recording, event-driven agent updates, terminal deletion, and refinement parsing with fake control/event/refiner dependencies.
- Server tests cover all task routes, authentication, validation, and event payloads.
- React tests cover list/detail rendering, create/edit/status controls, refinement apply, start/open/send actions, and empty/error states.
- A Playwright test covers the browser workflow with the refinement and task APIs intercepted while the real server provides sessions and terminal navigation.
