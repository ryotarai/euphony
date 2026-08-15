# Pierre Diffs and Trees Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use `@pierre/diffs/react` for the Changes diff and read-only Files code surfaces, and `@pierre/trees/react` for the Files navigator while preserving Euphony's existing bounded APIs and pane behavior.

**Architecture:** Keep the Go transport and React state machines intact. Add small adapters at the UI boundary: normalized Git hunks become a bounded unified patch for `PatchDiff`, and loaded workspace entries become canonical path strings for `FileTree`. Keep server-side search and lazy directory fetches outside the Pierre shadow DOM.

**Tech Stack:** React 19, TypeScript, `@pierre/diffs` 1.3.x, `@pierre/trees` 1.0.0-beta.x, Vitest, Testing Library, Playwright, existing CSS custom properties.

## Global Constraints

- Preserve the read-only feature; no edit, stage, rename, drag, context-menu, or Git mutation controls.
- Preserve current API methods, bounded response limits, polling cadence, lazy directory loading, and stale-response guards.
- Preserve pane source selection and negotiated PTY size while switching or splitting sources.
- Use Pierre's React entry points and keep all code/docs in English.
- Keep the existing base worktree's unrelated dirty files untouched.

---

### Task 1: Add the Pierre surface dependencies and design records

**Files:**
- Modify: `web/package.json`
- Modify: `web/package-lock.json`
- Create: `docs/superpowers/specs/2026-08-15-pierre-diffs-trees-design.md`
- Create: `docs/superpowers/plans/2026-08-15-pierre-diffs-trees.md`

- [x] Install `@pierre/diffs` and `@pierre/trees` with npm and record the lockfile.
- [x] Record the boundary adapters, preserved behavior, CSS direction, and test strategy in the design document.
- [x] Record the implementation checkpoints in this plan.

### Task 2: Replace the Changes diff surface

**Files:**
- Modify: `web/src/components/GitChangesView.tsx`
- Create or modify: `web/src/components/gitDiffAdapter.ts`
- Test: `web/src/components/GitChangesView.test.tsx`
- Test: `web/src/components/gitDiffAdapter.test.ts`

**Interfaces:**
- `gitChangedFileToPatch(file: GitChangedFile): string | null` returns a bounded unified patch or `null` when the file has no textual patch.
- `GitChangesView` continues to consume `ApiClient.getGitChanges(id, path?)` and exposes the same region and file selection semantics.

- [ ] Write adapter tests for a modified file, added file, deleted file, renamed file, and a no-newline metadata line.
- [ ] Run the adapter and Changes tests and confirm they fail because the Pierre boundary does not exist.
- [ ] Implement the adapter and render selected text patches through `PatchDiff` inside `WorkerPoolContextProvider`.
- [ ] Keep binary, loading, empty, truncation, clean worktree, non-repository, and refresh-failure states outside the Pierre surface.
- [ ] Run the focused Changes tests and typecheck.

### Task 3: Replace the Files navigator and code surface

**Files:**
- Modify: `web/src/components/WorkspaceFilesView.tsx`
- Create or modify: `web/src/components/workspaceTreeAdapter.ts`
- Test: `web/src/components/WorkspaceFilesView.test.tsx`
- Test: `web/src/components/workspaceTreeAdapter.test.ts`

**Interfaces:**
- `workspaceEntriesToPierrePaths(directories: Record<string, WorkspaceDirectory>): string[]` returns deduplicated file paths and trailing-slash directory paths.
- `WorkspaceFilesView` keeps the existing `WorkspaceDirectory`, `WorkspaceSearchResult`, and `WorkspaceFile` API contracts.

- [ ] Write adapter tests for canonical directory paths, deduplication, and non-file entries.
- [ ] Run focused Files tests and confirm they fail because the Pierre tree host is absent.
- [ ] Create one stable `useFileTree` model and reset it with the currently loaded paths after root/child responses.
- [ ] Bridge composed tree clicks and selection callbacks to the existing lazy directory and file request functions.
- [ ] Render read-only text through Pierre `File`, while preserving the custom header and binary/truncation/empty/error states.
- [ ] Run the focused Files tests and typecheck.

### Task 4: Tune the shared pane styling

**Files:**
- Modify: `web/src/styles.css`
- Test: `web/src/components/GitChangesView.test.tsx`
- Test: `web/src/components/WorkspaceFilesView.test.tsx`

- [ ] Style Pierre diff variables for the existing dark console palette, split layout, syntax text, additions/deletions, gutters, headers, and scroll tracks.
- [ ] Style the Pierre tree host for compact density, selection, focus, file/folder text, borders, and the existing right-side Files navigator.
- [ ] Keep the 720px container-query layout and ensure shadow-DOM hosts fill their pane without affecting PTY sizing.
- [ ] Assert the Pierre host elements remain present and accessible in focused component tests.

### Task 5: Verify actual behavior and integrate

**Files:**
- Modify if needed: `web/e2e/euphony.spec.ts`

- [ ] Run `npm test -- --run src/components/GitChangesView.test.tsx src/components/WorkspaceFilesView.test.tsx src/components/TerminalPane.test.tsx`.
- [ ] Run `npm run typecheck` and `npm run build`.
- [ ] Run `npm test -- --run` for the complete frontend suite.
- [ ] Run the isolated Playwright smoke test against a temporary Git workspace and verify the real Pierre shadow-DOM diff and tree surfaces.
- [ ] Inspect a desktop screenshot, run `git diff --check`, and review `git diff --stat` for unrelated changes.
- [ ] Commit the verified worktree and merge the feature branch into `main`, preserving the base worktree's pre-existing dirty files.
