# Inbox Agent Actions Design

## Goal

Renew the Agents pane into a Gmail-like Inbox where a user can scan agent
updates, understand which items need a response, choose a suggested response,
and have Euphony safely deliver that response to the linked terminal.

## Product behavior

- The visible workspace name is `Inbox`; internal `agents` pane IDs and event
  names remain compatible with existing clients.
- The default Inbox shows two message-list sections: `Needs your action` for
  waiting or blocked agents, and `Agent updates` for running agents.
- Unread rows use bold subject, summary, and action text. Read rows remain in
  the same queue; there is no separate unread tab.
- Action rows show the AI-generated action plus one to four labeled options.
  Selecting an option asks the selected provider AI to inspect the linked
  terminal screen and derive the exact input sequence for that choice.
- Selecting a message keeps the user in Inbox and opens its detail pane. The
  detail pane always provides `Open terminal`; structured actions additionally
  expose one to four response options and a `Mark done` control.
- A successful option selection marks the summary read and done and moves it to
  the existing Done view. A failed selection leaves the item actionable and
  shows an error.
- The terminal is locked for the duration of server-side automated input and
  output settling. Browser input, paste, key handling, and alternate-buffer
  wheel input are suppressed while the lock is active. The terminal displays
  `Inbox is controlling this terminal`.

## Provider settings

The summary provider setting accepts exactly:

- `openai`: OpenAI Responses API, model `gpt-5.6-luna`, using
  `OPENAI_API_KEY` from the server environment.
- `codex`: Codex CLI with `exec --ephemeral --output-schema <file>`, model
  `gpt-5.6-luna`, and low reasoning effort.
- `claude`: Claude CLI with `-p --bare --json-schema <schema>`, model `haiku`,
  and low effort.

The key is never returned by the settings endpoint or stored in SQLite. If the
OpenAI key is absent, the provider remains selectable and the summary error
states that the key is not configured.

When `openai` is selected, the settings panel also exposes the GPT-5.6
reasoning effort values `none`, `low`, `medium`, `high`, `xhigh`, and `max`.
The value is persisted as `agentSummaryOpenAIEffort`, defaults to `low`, and
is sent only to the OpenAI Responses request. CLI providers keep their
existing low-effort command arguments.

All three providers receive the same structured output contract:

```json
{
  "summary": "what the agent is doing now",
  "action": "what the user should do next, or an empty string",
  "priority": "high | medium | low | empty string",
  "options": [
    {"label": "Allow", "input": "y\r"}
  ]
}
```

Running agents must return empty `action`, `priority`, and `options`. Waiting
and blocked agents must return a concrete action, a valid priority, and at
least one option. Inputs are bounded, contain no NUL byte, and the summary
input is only a candidate hint for the action step. The action step receives
the current terminal screen, the selected option label, and the candidate hint,
then returns a strict `{ "input": "..." }` object. Only that validated action
response is sent as raw PTY bytes after the user selects the visible option
label. The server normalizes option IDs as `option-1`, `option-2`, and so on
before persistence.

Printable terminal actions are normalized at the parser boundary: a missing
line terminator receives `\r`, and a trailing `\n` is converted to `\r` so the
generated command is submitted as an Enter keystroke. Raw control sequences
remain unchanged.

## Visual direction

The terminal-first near-black workspace becomes a quiet message room: dense
rows, hairline separators, compact sender metadata, and one amber unread/action
signal. The mailbox uses a Gmail-like two-column composition: one-line summary
rows on the left and the selected message's action detail on the right. This
keeps scanning separate from committing an action and avoids floating card
mosaics.

```text
┌ sidebar ┐  ┌ Inbox ───────────────┬ Selected message ───────────────┐
│ Inbox 3 │  │ ACTION QUEUE      3  │ Agent update · Codex             │
│         │  ├──────────────────────┤ Waiting · high · 09:42           │
│ cwd/... │  │ ● Permission request │ Summary · Waiting for access...   │
│ terminal│  │   Waiting for access… │ Next action                       │
└─────────┘  │   Dashboard tests    │ Approve the requested file access.│
             │   Updating tests…    │ [Allow access] [Keep waiting]     │
             └──────────────────────┴──────────────────────────────────┘
```

## Mailbox navigation

- `/inbox` opens the Inbox and selects the first available message after the
  summaries load. `/inbox/:terminalID` restores a specific message.
- `/tasks` opens Tasks and `/tasks/:taskID` restores a specific task. Creating,
  selecting, deleting, and replacing a task keep the URL in sync.
- Browser history restores the selected dashboard pane and item without
  changing the terminal query selection. Opening a terminal returns to the
  terminal workspace URL while preserving the selected session state.

## Architecture

`session.AgentSummary` gains persisted `Options []AgentSummaryOption`. The
SQLite row stores the options as JSON, with a guarded migration for existing
databases. Action and option changes reset `Unread` and `Done`; regenerating
the same action and options preserves both flags.

`agentsummary` owns a single schema definition shared by the three providers.
The CLI runner writes a temporary schema file for Codex and passes the inline
schema to Claude. The OpenAI runner sends a Responses API request with
`text.format.type=json_schema`, strict schema mode, and the same schema. The
existing prompt/parser remains the final validation boundary.

The control service owns a per-terminal automation lock. A lock is acquired by
the Inbox action endpoint before reading the terminal state. The browser
supplies the current rendered xterm screen snapshot when available; older
clients fall back to a bounded terminal history tail. While the lock is held,
the selected provider AI receives that screen and returns a strict
terminal-action schema. The summary generation is revalidated immediately
before the validated bytes are written, and the service waits for a short
output-quiet period with a bounded maximum before releasing the lock. Normal
WebSocket and v1 input calls return `terminal_locked` while the lock is held;
the browser additionally suppresses input locally.

`POST /api/agent-summaries/{id}/options/{optionID}/execute` validates the
current option, locks the terminal, asks the configured provider AI to derive
input from the screen, executes the validated input through the locked control
service, marks the summary done/read, publishes the normalized summary event,
and returns the summary. No terminal input string is accepted from the browser
or sent directly from the summary option.

The React app adds `Inbox` labels, renders the two-column message list and
detail view with option buttons, tracks per-terminal automation state, and passes that state through
`TerminalPane` to `TerminalView`. The API response replaces the matching
summary using the existing revision/snapshot guard.

## Failure handling

- Missing/invalid provider output is rejected and retains the previous valid
  options alongside the previous summary. A malformed terminal-action response
  never reaches the PTY.
- Missing `OPENAI_API_KEY`, API timeout, non-2xx response, or malformed API
  output is shown as the existing summary error without exposing the key.
- A missing summary, terminal, or option returns a specific protected API
  error; no bytes are sent for an invalid option.
- A busy automation lock returns a conflict and leaves the Inbox item open.
- A canceled or failed AI call or automated write always releases the lock
  through a deferred cleanup path.

## Verification

- Go tests cover schema parsing, all provider command/API requests, settings
  validation, option persistence/migration, action transitions, lock behavior,
  the option endpoint, and WebSocket input rejection while locked.
- React tests cover Inbox message grouping, the list/detail split, unread
  typography, options, keyboard activation, provider labels, URL restoration,
  and terminal lock propagation.
- Playwright covers selecting an option, the Done transition, and the locked
  terminal state with deterministic API responses.
- Run the full Go suite, focused Web tests, Web typecheck/build, and the
  existing Playwright suite. Preserve the pre-existing WorkspaceFilesView
  timeout if it reproduces unchanged.
