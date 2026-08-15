# All Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a searchable, newest-first All sessions modal that opens managed terminals and resumes exited Codex/Claude sessions retained by Euphony.

**Architecture:** Use persisted Euphony terminal metadata and agent summaries as the only All sessions source. Retain exited terminal metadata without restoring it as a live process. The server exposes a snapshot endpoint and a validated resume endpoint that uses argument-based process creation. The React app owns modal state and uses a focused `AllSessionsDialog` component; managed sessions are selected locally while exited database records call the resume endpoint.

**Tech Stack:** Go HTTP server, `internal/session` PTY manager, `internal/agentlog` JSONL readers, React 19, Vitest/Testing Library, Playwright.

## Global Constraints

- Put the sidebar `All sessions` control immediately above `Settings`.
- Keep the dialog approximately 80% of the viewport while remaining responsive on small screens.
- Filter on every keystroke across title, purpose, summary, directory, project, and agent.
- Sort every response newest first by `updatedAt`, with a stable ID tie-breaker.
- Reuse an existing managed terminal before creating a new one.
- Resume only `codex` and `claude`; pass the session ID as an argument, never by shell interpolation.
- Do not scan Codex or Claude transcript roots for All sessions.
- Retain exited terminal metadata in SQLite while excluding it from live terminal restoration.
- Write tests before production code for each new behavior and verify the expected failing test.
- Preserve unrelated dirty changes in the base checkout; all feature edits happen in `tmp/worktrees/all-sessions` or a dedicated child worktree.

## File map

- Modify `internal/session/manager.go`: add argument-based agent command creation, retain exited metadata, and expose stored metadata while preserving existing command APIs.
- Modify `internal/session/manager_test.go`: test argument-based process creation.
- Modify `internal/control/terminal.go`: expose argument-based terminal creation and selection.
- Modify `internal/control/terminal_test.go`: cover argument-based terminal creation.
- Create `internal/server/all_sessions.go`: API types, DB-only agent merge, list, and resume handlers.
- Create `internal/server/all_sessions_test.go`: HTTP DB-only list/resume/reuse behavior.
- Modify `internal/server/server.go`: register the protected all-sessions routes and retain the Codex index path.
- Modify `internal/server/server_test.go` or the new all-sessions test: route/auth coverage where needed.
- Modify `web/src/types.ts`: add the `AllSession` and resume result types.
- Modify `web/src/api.ts` and `web/src/api.test.ts`: add list/resume client methods and request assertions.
- Create `web/src/components/AllSessionsDialog.tsx`: modal layout, filtering, ordering, row actions, loading/error/empty states.
- Create `web/src/components/AllSessionsDialog.test.tsx`: component behavior tests.
- Modify `web/src/components/SessionNavigation.tsx` and its tests: footer button placement and mobile behavior.
- Modify `web/src/App.tsx` and its tests: load modal data, select managed sessions, resume history-only sessions, and surface errors.
- Modify `web/src/styles.css`: modal rows, activity rail, metadata, responsive layout, and focus states.
- Add `web/e2e/all-sessions.spec.ts` only if the existing E2E harness can create isolated Codex/Claude transcript fixtures without external credentials.

### Task 1: Retain exited database terminals

**Files:** `internal/session/manager.go`, `internal/session/manager_test.go`.

- [ ] Write a failing test proving an exited terminal remains in SQLite with its agent/session metadata and is not restored as a live process.
- [ ] Keep explicit terminal deletion destructive while process exit archives final metadata.
- [ ] Expose current plus archived metadata for the All sessions endpoint.
- [ ] Run `go test ./internal/session`.

### Task 2: Add argument-based terminal creation

**Files:** `internal/session/manager.go`, `internal/session/manager_test.go`, `internal/control/terminal.go`, `internal/control/terminal_test.go`.

- [ ] Write a failing manager test proving a requested executable receives `resume` and a session ID as separate arguments.
- [ ] Run the focused test and confirm the existing command-only API cannot satisfy it.
- [ ] Add `CreateWithCommandArgs` and the project-scoped equivalent, then thread the arguments through control selection without changing existing command-only callers.
- [ ] Keep process names, hooks, persistence, and cleanup identical to the existing terminal creation path.
- [ ] Run focused manager/control tests and `go test ./internal/session ./internal/control`.
- [ ] Commit with `feat: support argument-based terminal commands`.

### Task 3: Expose list and resume HTTP APIs

**Files:** `internal/server/all_sessions.go`, `internal/server/server.go`, `internal/server/all_sessions_test.go`, `web/src/types.ts`, `web/src/api.ts`, `web/src/api.test.ts`.

- [ ] Write server tests for DB-only filtering, open/exited merging, existing-terminal reuse, and Codex/Claude resume arguments before implementation.
- [ ] Run the focused server tests and confirm the routes/types are missing.
- [ ] Implement `GET /api/all-sessions` and `POST /api/all-sessions/{agent}/{sessionID}/resume`, including project-path matching, selection mode validation, safe agent allow-listing, and stale-database errors.
- [ ] Reuse a matching live terminal by `(agent, sessionID)`; otherwise resume a matching exited database record with `codex resume` or `claude --resume` and return `{terminal, selection}`.
- [ ] Add `ApiClient.listAllSessions()` and `ApiClient.resumeAllSession()` with request/response tests.
- [ ] Run `go test ./internal/server ./internal/session ./internal/control` and the focused Vitest API test.
- [ ] Commit with `feat: add all sessions API`.

### Task 4: Build the All sessions modal

**Files:** `web/src/components/AllSessionsDialog.tsx`, `web/src/components/AllSessionsDialog.test.tsx`, `web/src/styles.css`.

- [ ] Write failing component tests for incremental search across purpose/summary/cwd/project, newest-first ordering, open/resume labels, empty states, and row click callbacks.
- [ ] Run `npm test -- --run src/components/AllSessionsDialog.test.tsx` and verify failure for the missing component.
- [ ] Implement the responsive 80%-sized dialog using existing Dialog primitives, autofocus search input, normalized query filtering, keyboard-focusable rows, and the graphite/lime visual treatment.
- [ ] Keep list rendering independent of API details so it can be tested with fixture records.
- [ ] Run the focused component tests and `npm run typecheck`.
- [ ] Commit with `feat: add all sessions dialog`.

### Task 5: Connect navigation and app behavior

**Files:** `web/src/components/SessionNavigation.tsx`, `web/src/components/SessionNavigation.test.tsx`, `web/src/App.tsx`, `web/src/App.test.tsx`.

- [ ] Write failing tests for the button order, opening the modal, selecting a managed terminal, and resuming an exited database item into the selected pane.
- [ ] Run the focused Vitest tests and verify the expected missing callback/API behavior.
- [ ] Add the footer callback above Settings, load the all-session snapshot on open, retain modal state while loading/errors occur, select existing terminal IDs, and call resume for exited database rows.
- [ ] Update sessions and selection from the resume response before closing the modal; prevent duplicate resume requests while one is active.
- [ ] Run focused App/navigation tests, the complete Vitest suite, and web typecheck/build.
- [ ] Commit with `feat: connect all sessions navigation`.

### Task 6: Verify and integrate

- [ ] Run `gofmt` on changed Go files and `git diff --check`.
- [ ] Run `go test ./...`.
- [ ] Run `npm test -- --run`, `npm run typecheck`, and `npm run build` in the web workspace after dependencies are available.
- [ ] Run targeted Playwright coverage with the isolated E2E database/port if transcript fixtures can be created without relying on a user's live agent credentials.
- [ ] Review the complete diff against this plan, fix any accessibility or responsive regressions, and commit any final fixes.
- [ ] Merge the feature branch back into the base branch without touching the base's unrelated dirty files.
