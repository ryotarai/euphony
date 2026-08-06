# Terminal GPU Compositor Implementation Plan

> For agentic workers: use TDD for behavior changes and verify the complete
> web client before merging.

**Goal:** Reduce WindowServer GPU/compositor work when a running Codex terminal
is open without changing terminal bytes or interaction behavior.

**Architecture:** Use xterm's DOM renderer instead of loading the WebGL addon,
keep the terminal surface opaque, and make the sidebar running indicator static
instead of driving a perpetual compositor animation.

## Global constraints

- Preserve terminal bytes, history replay, resize negotiation, input,
  selection, links, and terminal lifecycle behavior.
- Keep the running status accessible and visually distinct.
- Do not modify unrelated base worktree changes.
- Use an isolated git worktree and verify before merging.

### Task 1: Remove the WebGL renderer path

**Files:**

- Modify: `web/package.json`
- Modify: `web/package-lock.json`
- Modify: `web/src/components/TerminalView.tsx`
- Modify: `web/src/components/terminalUtils.ts`
- Modify: `web/src/components/TerminalView.test.tsx`
- Modify: `web/e2e/terminal-reliability.spec.ts`

1. Remove the `@xterm/addon-webgl` dependency and lockfile entry.
2. Remove `loadWebglRenderer` and the `WebglAddon` import.
3. Keep `Terminal.open()` as the only renderer initialization step so xterm's
   DOM renderer remains active.
4. Remove unit tests for the deleted addon loader and remove the E2E helper
   that artificially disables WebGL; the normal E2E path now covers DOM mode.
5. Keep and extend the terminal options assertion to require
   `allowTransparency: false`.

Run the focused terminal tests and verify the suite remains green.

### Task 2: Remove the perpetual running animation

**Files:**

- Modify: `web/src/styles.css`
- Create: `web/src/styles.test.ts`

Read the stylesheet source as text and assert the running selector contains
`animation: none` and the old `session-status-spin` keyframe is absent. Make
the selector static while preserving its class, color, icon, accessible label,
and row ordering. Run the focused navigation and stylesheet tests.

### Task 3: Full verification and integration

From `web/`:

1. Run `npm test -- --run`.
2. Run `npm run typecheck`.
3. Run `npm run build`.
4. Run React Doctor on the changed frontend scope.
5. Run `npm run e2e -- e2e/terminal-reliability.spec.ts --workers=1` with its
   isolated in-memory backend and dedicated port.
6. Run `git diff --check` and inspect the final diff.
7. Commit the verified branch and merge `codex/gpu-compositor-fix` into `main`
   without touching the base worktree's pre-existing changes.
