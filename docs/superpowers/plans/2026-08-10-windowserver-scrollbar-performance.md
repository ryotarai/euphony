# WindowServer Scrollbar Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop xterm scrollbar opacity transitions from driving unnecessary compositor frames during terminal output.

**Architecture:** Keep xterm's current renderer and terminal behavior. Add a
terminal-scoped CSS override after xterm's stylesheet so both visible and fade
scrollbar states switch opacity immediately instead of running transitions.

**Tech Stack:** React 19, TypeScript, xterm.js 6, CSS, Vitest, Playwright, Vite.

## Global Constraints

- Preserve terminal bytes, history replay, resize negotiation, input, selection, links, renderer choice, and pane lifecycle.
- Scope the override to `.terminal-host`; do not change global scrollbar behavior.
- Do not remove `@xterm/addon-webgl` or alter output batching.
- Use test-driven development and observe the new contract test fail before editing production CSS.
- Verify frontend tests, typecheck, production build, and focused Playwright coverage before merging.

---

### Task 1: Disable terminal scrollbar transitions

**Files:**
- Modify: `web/src/styles.test.ts`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: xterm.js classes `.xterm-scrollable-element`, `.visible`, and `.invisible.fade`.
- Produces: terminal scrollbar states with computed `transition: none` while retaining xterm opacity and visibility classes.

- [ ] **Step 1: Add the failing CSS contract test**

Append this test to `web/src/styles.test.ts`:

```ts
test("does not animate xterm scrollbar opacity in terminal views", () => {
  const scrollbarRule = stylesheet.match(
    /\.terminal-host \.xterm \.xterm-scrollable-element > \.visible,\s*\.terminal-host \.xterm \.xterm-scrollable-element > \.invisible\.fade\s*\{([\s\S]*?)\}/,
  )?.[1] ?? "";

  expect(scrollbarRule).toContain("transition: none;");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd web && npm test -- --run src/styles.test.ts
```

Expected: the existing running-status test passes and the new scrollbar test
fails because the terminal override does not exist yet.

- [ ] **Step 3: Add the minimal terminal-scoped CSS override**

Place this rule after the imported xterm styles are overridden in the terminal
surface section of `web/src/styles.css`:

```css
.terminal-host .xterm .xterm-scrollable-element > .visible,
.terminal-host .xterm .xterm-scrollable-element > .invisible.fade {
  transition: none;
}
```

Do not remove xterm's opacity declarations or change any unrelated transition.

- [ ] **Step 4: Run the focused unit test and typecheck**

Run:

```bash
cd web && npm test -- --run src/styles.test.ts && npm run typecheck
```

Expected: both stylesheet tests pass and TypeScript exits with code 0.

- [ ] **Step 5: Commit the focused change**

Run:

```bash
git add web/src/styles.css web/src/styles.test.ts
git commit -m "perf(web): stop terminal scrollbar compositor fades"
```

### Task 2: Browser and regression verification

**Files:**
- Modify only if a focused browser assertion is required: `web/e2e/terminal-reliability.spec.ts`

**Interfaces:**
- Consumes: the terminal-scoped scrollbar rule from Task 1.
- Produces: evidence that live terminal scrollbar elements have no computed transition.

- [ ] **Step 1: Run the focused terminal Playwright suite**

Run with the existing isolated in-memory backend and one worker:

```bash
cd web && EUPHONY_E2E_PORT=18127 npm run e2e -- e2e/terminal-reliability.spec.ts --workers=1
```

Expected: all terminal reliability tests pass. If the suite does not inspect
the scrollbar, add one test that waits for a connected terminal and evaluates
`getComputedStyle(element).transition` on `.terminal-host .xterm-scrollable-element > .visible`
and `.invisible.fade`, requiring `none` for every present element, then rerun
the focused suite.

- [ ] **Step 2: Run the complete frontend verification**

Run:

```bash
cd web && npm test -- --run && npm run typecheck && npm run build
```

Expected: 261 or more Vitest tests pass, TypeScript passes, and Vite produces
the production bundle.

- [ ] **Step 3: Inspect the final diff**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Expected: only the design/plan documents and the focused frontend test/CSS
changes are present; pre-existing base worktree changes remain untouched.

- [ ] **Step 4: Re-analyze the provided trace and report limits**

Use the trace event counts already collected to report the baseline
`Animation` events and compositor submissions. If a fresh Chrome trace can be
captured, compare the same fields after the change. Do not claim a measured
WindowServer CPU/GPU reduction unless macOS process metrics were captured.

- [ ] **Step 5: Merge the verified commit into the base branch**

From the base worktree, preserve its existing `web/dist/.keep` deletion and
untracked `tmp/`, merge `codex/windowserver-scrollbar-perf`, and verify the
base status afterward.
