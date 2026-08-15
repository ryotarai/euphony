# Euphony TODO Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete every active item in `Euphony TODO.md` while leaving its `Pending` section untouched.

**Architecture:** Keep Euphony's browser API and agent integration intact, but remove the separate v1 automation contract, Unix transport, and automation client/commands. Remove Tasks end-to-end. Extend the agent-log normalization boundary with typed media entries and Codex runtime-message filtering, then render those entries in the existing Agent Log surface.

**Tech Stack:** Go 1.x, `net/http`, JSONL transcript parsers, React 19, TypeScript, Vitest, React Testing Library, Playwright.

## Global Constraints

- Communicate with the user in Japanese; write repository code and documents in English.
- Work only in isolated git worktrees under `tmp/worktrees` and preserve unrelated user changes.
- Leave the `Pending` section of `Euphony TODO.md` unchanged.
- Keep `euphony setup` and `euphony hook <agent> <status>` because agent integration depends on them.
- Keep browser `/api/*` routes; remove only external automation `/api/v1/*`, its Unix transport, and its automation CLI/client.
- Do not perform a destructive migration of old task tables.
- Media URLs must be HTTP(S) or validated data URLs and oversized/invalid media must be skipped.
- Preserve ordinary user transcript messages while hiding only Codex runtime-injected environment and AGENTS payloads.

---

### Task 1: Remove external automation API and CLI

**Files:**
- Modify: `cmd/euphony/main.go`, `cmd/euphony/main_test.go`, `Makefile`, `README.md`
- Delete: `cmd/euphony/cli.go`, `cmd/euphony/cli_test.go`, `internal/apiclient/client.go`, `internal/apiclient/client_test.go`, `internal/localapi/socket.go`, `internal/localapi/socket_test.go`, `internal/server/v1_*.go`, `internal/server/v1_*.go` tests, `internal/server/openapi.json`, `internal/server/v1_test.go`, `docs/automation.md`
- Modify: `internal/server/server.go`, `internal/server/auth.go`, relevant server tests

**Interfaces:**
- Preserve the `runSetup` and `runHook` command paths.
- Preserve browser routes such as `/api/sessions`, `/api/agent-summaries`, `/api/projects`, and `/api/hooks/terminal`.
- `run` rejects any command other than `setup` and `hook` with a concise usage error.

- [ ] Add a failing test proving `run([]string{"status"}, ...)` rejects the removed automation command while `setup` and `hook` dispatch remain valid.
- [ ] Run `go test ./cmd/euphony -run 'TestRun|TestMaybeOfferAgentSetup' -count=1` and confirm the new rejection test fails before implementation.
- [ ] Remove the automation dispatcher, v1 routes, Unix listener, client packages, schema, docs, and obsolete tests; retain setup/hook and browser HTTP startup.
- [ ] Run `gofmt` on changed Go files and `go test ./cmd/euphony ./internal/server -count=1`.
- [ ] Remove automation-only Makefile targets/documentation while keeping normal build, dev, and test targets coherent.
- [ ] Commit with `git add -A && git commit -m "refactor: remove external automation interface"`.

### Task 2: Remove Tasks feature

**Files:**
- Modify: `web/src/App.tsx`, `web/src/api.ts`, `web/src/types.ts`, `web/src/components/SessionNavigation.tsx`, related tests and `web/src/styles.css`
- Delete: `web/src/components/TasksView.tsx`, `web/src/components/TasksView.test.tsx`, `internal/tasks/*`, `internal/server/tasks.go`, `internal/server/tasks_test.go`
- Modify: `internal/server/server.go`, server asset tests, README/docs references if present

**Interfaces:**
- The app continues to support terminal sessions, Inbox, project navigation, and agent logs.
- No `/api/tasks` request is made and no Tasks navigation item or `/tasks` dashboard route remains.

- [ ] Add a failing App/navigation assertion that Tasks is absent and `/api/tasks` is never requested.
- [ ] Run the focused App/navigation tests and confirm the new assertions fail against the current Tasks implementation.
- [ ] Remove Tasks state, route parsing, dashboard pane, handlers, service lifecycle, storage package, client methods, types, navigation props, styles, fixtures, and tests.
- [ ] Run focused web tests, typecheck, and Go server tests; fix only removal-related fallout.
- [ ] Commit with `git add -A && git commit -m "refactor: remove tasks feature"`.

### Task 3: Normalize agent-log media and filter Codex runtime messages

**Files:**
- Modify: `internal/agentlog/types.go`, `internal/agentlog/parser.go`, `internal/agentlog/parser_test.go`, `internal/server/agent_log_test.go`
- Modify: `web/src/types.ts`, `web/src/components/AgentLogView.tsx`, `web/src/components/AgentLogView.test.tsx`, `web/src/styles.css`

**Interfaces:**
- Add a serialized media entry with `kind` (`image` or `video`), `url`, optional `mimeType`, and optional `alt`.
- Supported Claude and Codex transcript block shapes normalize to that entry; invalid/oversized sources produce no entry.
- Codex runtime-injected context is filtered in the parser before it reaches the API or browser.

- [ ] Add failing Go parser tests for Claude image/video blocks, Codex image/video blocks, ordinary user text, and the two injected Codex payload forms.
- [ ] Run `go test ./internal/agentlog -run 'TestParse' -count=1` and confirm the new tests fail for the missing media/filter behavior.
- [ ] Implement bounded URL normalization and media entries without changing tool grouping or cursor behavior.
- [ ] Run the parser and server agent-log tests.
- [ ] Add failing React tests for responsive image rendering, controllable video rendering, and omission of injected entries.
- [ ] Run the focused AgentLogView tests and confirm they fail before the UI implementation.
- [ ] Implement semantic media rendering with alt text, video controls, and responsive styles; keep Markdown sanitization unchanged.
- [ ] Run focused web tests and typecheck.
- [ ] Commit with `git add -A && git commit -m "feat: render agent log media safely"`.

### Task 4: Name the primary panes internally

**Files:**
- Modify: `web/src/components/SessionNavigation.tsx`, `web/src/components/SessionInfoPane.tsx`, `web/src/components/TerminalPane.tsx`, `AGENTS.md`
- Test: relevant component tests

**Interfaces:**
- Add `data-pane-name="agent-list"`, `data-pane-name="information-pane"`, and `data-pane-name="terminal-pane"` to the existing root surfaces.
- Do not add visible copy or change accessible labels.

- [ ] Add failing component assertions for the three data attributes.
- [ ] Run the focused component tests and confirm the assertions fail before implementation.
- [ ] Add the attributes and document the internal names in `AGENTS.md`.
- [ ] Run focused component tests and typecheck.
- [ ] Commit with `git add AGENTS.md web/src/components && git commit -m "docs: name primary workspace panes"`.

### Task 5: Integrate, verify, and update the TODO

**Files:**
- Modify: `/Users/ryotarai/Library/Mobile Documents/iCloud~md~obsidian/Documents/ryotarai/Euphony/Euphony TODO.md`

- [ ] Review the merged diff against every active TODO item and confirm both Tasks and public automation are absent while browser functionality remains.
- [ ] Run `go test ./...`.
- [ ] Run `cd web && npm test -- --run` and `npm run typecheck`.
- [ ] Run `cd web && npm run build`.
- [ ] Run the relevant Playwright smoke tests with an isolated backend/database when available.
- [ ] Change only the six active TODO checkboxes to `[x]`; leave the `Pending` section unchanged.
- [ ] Commit and merge the verified worktree into `main`.
