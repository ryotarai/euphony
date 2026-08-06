# Agents Pane Design

## Goal

Add an `Agents` view at the top of the left sidebar. The view gives a user one
place to understand which agents need attention and what currently running
agents are doing. Each item is summarized from the agent transcript and the
tail of its terminal output by a locally installed `claude` or `codex` command.

## Scope

The first version includes:

- An `Agents` navigation item above the terminal tree, with an action-required
  count for `blocked` and `waiting` agents.
- An Agents dashboard with two sections:
  - `Action required`: blocked or waiting agents, each with a generated
    summary and a plain-language action description.
  - `Running`: running agents, each with a generated description of current
    work.
- A provider setting that selects `claude` or `codex` for all summaries.
- SQLite persistence for the most recent summary per terminal.
- Automatic refresh when an agent status changes and every five minutes while
  an agent is running.
- Event-driven browser refresh through `agent.summary.updated` events.
- Selecting an item opens that terminal in the normal workspace.

The first version does not add a separate model API, a remote LLM integration,
manual prompt editing, or a per-agent provider override.

## Design direction

The existing workspace is a near-black, terminal-first environment with quiet
structure and a lime keyboard-focus accent. The Agents view keeps that base
and uses a single memorable device: a narrow signal rail on each summary card.
The rail is amber for action-required agents and blue for running agents. The
card itself remains nearly black, with a compact provider/status eyebrow, a
large readable summary, and a secondary action line. This makes the meaning
of the list legible without turning it into a collection of decorative cards.

Typography follows the existing system: Geist for interface copy and a mono
face for status metadata and timestamps. Headings use sentence case and the
same restrained scale as the terminal chrome. Cards have no rounded floating
panels; separators and the signal rail carry the hierarchy.

```text
┌ sidebar ┐  ┌ Agents ───────────────────────────────────────┐
│ Agents  │  │ 2 need attention                  refreshed … │
│         │  │ ACTION REQUIRED                               │
│ cwd/... │  │ ┃ BLOCKED   Codex · Fix API                    │
│ terminal│  │ ┃           Waiting for permission …          │
│         │  │ ┃ WAITING   Claude · Review changes            │
│         │  │ ┃           Approve the pending question …    │
│         │  │ RUNNING                                        │
│         │  │ ┃ RUNNING   Codex · Implement v0.2              │
│         │  │ ┃           Updating the API tests …            │
└─────────┘  └────────────────────────────────────────────────┘
```

The dashboard is responsive: on narrow screens it becomes a single scrollable
column, and the existing mobile sidebar closes after selecting Agents or a
terminal.

## Architecture

### Shared data types and persistence

`session.AgentSummary` is the backend and JSON representation:

```go
type AgentSummary struct {
    TerminalID  string    `json:"terminalId"`
    Provider    string    `json:"provider"`
    Status      string    `json:"status"`
    Summary     string    `json:"summary"`
    Action      string    `json:"action,omitempty"`
    GeneratedAt time.Time `json:"generatedAt"`
    Error       string    `json:"error,omitempty"`
}
```

`session.Settings` gains `AgentSummaryProvider`, defaulting to `codex` and
accepting only `claude` or `codex`. The SQLite `settings` table receives a
Codex-defaulted column, and existing legacy Claude defaults are migrated to
Codex. A new
`agent_summaries` table stores one row per terminal; writes are atomic with
respect to the existing store operation queue.

### Summary coordinator

`internal/agentsummary` owns scheduling and command execution. It receives
the session manager, the event source, the transcript resolver, and a command
runner through small interfaces. This keeps command execution deterministic in
unit tests and keeps the HTTP server unaware of prompt construction.

On startup it schedules summaries for current identified agents with no
usable saved summary. It subscribes to `agent.updated` and
`terminal.deleted`. A transition into or between `running`, `waiting`, and
`blocked` schedules one immediate generation. A ticker schedules running
agents every five minutes. Per-terminal in-flight guards prevent overlapping
commands. If status or session identity changes during a command, the stale
result is discarded and the newer state is scheduled.

The coordinator reads the latest bounded transcript page through the existing
`agentlog.Resolver` and `agentlog.ReadPage`, plus the last 24 KiB of
`Session.HistorySnapshot`. ANSI control sequences are removed before they are
included in the prompt. The prompt explicitly asks for a single JSON object:

```json
{"summary":"What the agent is doing now.","action":"What the user should do next."}
```

For `running`, `action` is empty. For `waiting` and `blocked`, `action` is
required. The command runner uses these exact invocations:

- Claude: `claude -p --model haiku --effort low`
- Codex: `codex -c model_reasoning_effort=low -c service_tier=standard exec --model gpt-5.6-luna`

The prompt is sent on stdin. A 90-second context deadline, bounded output,
JSON extraction, and one-line fallback parsing prevent a misbehaving CLI from
blocking the server or corrupting the UI. CLI errors are saved on the summary
row while preserving the previous successful summary when one exists.

### HTTP and browser flow

The server exposes `GET /api/agent-summaries`, returning current summaries in
session creation order. The coordinator publishes `agent.summary.updated` with
the saved summary and `agent.summary.deleted` when its terminal disappears.

The React app loads summaries beside sessions, subscribes to those events, and
updates only the summary state. `SessionNavigation` receives an `agentsOpen`
flag and an `onOpenAgents` callback. The Agents item is rendered before the
terminal tree; selecting it does not mutate terminal selection or URL state.
`AgentsView` owns presentation and emits a terminal ID when a card is clicked.
The app then opens that terminal and returns to the terminal workspace.

## Failure handling

- No transcript or terminal history: the provider still receives available
  session metadata and the prompt asks it to say that context is unavailable.
- Provider executable missing, timeout, non-zero exit, or malformed output:
  retain the last successful summary and show a small `Summary unavailable`
  message with the error on the dashboard. If no prior summary exists, show
  the error as the card body.
- Agent deleted while generation is running: discard the result and publish a
  deletion event; never recreate a terminal row.
- Browser event stream reconnects through the existing event loop; the next
  snapshot fetch obtains all summaries, so a missed event is harmless.
- Settings changes affect the next scheduled generation and do not interrupt a
  currently running provider command.

## Verification

- Go unit tests prove prompt input includes bounded transcript and terminal
  context, exact provider command arguments, JSON parsing, status-change
  scheduling, five-minute scheduling with an injected clock/interval, stale
  result rejection, and command failures.
- SQLite tests prove the summary table migration, round-trip persistence, and
  provider setting migration without changing existing settings.
- Server tests prove the summaries endpoint and event publication.
- React component tests prove the navigation placement, section grouping,
  action copy, empty states, and terminal selection callback.
- App tests prove summary loading and event refresh without changing terminal
  selection.
- Run the full Go suite, the web unit suite, web typecheck/build, and the
  existing Playwright suite. A Playwright dashboard test uses a stubbed API
  response and does not invoke a real provider CLI.
