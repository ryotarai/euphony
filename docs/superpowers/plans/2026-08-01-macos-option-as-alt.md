# macOS Option as Alt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure xterm.js so macOS Option-modified terminal input is emitted as Alt/Meta input with an ESC prefix.

**Architecture:** Keep the existing TerminalView input and WebSocket path unchanged. Extract the xterm constructor options into a testable helper, set `macOptionIsMeta: true`, and verify the option with a focused regression test.

**Tech Stack:** React, TypeScript, xterm.js, Vitest, Vite.

## Global Constraints

- Preserve the existing terminal input transport and PTY protocol.
- Do not add a user-facing setting; the behavior is always enabled for terminal instances.
- Write code and repository documents in English.

---

### Task 1: Configure xterm.js Option-as-Alt behavior

**Files:**
- Modify: `web/src/components/TerminalView.tsx`
- Test: `web/src/components/TerminalView.test.tsx`

**Interfaces:**
- Produces: `terminalOptions(...)`, a pure helper returning the options passed to xterm.js.

- [ ] **Step 1: Write the failing regression test**

Add a test near the existing terminal configuration tests:

```ts
test("treats macOS Option input as Alt in xterm", () => {
  expect(terminalOptions("monospace", 14, 1000, 1, "block", true, 1))
    .toMatchObject({ macOptionIsMeta: true });
});
```

Import `terminalOptions` from `./TerminalView`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- --run src/components/TerminalView.test.tsx -t "treats macOS Option input as Alt in xterm"`

Expected: FAIL because `terminalOptions` is not exported yet.

- [ ] **Step 3: Implement the minimal configuration**

Extract the object currently passed to `new Terminal` into `terminalOptions`,
keep all existing values, and add:

```ts
macOptionIsMeta: true,
```

Construct the terminal with `new Terminal(terminalOptions(...))`.

- [ ] **Step 4: Run the focused test and typecheck**

Run: `npm test -- --run src/components/TerminalView.test.tsx -t "treats macOS Option input as Alt in xterm"`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit code 0.

- [ ] **Step 5: Commit the implementation**

```bash
git add web/src/components/TerminalView.tsx web/src/components/TerminalView.test.tsx
git commit -m "feat: treat macOS option as terminal alt"
```

### Task 2: Verify the web terminal change

**Files:**
- No source changes.

- [ ] **Step 1: Run the complete web unit test suite**

Run: `npm test -- --run`

Expected: all tests pass.

- [ ] **Step 2: Build the web application**

Run: `npm run build`

Expected: exit code 0.

- [ ] **Step 3: Review the final diff and commit status**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only the intended source/test changes are
committed in the worktree.
