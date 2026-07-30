# Confirm Terminal Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a safe confirmation dialog before deleting a terminal session.

**Architecture:** Keep deletion state and API orchestration in `App`. Reuse the existing Base UI dialog and button components, and leave `SessionNavigation` as the source of the selected session.

**Tech Stack:** React 19, TypeScript, Base UI dialog, Testing Library, Vitest

## Global Constraints

- Preserve the existing `deleteSession(item: Session)` API and post-delete selection behavior.
- Cancellation and dialog dismissal must not call the delete endpoint.
- The cancel action must receive initial focus.
- UI copy is English and uses the existing dialog visual system.

---

### Task 1: Confirmation dialog behavior

**Files:**
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `SessionNavigation.onDelete(session: Session): void`
- Produces: an App-owned `Session | null` pending-delete state and a modal confirmation flow

- [ ] **Step 1: Write the failing integration test**

Update the existing create/delete test so clicking `Delete Claude` must open `Delete terminal?`, cancellation makes no DELETE request, reopening and clicking `Delete terminal` makes one DELETE request, and the session disappears.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- --run src/App.test.tsx -t "creates a terminal in the focused terminal cwd, selects it, and confirms deletion"`

Expected: FAIL because the current click immediately calls the DELETE endpoint and no confirmation dialog exists.

- [ ] **Step 3: Implement the minimal confirmation state and dialog**

Add `pendingDelete` state in `App`, change `SessionNavigation.onDelete` to populate it, and render the existing `Dialog` components with `Cancel` and destructive `Delete terminal` buttons. On confirmation, clear the pending state and call `deleteSession` once.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npm test -- --run src/App.test.tsx -t "creates a terminal in the focused terminal cwd, selects it, and confirms deletion"`

Expected: PASS.

- [ ] **Step 5: Run regression verification**

Run: `npm test -- --run`

Expected: all Vitest tests pass.

Run: `npm run build`

Expected: TypeScript and Vite build complete with exit code 0.

- [ ] **Step 6: Verify in Chromium**

Run the focused Playwright scenario against an isolated in-memory server, confirm the dialog opens, cancellation preserves the terminal, and confirmation deletes it.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-07-30-confirm-terminal-delete-design.md docs/superpowers/plans/2026-07-30-confirm-terminal-delete.md web/src/App.test.tsx web/src/App.tsx
git commit -m "feat: confirm terminal deletion"
```
