# Frontend Idle Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove unnecessary frontend work while an unchanged terminal remains open.

**Architecture:** Disable xterm's infinite cursor animation and preserve the existing `Session[]` state reference when a polling response is shallowly equal. Keep polling, transition detection, live output, and all workspace behavior unchanged.

**Tech Stack:** React 19, TypeScript, xterm.js 6, Vitest, Testing Library, Playwright

## Global Constraints

- Make all changes in the isolated task worktree.
- Use test-driven development and observe each regression test fail before changing production code.
- Do not change the Go server or terminal protocol.
- Preserve a visible bar cursor, session polling frequency, and changed-session behavior.

---

### Task 1: Stop the idle cursor animation

**Files:**
- Modify: `web/src/components/TerminalView.tsx:47-72`
- Test: `web/e2e/terminal-reliability.spec.ts`

**Interfaces:**
- Consumes: xterm's existing `cursorBlink` and `cursorStyle` options.
- Produces: a real terminal cursor with no `xterm-cursor-blink` class.

- [ ] **Step 1: Write the failing browser test**

Add this assertion after the terminal is connected and focused:

```ts
const cursor = page.locator(".xterm-cursor");
await expect(cursor).toHaveCount(1);
await expect(cursor).not.toHaveClass(/xterm-cursor-blink/);
```

- [ ] **Step 2: Run the focused browser test to verify it fails**

Run:

```sh
npm run e2e -- e2e/terminal-reliability.spec.ts
```

Expected: FAIL because the real cursor has the `xterm-cursor-blink` class.

- [ ] **Step 3: Disable cursor blinking**

Change the default xterm options:

```ts
const terminal = new Terminal({
  cursorBlink: false,
  cursorStyle: "bar",
  // existing options remain unchanged
});
```

- [ ] **Step 4: Run the focused browser test to verify it passes**

Run:

```sh
npm run e2e -- e2e/terminal-reliability.spec.ts
```

Expected: PASS with a visible static bar cursor.

### Task 2: Skip equal polling state updates

**Files:**
- Modify: `web/src/App.tsx:121-145`
- Modify: `web/src/App.tsx:393-415`
- Test: `web/src/App.test.tsx`

**Interfaces:**
- Produces: `sessionsEqual(left: Session[], right: Session[]): boolean`.
- Consumes: the existing ordered `Session[]` polling response.

- [ ] **Step 1: Write the failing integration test**

Render `App` with a terminal component that increments a render counter. Return
a fresh but equal session object from the 1,500 ms poll, then assert that the
counter remains at one:

```ts
test("does not render terminal panes again for an unchanged polling response", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      jsonResponse([{ ...runningSession }]),
    );
    let renders = 0;
    function TerminalProbe() {
      renders += 1;
      return <div aria-label="terminal probe" />;
    }

    render(
      <App
        initialToken="valid-token"
        initialSettings={defaultSettings}
        renderTerminal={() => <TerminalProbe />}
      />,
    );
    await screen.findByLabelText("terminal probe");
    expect(renders).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(renders).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```sh
npm test -- --run src/App.test.tsx -t "does not render terminal panes again"
```

Expected: FAIL because `setSessions(items)` creates a new state reference and
renders the terminal probe again.

- [ ] **Step 3: Add ordered shallow session equality**

Add:

```ts
export function sessionsEqual(left: Session[], right: Session[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((session, index) => {
    const next = right[index];
    if (!next) return false;
    const keys = Object.keys(session) as Array<keyof Session>;
    const nextKeys = Object.keys(next) as Array<keyof Session>;
    return (
      keys.length === nextKeys.length &&
      keys.every((key) => session[key] === next[key])
    );
  });
}
```

Replace the unconditional polling update with:

```ts
setSessions((current) =>
  current && sessionsEqual(current, items) ? current : items,
);
```

- [ ] **Step 4: Run the focused test and all frontend unit tests**

Run:

```sh
npm test -- --run src/App.test.tsx
npm test -- --run
npm run typecheck
```

Expected: all tests pass, including existing changed-session polling tests.

### Task 3: Verify and integrate

**Files:**
- Verify all modified files and documentation.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: a verified commit merged into the base branch.

- [ ] **Step 1: Run full verification**

Run:

```sh
make test
make build
cd web && npm run e2e -- e2e/terminal-reliability.spec.ts
```

Expected: Go tests, 102 frontend tests, TypeScript, production build, and the
focused Playwright suite pass.

- [ ] **Step 2: Review the diff**

Run:

```sh
git diff --check
git diff --stat
git status --short
```

Expected: only the design, plan, two production files, and their regression
tests are changed.

- [ ] **Step 3: Commit and merge**

Run:

```sh
git add docs/superpowers/specs/2026-07-30-frontend-idle-performance-design.md docs/superpowers/plans/2026-07-30-frontend-idle-performance.md web/src/App.tsx web/src/App.test.tsx web/src/components/TerminalView.tsx web/e2e/terminal-reliability.spec.ts
git commit -m "perf: reduce idle terminal rendering"
```

Merge the verified branch into the current base branch, resolving only
overlapping changes in the files listed above.

