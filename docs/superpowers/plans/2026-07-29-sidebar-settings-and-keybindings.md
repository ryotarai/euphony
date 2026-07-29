# Sidebar Settings and Keybindings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify terminal labels, persist sidebar layout in SQLite, and add configurable tmux-style keyboard commands.

**Architecture:** Store one global settings row in the existing SQLite database and expose it through authenticated API endpoints. The React app loads settings with sessions, owns layout state and keyboard dispatch, and passes controlled values to the sidebar.

**Tech Stack:** Go `net/http`, `database/sql`, modernc SQLite, React, TypeScript, Vitest, Playwright.

## Global Constraints

- Default prefix is `Ctrl+B`.
- `c` creates and selects a terminal.
- `h` and `l` focus the previous and next visible pane.
- `n` and `p` select the next and previous terminal.
- `v` creates a terminal and adds it as a vertically split pane.
- Sidebar width is clamped to 180–600 pixels and persisted in SQLite.
- Sidebar collapsed state is persisted in SQLite.
- Terminal cards never render agent names or the generic `Terminal` name.
- Home paths render with `~`; overflowing paths preserve the right side.

---

### Task 1: SQLite settings and API

**Files:**
- Modify: `internal/session/sqlite_store.go`
- Modify: `internal/session/sqlite_store_test.go`
- Modify: `internal/session/manager.go`
- Create: `internal/server/settings.go`
- Modify: `internal/server/server.go`
- Create: `internal/server/settings_test.go`

**Interfaces:**
- Produces: `session.Settings{Prefix, SidebarWidth, SidebarCollapsed}`
- Produces: `Manager.Settings(context.Context)` and `Manager.UpdateSettings(context.Context, Settings)`
- Produces: `GET /api/settings` and `PATCH /api/settings`

- [x] Write failing store tests that reopen SQLite and assert `Ctrl+B`, width, and collapsed state persist.
- [x] Run `go test ./internal/session -run Settings` and confirm failure.
- [x] Add schema version 2 with a singleton `settings` table and validated load/save methods.
- [x] Write failing authenticated handler tests for GET and PATCH.
- [x] Add manager methods and server handlers; reject invalid prefixes and widths outside 180–600.
- [x] Run `go test ./internal/session ./internal/server`.

### Task 2: Keyboard command dispatcher

**Files:**
- Create: `web/src/keybindings.ts`
- Create: `web/src/keybindings.test.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`

**Interfaces:**
- Produces: `matchesPrefix(event, prefix)` for normalized modifier matching.
- Consumes: `Settings.prefix`.

- [x] Write failing tests for `Ctrl+B`, custom prefixes, and ignored editable targets.
- [x] Implement prefix normalization and matching.
- [x] Write failing App tests for `c`, `h`, `l`, `n`, `p`, and `v`.
- [x] Implement a two-keystroke dispatcher with a 1500ms prefix timeout.
- [x] Run the targeted Vitest files.

### Task 3: Controlled sidebar and settings dialog

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/types.ts`
- Modify: `web/src/components/SessionNavigation.tsx`
- Modify: `web/src/components/SessionNavigation.test.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `Settings` loaded by `ApiClient.getSettings()`.
- Produces: `ApiClient.updateSettings(settings)`.
- Produces: controlled sidebar width/collapse callbacks and a prefix settings dialog.

- [x] Keep the existing failing navigation tests for labels, path shortening, resize, and collapse.
- [x] Replace localStorage layout state with controlled settings callbacks.
- [x] Add API methods and load settings alongside sessions.
- [x] Add a settings dialog with a validated prefix text input and Save action.
- [x] Persist resize on drag end and collapse immediately through PATCH.
- [x] Run all frontend unit tests and typecheck.

### Task 4: Browser and full verification

**Files:**
- Modify: `web/e2e/euphony.spec.ts`

**Interfaces:**
- Verifies the public UI and API integration.

- [x] Add Playwright coverage for hidden generic labels, shortened cwd, resize, collapse, and prefix commands.
- [x] Run Playwright against the built Euphony server.
- [x] Run `git diff --check`, `make test`, `make build`, and `go test -race ./...`.
- [ ] Commit, fast-forward main, verify the merged commit, and remove the worktree.
