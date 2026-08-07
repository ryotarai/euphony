# Terminal WebGL Context-Loss Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an xterm terminal leave a lost WebGL canvas immediately and render through xterm's DOM renderer instead of showing a black terminal area.

**Architecture:** Keep `WebglAddon` as the normal renderer. Extend the existing `loadWebglRenderer` adapter to inspect the opened terminal element for WebGL2 canvases and route both the native canvas loss event and xterm's delayed `onContextLoss` event through one idempotent disposal callback. xterm's supported addon disposal path restores the DOM renderer and repaints the existing buffer; the WebSocket, PTY size claim, and output batching remain untouched.

**Tech Stack:** React 19, TypeScript, xterm.js 6, xterm WebGL addon, Vitest, Testing Library, Playwright, Vite.

## Global Constraints

- Communicate with users in Japanese, but write code and repository documents in English.
- Work only in the isolated worktree at `tmp/worktrees/fix-terminal-black-screen`.
- Preserve the existing WebGL renderer for healthy contexts and preserve the existing delayed addon fallback as a safety net.
- Do not change terminal protocol messages, negotiated PTY dimensions, output byte order, pane selection, or terminal styling.
- Follow TDD: write and run a failing regression test before production changes, then run the focused and full verification commands.

---

### Task 1: Add immediate native WebGL context-loss fallback

**Files:**
- Modify: `web/src/components/terminalUtils.ts:46-65`
- Modify: `web/src/components/TerminalView.tsx:119-132,258-270`
- Test: `web/src/components/TerminalView.test.tsx:88-120`

**Interfaces:**
- Consumes: xterm's `Terminal.loadAddon`, optional `Terminal.element`, `WebglRendererAddon.onContextLoss`, and `HTMLCanvasElement`'s `webglcontextlost` event.
- Produces: `loadWebglRenderer` still returns `boolean`, but accepts a terminal adapter with an optional `element` and disposes its loaded addon at most once when either context-loss signal fires.

- [ ] **Step 1: Write the failing unit test for the native event**

Add a test immediately after the existing WebGL addon tests in
`web/src/components/TerminalView.test.tsx`. Create a host containing a fake
canvas, make `getContext("webgl2")` return a non-null object, load a fake addon
through `loadWebglRendererUtil`, emit `webglcontextlost`, and assert that the
addon's `dispose` was called once.

```tsx
test("disposes the WebGL addon immediately when its canvas loses context", () => {
  const host = document.createElement("div");
  const canvas = document.createElement("canvas");
  vi.spyOn(canvas, "getContext").mockImplementation((kind) =>
    kind === "webgl2" ? {} as WebGL2RenderingContext : null,
  );
  host.append(canvas);
  const dispose = vi.fn();
  const addon = {
    activate: () => undefined,
    dispose,
    onContextLoss: () => ({ dispose: () => undefined }),
  };

  expect(loadWebglRendererUtil({ element: host, loadAddon: vi.fn() }, () => addon)).toBe(true);

  canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));

  expect(dispose).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the focused test and verify it fails for the missing observer**

Run:

```bash
cd web
npm test -- --run src/components/TerminalView.test.tsx -t "disposes the WebGL addon immediately"
```

Expected: FAIL because the current helper does not inspect the terminal host
or subscribe to `webglcontextlost`; it must not fail due to a test setup or
TypeScript error.

- [ ] **Step 3: Implement the smallest guarded disposal path**

In `web/src/components/terminalUtils.ts`:

1. Extend the `loadWebglRenderer` terminal parameter type with
   `readonly element?: HTMLElement`.
2. Create the addon and a local `disposed` boolean.
3. Route the existing `addon.onContextLoss` callback through an idempotent
   `disposeAddon` function.
4. Call `terminal.loadAddon(addon)` before inspecting canvases so the addon has
   created its WebGL canvas.
5. Query `terminal.element?.querySelectorAll("canvas")`, retain canvases whose
   `getContext("webgl2")` is non-null, and attach a one-shot
   `webglcontextlost` listener that calls `disposeAddon`.
6. Keep the existing try/catch, warning, and `true`/`false` return contract.

The core shape should remain:

```ts
let disposed = false;
const disposeAddon = () => {
  if (disposed) return;
  disposed = true;
  addon.dispose();
};

addon.onContextLoss?.(disposeAddon);
terminal.loadAddon(addon);
for (const canvas of webglCanvases(terminal.element)) {
  canvas.addEventListener("webglcontextlost", disposeAddon, { once: true });
}
```

Use a small local helper if needed to keep WebGL canvas discovery readable and
to safely treat absent elements or unavailable contexts as an empty list.

In `web/src/components/TerminalView.tsx`, pass the opened xterm element to the
helper after `terminal.open(element)`, while keeping the existing injected
`TerminalDriver` contract unchanged.

- [ ] **Step 4: Run the focused unit tests and verify green**

Run:

```bash
cd web
npm test -- --run src/components/TerminalView.test.tsx
```

Expected: all `TerminalView` tests pass, including the native event test and
the existing delayed `onContextLoss` safety-net test. No resize or WebSocket
assertions should change.

- [ ] **Step 5: Commit the focused implementation**

```bash
git add web/src/components/terminalUtils.ts web/src/components/TerminalView.tsx web/src/components/TerminalView.test.tsx
git commit -m "fix(web): recover terminals after WebGL context loss"
```

### Task 2: Add a browser regression for the black-screen mechanism

**Files:**
- Modify: `web/e2e/terminal-reliability.spec.ts` near the terminal renderer tests

**Interfaces:**
- Consumes: the existing `clearSessions`, `createSession`, and `replaceSharedSelection` helpers plus the active terminal host.
- Produces: a Playwright assertion that a real WebGL canvas loss returns the terminal to DOM rows without waiting for xterm's three-second delayed event.

- [ ] **Step 1: Add the Playwright regression test**

Create a test that:

1. Clears sessions, creates one named `WebGL recovery`, selects it, and opens
   the app with the normal WebGL path enabled.
2. Waits for the terminal connection, focuses the terminal, and types a short
   marker such as `printf webgl-recovery-marker` followed by Enter.
3. Finds the canvas whose `getContext("webgl2")` is non-null. Skip the test with
   a clear reason only when the browser has no WebGL2 canvas at all.
4. Dispatches a cancelable `webglcontextlost` event on that canvas.
5. Asserts within one second that the terminal contains `.xterm-rows`, the
   marker is visible, and no WebGL canvas remains.

Use page-level DOM evidence for renderer selection rather than a screenshot so
the test remains deterministic in CI. The test must not call `disableWebgl`.

- [ ] **Step 2: Run the new test before and after the implementation**

Run:

```bash
cd web
EUPHONY_E2E_PORT=18083 npm run e2e -- e2e/terminal-reliability.spec.ts -g "WebGL context loss"
```

Expected before Task 1: the test waits for `.xterm-rows` until its one-second
assertion timeout because the current addon keeps the lost WebGL canvas during
the delayed fallback. Expected after Task 1: the test passes without a
three-second wait.

- [ ] **Step 3: Commit the browser regression**

```bash
git add web/e2e/terminal-reliability.spec.ts
git commit -m "test(web): cover WebGL context-loss recovery"
```

### Task 3: Run full verification and React diagnostics

**Files:**
- No additional source files; inspect the committed diff and generated build output only.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: fresh evidence that the fix does not regress terminal behavior, build health, React diagnostics, or Go integration tests.

- [ ] **Step 1: Run focused frontend tests**

```bash
cd web
npm test -- --run src/components/TerminalView.test.tsx src/components/PaneCarousel.test.tsx src/components/TerminalPane.test.tsx
```

Expected: all focused test files pass with zero failures.

- [ ] **Step 2: Run frontend typecheck and production build**

```bash
cd web
npm run typecheck
npm run build
```

Expected: both commands exit 0 without TypeScript errors. Build warnings about
large chunks may remain unchanged and are not treated as a new failure unless
the command exits non-zero.

- [ ] **Step 3: Run the complete frontend suite**

```bash
cd web
npm test -- --run
```

Expected: every test passes. If the known slow `WorkspaceFilesView` test hits
its existing five-second timeout again, record it separately and rerun that
test with its existing focused command before distinguishing it from this
change.

- [ ] **Step 4: Run React Doctor on changed files**

```bash
cd web
npx react-doctor@latest --verbose --scope changed
```

Expected: the changed-scope score does not regress from the baseline; fix any
new error or warning introduced by the patch before committing.

- [ ] **Step 5: Run the isolated browser suite and Go tests**

```bash
cd web
EUPHONY_E2E_PORT=18083 npm run e2e -- e2e/terminal-reliability.spec.ts
cd ..
go test ./...
```

Expected: all terminal reliability tests pass with one worker, and all Go
packages pass. The E2E server must use its configured in-memory database and
dedicated port.

- [ ] **Step 6: Inspect the final diff and commit any verification-only fixes**

```bash
git diff --check HEAD~2..HEAD
git status --short --branch
git log -3 --oneline
```

Expected: only the approved design, implementation, and regression-test files
are changed; no generated dependency or build artifacts are included.
