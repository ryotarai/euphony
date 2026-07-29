# Terminal Workspace Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent navigation, attention tracking, repository grouping, and
browser terminal behavior reliable for Claude Code and ordinary shells.

**Architecture:** Persist authoritative session metadata in Go, derive
selection and presentation state in React, and make the xterm/WebSocket
boundary explicitly synchronize size and replay state. Use Oriel's working
terminal lifecycle as the compatibility reference.

**Tech Stack:** Go 1.24, SQLite, React 19, TypeScript, xterm.js 6, Vitest,
Testing Library, and Playwright.

## Global Constraints

- User-facing communication is Japanese; code and documentation are English.
- Work only in `tmp/worktrees/fix-all-terminal-issues`.
- Preserve the existing Euphony visual system.
- Every production behavior change starts with a failing test.
- Use Playwright where browser/xterm behavior provides stronger evidence.

---

### Task 1: Session creation context and repository identity

**Files:**
- Modify: `internal/session/manager.go`
- Modify: `internal/server/sessions.go`
- Modify: `internal/session/manager_test.go`
- Modify: `internal/server/sessions_test.go`
- Modify: `web/src/api.ts`
- Modify: `web/src/types.ts`

**Interfaces:**
- Consumes: `Manager.Create(ctx, name, cwd...)`
- Produces: `Metadata.RepoRoot string` and `ApiClient.createSession(name, cwd?)`

- [ ] Add failing tests for a custom existing directory, invalid directory,
  and linked-worktree main repository identity.
- [ ] Run the focused Go tests and confirm each fails for missing behavior.
- [ ] Resolve and validate `cwd`, derive `RepoRoot` from Git common-dir data,
  and expose the optional request field.
- [ ] Run the focused and complete Go test suites.

### Task 2: Agent attention transitions and stable titles

**Files:**
- Modify: `internal/session/manager.go`
- Modify: `internal/session/manager_test.go`
- Modify: `internal/server/sessions_test.go`

**Interfaces:**
- Consumes: `Manager.UpdateAgent(id, AgentUpdate)`
- Produces: normalized `AgentStatus` values including `attention`

- [ ] Add failing tests proving `running -> waiting` becomes `attention` and
  an empty event title preserves the previous title.
- [ ] Run the tests and confirm failures report the old transition/overwrite.
- [ ] Implement transition normalization and non-destructive title updates.
- [ ] Run all session and server tests.

### Task 3: Live filters, ordering, and repository groups

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/components/SessionNavigation.tsx`
- Modify: `web/src/components/SessionNavigation.test.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: `Session.repoRoot` and normalized activity
- Produces: repository/status navigation groups and synchronized selections

- [ ] Add failing tests for fixed activity ordering, shared repository groups,
  and removal of terminals that no longer match a checked filter.
- [ ] Run focused Vitest tests and verify the expected failures.
- [ ] Implement pure ordering/grouping helpers and recalculate filter matches
  from each server snapshot.
- [ ] Run the focused tests and typecheck.

### Task 4: Command palette and working-directory creation

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: existing select/status/create actions
- Produces: Command-K palette and `createSession(name, cwd)` flow

- [ ] Add failing keyboard and form tests for Command-K, status-only actions,
  terminal switching, and focused-session default `cwd`.
- [ ] Confirm focused tests fail because the dialog and request field are absent.
- [ ] Implement the accessible palette and new-terminal form.
- [ ] Run App tests and typecheck.

### Task 5: Attention notification

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/components/SessionNavigation.tsx`

**Interfaces:**
- Consumes: consecutive session snapshots
- Produces: one notification and tone per transition into `attention`

- [ ] Add a failing test that advances polling from running to attention and
  asserts a single notification.
- [ ] Confirm it fails without snapshot transition handling.
- [ ] Add guarded Notification and Web Audio adapters and an explicit enable
  control.
- [ ] Run the App tests.

### Task 6: Terminal protocol reliability

**Files:**
- Modify: `internal/session/manager.go`
- Modify: `internal/session/manager_test.go`
- Modify: `web/src/components/TerminalView.tsx`
- Modify: `web/src/components/TerminalView.test.tsx`

**Interfaces:**
- Consumes: xterm driver writes, resize events, and WebSocket lifecycle
- Produces: open-time resize, completed history replay, and Shift+Enter LF

- [ ] Add failing tests for UTF-8 PTY locale, WebSocket-open current-size
  synchronization, asynchronous history replay input suppression, and
  Shift+Enter.
- [ ] Run focused Go and Vitest tests and verify failures.
- [ ] Extend the terminal driver with dimensions, write completion, and a
  custom key handler; implement coalesced fit and replay suppression.
- [ ] Run all terminal tests and typecheck.

### Task 7: Browser verification and regression suite

**Files:**
- Modify: `web/e2e/euphony.spec.ts`
- Modify: `AGENTS.md` only if this task reveals a reusable workflow lesson

**Interfaces:**
- Consumes: complete backend/frontend behavior
- Produces: browser-level regression evidence

- [ ] Add Playwright coverage for palette navigation, live filtering, working
  directory creation, Shift+Enter, terminal resizing, and repeated visibility.
- [ ] Run Playwright against the development server and inspect screenshots.
- [ ] Run `make test`, `npm run build`, and review `git diff --check`.
- [ ] Review the complete diff for unrelated changes and document any
  environment-dependent behavior that cannot be automated.
