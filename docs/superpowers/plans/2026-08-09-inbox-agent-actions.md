# Inbox Agent Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Agents pane into an Inbox with structured action choices, three selectable summary providers, and a server-enforced terminal lock during automatic input.

**Architecture:** Extend the existing summary contract with persisted options and a shared JSON schema. The server executes a selected option through a per-terminal automation lock, while React renders a dense Inbox message list and propagates the lock to TerminalView input guards.

**Tech Stack:** Go 1.24, SQLite, net/http, the OpenAI Responses API over the standard library HTTP client, Claude/Codex CLIs, React, TypeScript, Vitest, Testing Library, and Playwright.

## Global Constraints

- User-visible labels say `Inbox`; internal `agents` IDs/events remain stable.
- Providers are exactly `openai`, `codex`, and `claude`; default remains `codex`.
- OpenAI uses `gpt-5.6-luna` and `OPENAI_API_KEY`; the key never enters browser state or SQLite.
- OpenAI effort is exactly `none`, `low`, `medium`, `high`, `xhigh`, or `max`; default is `low` and CLI effort remains fixed at low.
- Claude uses `-p --bare --json-schema`; Codex uses `exec --ephemeral --output-schema`.
- Waiting/blocked structured summaries include one to four options; running summaries include none.
- Browser action requests carry only terminal ID and option ID; option input is resolved server-side.
- Terminal input is rejected while an Inbox automation lock is held, and every lock path releases it.
- Existing unread/done revision guards and unrelated base-worktree changes remain intact.

---

### Task 1: Add the shared structured summary contract and providers

**Files:**
- Modify: `internal/agentsummary/prompt.go`
- Modify: `internal/agentsummary/runner.go`
- Modify: `internal/agentsummary/service.go`
- Modify: `internal/session/manager.go`
- Modify: `internal/session/sqlite_store.go`
- Modify: `internal/server/server.go`
- Modify: `internal/server/settings.go`
- Test: `internal/agentsummary/service_test.go`
- Test: `internal/session/agent_summary_test.go`
- Test: `internal/session/sqlite_store_test.go`
- Test: `internal/server/settings_test.go`

**Interfaces:**
- Produce `session.AgentSummaryOption{ID, Label, Input}` and `session.AgentSummary.Options`.
- Produce `agentsummary.Generation.Options` and a shared strict schema.
- Accept provider values `openai`, `codex`, and `claude`.
- Persist and validate `Settings.AgentSummaryOpenAIEffort` and pass it only to OpenAI API calls.

- [ ] Write failing parser, command-argument, OpenAI HTTP, settings, and persistence tests.
- [ ] Run focused tests and confirm they fail because options/openai/provider validation are absent.
- [ ] Implement option normalization, schema generation, `--bare`, `--ephemeral`, Codex schema temp files, Claude inline schema, and OpenAI Responses structured output.
- [ ] Store options JSON with a guarded SQLite migration and preserve options on error/action transitions.
- [ ] Run `gofmt` and focused Go tests.
- [ ] Commit `feat: add structured inbox summary providers`.

### Task 2: Add locked option execution to the control and server layers

**Files:**
- Modify: `internal/control/service.go`
- Modify: `internal/control/terminal.go`
- Modify: `internal/server/terminal.go`
- Modify: `internal/server/agent_summaries.go`
- Modify: `internal/server/server.go`
- Test: `internal/control/terminal_test.go`
- Test: `internal/server/agent_summaries_test.go`
- Test: `internal/server/terminal_test.go`

**Interfaces:**
- Produce `control.RunTerminalAutomation(context.Context, string, []byte) error`.
- Produce `POST /api/agent-summaries/{id}/options/{optionID}/execute` returning a normalized `AgentSummary`.
- Return `control.ErrTerminalLocked` as a protected conflict and drop locked WebSocket input.

- [ ] Write a failing concurrency test proving ordinary terminal input is rejected during automation and accepted after release.
- [ ] Write a failing protected endpoint test proving option ID lookup, locked write, Done/read transition, event publication, and invalid-option rejection.
- [ ] Implement per-terminal lock acquisition, output settling timeout, deferred release, and route wiring.
- [ ] Run focused control/server tests and confirm the lock remains active during settling.
- [ ] Commit `feat: execute inbox options with terminal locks`.

### Task 3: Replace the Agents presentation with the Inbox UI

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Modify: `web/src/components/AgentsView.tsx`
- Modify: `web/src/components/AgentsView.test.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`

**Interfaces:**
- Consume `AgentSummary.options` and `ApiClient.executeAgentSummaryOption(id, optionID)`.
- Produce Inbox message rows, option buttons, and `onChooseOption(id, optionID)`.
- Produce per-terminal `automationLocked` state for terminal rendering.

- [ ] Write failing component tests for Inbox labels, action/update sections, unread rows, option buttons, keyboard activation, and option failure.
- [ ] Run the focused Web tests and verify the new assertions fail.
- [ ] Implement the dense message list, inline choices, Done movement, provider labels, and settings copy for all three providers.
- [ ] Add App action execution, summary reconciliation, and per-terminal lock state without changing normal terminal selection.
- [ ] Run focused Web tests and typecheck.
- [ ] Commit `feat: renew agents as inbox`.

### Task 4: Guard TerminalView input while Inbox automation runs

**Files:**
- Modify: `web/src/components/TerminalView.tsx`
- Modify: `web/src/components/TerminalPane.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/TerminalView.test.tsx`
- Modify: `web/src/styles.css`

- [ ] Write failing tests for keyboard, data, and wheel suppression plus the visible lock status.
- [ ] Implement the `locked` prop/ref, prevent xterm input callbacks, preserve output rendering, and show the lock banner.
- [ ] Run TerminalView/Pane tests and typecheck.
- [ ] Commit `feat: lock terminal during inbox actions`.

### Task 5: Verify browser behavior and integrate

**Files:**
- Modify: `web/e2e/euphony.spec.ts`
- Modify: `docs/superpowers/plans/2026-08-09-inbox-agent-actions.md`

- [ ] Add deterministic Playwright coverage for Inbox option selection, Done movement, and terminal lock banner.
- [ ] Run `go test ./...`.
- [ ] Run `cd web && npm test -- --run` and record the known WorkspaceFilesView timeout if unchanged.
- [ ] Run `cd web && npm run typecheck`, `npm run build`, and the focused Playwright spec.
- [ ] Run `git diff --check`, inspect changed files, and verify every Global Constraint.
- [ ] Commit documentation/checklist updates, merge `codex/inbox-agent-actions` into `main` without touching unrelated base changes, and report fresh verification evidence.
