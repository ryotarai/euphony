# Pane Files Tab Implementation Plan

## Task 1: Add the bounded workspace reader

**Files**

- Create `internal/workspacefiles/types.go`
- Create `internal/workspacefiles/reader.go`
- Create `internal/workspacefiles/reader_test.go`

Write failing tests for Git-root fallback, lazy directory sorting, invalid path
rejection, contained and escaping symlinks, bounded search, UTF-8 reads, binary
detection, and truncation. Implement only enough reader behavior to make each
test pass.

## Task 2: Expose authenticated session endpoints

**Files**

- Create `internal/server/workspace_files.go`
- Create `internal/server/workspace_files_test.go`
- Modify `internal/server/server.go`

Write failing handler tests, register protected routes, resolve roots from the
stored terminal cwd, map typed reader errors to the API error contract, and
return JSON models.

## Task 3: Add frontend API types and client methods

**Files**

- Modify `web/src/types.ts`
- Modify `web/src/api.ts`
- Modify `web/src/api.test.ts`

Add typed directory, search, and file responses. Write URL-encoding tests before
implementing the client methods.

## Task 4: Build the read-only Files view

**Files**

- Create `web/src/components/WorkspaceFilesView.tsx`
- Create `web/src/components/WorkspaceFilesView.test.tsx`
- Modify `web/src/styles.css`

Test initial loading, directory expansion, root search, file selection, binary
and truncation states, refresh, and stale responses. Build the navigator-right
layout, narrow-pane container query, and restrained empty/error states.

## Task 5: Integrate the pane source

**Files**

- Modify `web/src/components/TerminalPane.tsx`
- Modify `web/src/components/TerminalPane.test.tsx`

Write failing tests for the Files tab and shortcut sequence, then add the source
without unmounting or resizing the terminal.

## Task 6: Verify and integrate

Run focused Go and Vitest suites, the complete Go and frontend suites, lint,
production build, and a Playwright smoke test. Request code review, address
findings, commit the worktree, and merge the feature branch into the base branch
while preserving pre-existing dirty files.
