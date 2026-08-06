# Terminal GPU Compositor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce WindowServer GPU/compositor work when a running Codex terminal is open without changing terminal bytes or interaction behavior.

**Architecture:** A focused `TerminalOutputScheduler` batches live `Uint8Array` output for 50ms and flushes it in order. xterm keeps its WebGL renderer but uses an opaque surface, while the sidebar running icon remains static instead of driving a perpetual compositor animation.

**Tech Stack:** React 19, TypeScript, xterm.js, Vitest, Vite, Playwright.

## Global Constraints

- Preserve terminal bytes losslessly and in arrival order.
- Preserve history replay, resize negotiation, terminal input, selection, links, and WebGL fallback.
- Keep the running status accessible and visually distinct without an infinite animation.
- Do not modify unrelated base worktree changes.
- Use TDD: each production behavior change has a failing test observed before implementation.

---

### Task 1: Add the live output scheduler

**Files:**
- Create: `web/src/components/terminalOutputScheduler.ts`
- Create: `web/src/components/terminalOutputScheduler.test.ts`

**Interfaces:**
- Produces `createTerminalOutputScheduler(write, intervalMs?)` with `enqueue`, `flush`, and `dispose`.
- `write` receives one concatenated `Uint8Array` for each scheduled flush.

- [ ] **Step 1: Write failing scheduler tests**

Cover these exact behaviors:

```ts
test("batches chunks without changing byte order", () => {
  vi.useFakeTimers();
  const write = vi.fn();
  const scheduler = createTerminalOutputScheduler(write, 50);

  scheduler.enqueue(Uint8Array.from([1, 2]));
  scheduler.enqueue(Uint8Array.from([3]));
  vi.advanceTimersByTime(49);
  expect(write).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);

  expect(write).toHaveBeenCalledOnce();
  expect(Array.from(write.mock.calls[0][0])).toEqual([1, 2, 3]);
  vi.useRealTimers();
});

test("flushes pending bytes when disposed", () => {
  vi.useFakeTimers();
  const write = vi.fn();
  const scheduler = createTerminalOutputScheduler(write, 50);

  scheduler.enqueue(Uint8Array.from([4, 5]));
  scheduler.dispose();

  expect(write).toHaveBeenCalledOnce();
  expect(Array.from(write.mock.calls[0][0])).toEqual([4, 5]);
  vi.useRealTimers();
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run `npm test -- --run src/components/terminalOutputScheduler.test.ts` from `web/`.
Expected: the test fails because the scheduler module does not exist.

- [ ] **Step 3: Implement the minimal scheduler**

Queue non-empty chunks, install one timer, concatenate queued chunks into a
single `Uint8Array`, call `write`, and clear the timer. `dispose` must flush
before preventing future enqueues.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same focused command and confirm both tests pass.

- [ ] **Step 5: Commit the scheduler**

Run `git add web/src/components/terminalOutputScheduler.ts web/src/components/terminalOutputScheduler.test.ts && git commit -m "perf(web): batch live terminal output"`.

### Task 2: Integrate terminal output batching and opaque rendering

**Files:**
- Modify: `web/src/components/TerminalView.tsx`
- Modify: `web/src/components/terminalUtils.ts`
- Modify: `web/src/components/TerminalView.test.tsx`

**Interfaces:**
- Consumes `createTerminalOutputScheduler` from Task 1.
- Produces live output batching after the accepted resize without altering
  history replay or terminal input.

- [ ] **Step 1: Add failing terminal option assertion**

Extend the `terminalOptions` test to assert `allowTransparency` is `false`.

- [ ] **Step 2: Run the focused terminal test and verify RED**

Run `npm test -- --run src/components/TerminalView.test.tsx`.
Expected: the new assertion fails because the option is currently `true`.

- [ ] **Step 3: Add a failing live-output integration test**

Use the existing fake socket and terminal driver. After the first accepted
resize, send two output messages, assert the fake terminal has no writes before
50ms, advance the timer, and assert one write containing both decoded chunks.

- [ ] **Step 4: Run the focused test and verify RED**

Run the same focused terminal test. Expected: the new timing assertion fails
because output is currently written immediately.

- [ ] **Step 5: Configure opaque xterm rendering**

Change only `allowTransparency` from `true` to `false` in `terminalOptions`.

- [ ] **Step 6: Integrate the scheduler into live output**

Create one scheduler per terminal effect. Route only accepted-size live output
through it. Flush it before exit/error text and during effect cleanup; preserve
the existing direct writes for history and pre-size data. Dispose it after the
final flush.

- [ ] **Step 7: Run focused terminal tests and verify GREEN**

Run `npm test -- --run src/components/TerminalView.test.tsx` and confirm the
full file passes.

- [ ] **Step 8: Commit terminal changes**

Run `git add web/src/components/TerminalView.tsx web/src/components/terminalUtils.ts web/src/components/TerminalView.test.tsx && git commit -m "perf(web): reduce terminal compositor updates"`.

### Task 3: Remove the perpetual running animation

**Files:**
- Modify: `web/src/styles.css`
- Create: `web/src/styles.test.ts`

**Interfaces:**
- Preserves `.session-status-running` as the status class while making its
  computed animation static.

- [ ] **Step 1: Write the failing CSS contract test**

Read the stylesheet as a raw module and assert the running selector contains
`animation: none` and the standalone `session-status-spin` keyframe is absent.

- [ ] **Step 2: Run the focused stylesheet test and verify RED**

Run `npm test -- --run src/styles.test.ts`.
Expected: the test fails because the selector currently references the
infinite keyframe.

- [ ] **Step 3: Make the running indicator static**

Keep the loader icon and status class but set `animation: none` and remove the
unused `session-status-spin` keyframe.

- [ ] **Step 4: Run focused navigation and stylesheet tests**

Run `npm test -- --run src/components/SessionNavigation.test.tsx src/styles.test.ts`.
Expected: all tests pass and the running label/class assertions remain intact.

- [ ] **Step 5: Commit the CSS change**

Run `git add web/src/styles.css web/src/styles.test.ts && git commit -m "perf(web): stop running status animation"`.

### Task 4: Full verification and integration

**Files:**
- No changes expected unless verification exposes a focused regression.

- [ ] **Step 1: Run the complete web unit suite**

Run `npm test -- --run` from `web/`. Record any unrelated baseline timeout
separately from failures introduced by this branch.

- [ ] **Step 2: Run typecheck and production build**

Run `npm run typecheck && npm run build` from `web/`.

- [ ] **Step 3: Run React Doctor on changed files**

Run `npx react-doctor@latest --verbose --scope changed` from `web/` and fix
any introduced regressions before committing.

- [ ] **Step 4: Run terminal Playwright coverage**

Run `npm run e2e -- e2e/terminal-reliability.spec.ts --workers=1` from `web/`
when the isolated local backend is available.

- [ ] **Step 5: Inspect final diff and commit**

Run `git diff --check`, `git status --short --branch`, and commit any remaining
verified integration changes.

- [ ] **Step 6: Merge the verified branch into main**

From the base worktree, merge `codex/gpu-compositor-fix` without touching the
pre-existing `web/dist/.keep` deletion or untracked `tmp/` files.
