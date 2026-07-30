# Pane Changes Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only pane source for browsing the current terminal repository's local Git changes.

**Architecture:** A focused Go package turns porcelain Git status and unified patches into a normalized snapshot. An authenticated session endpoint exposes that snapshot, and a React view polls it only while its pane-local Changes source is visible.

**Tech Stack:** Go `os/exec`, `net/http`, React 19, TypeScript, Vitest, Testing Library, CSS container queries, Playwright.

## Global Constraints

- The feature is read-only; do not stage, edit, commit, push, or change Git configuration.
- Preserve the terminal's negotiated size claim while switching pane sources.
- Retain the selected changed file across refreshes when it still exists.
- Limit retained Git output and report truncation visibly.
- Poll only while the Changes source is visible.
- Treat every status-derived filename as a literal Git pathspec.
- Schedule refreshes serially after the previous Git request completes.

---

### Task 1: Normalize Git changes

**Files:**
- Create: `internal/gitchanges/types.go`
- Create: `internal/gitchanges/reader.go`
- Test: `internal/gitchanges/reader_test.go`

**Interfaces:**
- Produces: `gitchanges.Read(ctx context.Context, repoRoot string) (gitchanges.Snapshot, error)`
- Produces: `gitchanges.ErrNotRepository`
- Produces: JSON-ready `Snapshot`, `File`, `Hunk`, and `Line` types.

- [ ] **Step 1: Write failing repository-reader tests**

Create temporary repositories with literal tracked, staged, renamed, deleted,
and untracked files. Assert branch metadata, status labels, addition/deletion
counts, old/new line numbers, paths containing spaces, and a truncated patch.

- [ ] **Step 2: Run the reader tests and verify RED**

Run: `go test ./internal/gitchanges -run TestRead -v`

Expected: FAIL because the package and `Read` contract do not exist.

- [ ] **Step 3: Implement the bounded reader**

Run `git status --porcelain=v2 --branch -z --untracked-files=all`, parse records
without splitting paths on whitespace, and invoke `git diff` with discrete
arguments for each returned path. Convert `@@ -old +new @@` hunks into numbered
lines. Retain at most 200 files and 1 MiB of patch output per file.

- [ ] **Step 4: Run the reader tests and verify GREEN**

Run: `go test ./internal/gitchanges -v`

Expected: PASS with all fixtures read from real Git repositories.

### Task 2: Expose the authenticated session endpoint

**Files:**
- Create: `internal/server/git_changes.go`
- Create: `internal/server/git_changes_test.go`
- Modify: `internal/server/server.go`

**Interfaces:**
- Consumes: `gitchanges.Read(context.Context, string) (gitchanges.Snapshot, error)`
- Produces: `GET /api/sessions/{id}/git-changes`.

- [ ] **Step 1: Write failing handler tests**

Exercise the registered server handler with a real temporary Git repository.
Assert `200` and the normalized file content, plus the exact `404` error codes
for a missing terminal and a non-repository terminal.

- [ ] **Step 2: Run the handler tests and verify RED**

Run: `go test ./internal/server -run GitChanges -v`

Expected: FAIL with the route returning `api_not_found`.

- [ ] **Step 3: Implement and register the handler**

Resolve terminal metadata by route ID, call `gitchanges.Read`, map
`ErrNotRepository`, and set `Cache-Control: private, no-cache` on successful
responses.

- [ ] **Step 4: Run server tests and verify GREEN**

Run: `go test ./internal/server -run GitChanges -v`

Expected: PASS.

### Task 3: Add the Changes source and browser view

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Modify: `web/src/api.test.ts`
- Create: `web/src/components/GitChangesView.tsx`
- Create: `web/src/components/GitChangesView.test.tsx`
- Modify: `web/src/components/TerminalPane.tsx`
- Modify: `web/src/components/TerminalPane.test.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Produces: `ApiClient.getGitChanges(id: string): Promise<GitChangesSnapshot>`
- Produces: `<GitChangesView session={session} api={api} active={boolean} />`.

- [ ] **Step 1: Write failing API and component tests**

Assert the encoded endpoint path, a permanent Changes tab, shortcut cycling,
active-only polling, selected-file retention, changed-file selection, clean
state, non-repository guidance, and visible numbered additions/deletions.

- [ ] **Step 2: Run focused web tests and verify RED**

Run: `npm test -- --run src/api.test.ts src/components/TerminalPane.test.tsx src/components/GitChangesView.test.tsx`

Expected: FAIL because the API method, tab, and view do not exist.

- [ ] **Step 3: Implement the minimal React behavior**

Add the transport types and API call, include `"changes"` in the pane source
union and shortcut sequence, and build a polling view with semantic file
buttons, branch summary, empty/error/loading states, and a line-numbered diff.

- [ ] **Step 4: Add the responsive instrument styling**

Use the existing pane rail and neutral palette. Render the file navigator beside
the diff above 720px and above it below 720px. Use explicit `+`/`-` prefixes,
subtle line backgrounds, visible keyboard focus, and thin scrollbars.

- [ ] **Step 5: Run focused web tests and verify GREEN**

Run: `npm test -- --run src/api.test.ts src/components/TerminalPane.test.tsx src/components/GitChangesView.test.tsx`

Expected: PASS.

### Task 4: Verify in Chromium and merge

**Files:**
- Modify: `web/e2e/euphony.spec.ts`

**Interfaces:**
- Consumes: the complete authenticated Git Changes flow.

- [ ] **Step 1: Write the failing Playwright scenario**

Create an isolated repository under `/tmp`, commit a baseline, make tracked and
untracked changes, create a terminal with that cwd, open Changes, select both
files, and assert their rendered diff text.

- [ ] **Step 2: Run the scenario and verify RED before the implementation is available**

Run: `EUPHONY_E2E_PORT=18084 npx playwright test e2e/euphony.spec.ts --grep "browses Git changes" --workers=1`

Expected: FAIL because the Changes tab is absent.

- [ ] **Step 3: Run fresh complete verification**

Run: `go test ./...`

Run: `npm test -- --run`

Run: `npm run typecheck`

Run: `EUPHONY_E2E_PORT=18084 npx playwright test e2e/euphony.spec.ts --grep "browses Git changes" --workers=1`

Expected: all commands exit 0.

- [ ] **Step 4: Inspect the screenshot and diff**

Review the Playwright screenshot at desktop width, then run `git diff --check`
and inspect `git diff --stat` for unrelated changes.

- [ ] **Step 5: Commit and merge**

Commit the verified work on `codex/pane-changes-tab`, merge it into the current
base branch, and confirm the base worktree's pre-existing uncommitted changes
remain untouched.
