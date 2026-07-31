# Terminal WebGL Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load xterm.js's WebGL renderer for every Euphony terminal while retaining the DOM renderer when WebGL initialization is unavailable.

**Architecture:** Add `@xterm/addon-webgl` beside the existing xterm Fit addon. Keep the existing `TerminalDriver` and React lifecycle unchanged, and call a small exported `loadWebglRenderer` helper immediately after `Terminal.open()`. The helper catches addon construction/loading errors, logs a warning, and returns `false` so xterm's DOM renderer remains active.

**Tech Stack:** React 19, TypeScript, xterm.js 6, `@xterm/addon-fit`, `@xterm/addon-webgl`, Vitest, Testing Library, Vite, Playwright.

## Global Constraints

- Use `@xterm/addon-webgl` version `^0.19.0` with the existing `@xterm/xterm` version `^6.0.0`.
- Load WebGL only after `terminal.open(element)` and before the terminal begins receiving WebSocket data.
- A WebGL construction or load failure must not escape the terminal factory; preserve xterm's DOM renderer fallback.
- Preserve terminal sizing, history replay, WebSocket messages, selection, links, colors, keyboard behavior, and existing `TerminalDriver` callers.
- Do not add a renderer preference or unrelated UI/configuration.
- Write the new tests before production code and verify the intended red/green transitions.

---

### Task 1: Add the WebGL addon dependency

**Files:**

- Modify: `web/package.json`
- Modify: `web/package-lock.json`

**Interfaces:**

- Produces: `@xterm/addon-webgl` available to the web bundle at version `^0.19.0`.

- [ ] **Step 1: Install the compatible addon as a production dependency**

Run from `web/`:

    npm install @xterm/addon-webgl@^0.19.0

The command must add the dependency to `dependencies` and update the lockfile without changing unrelated package versions.

- [ ] **Step 2: Verify the dependency diff**

    git diff -- web/package.json web/package-lock.json

Expected: only the `@xterm/addon-webgl` dependency declaration and its lockfile package/entry records are added.

- [ ] **Step 3: Commit the dependency setup**

    git add web/package.json web/package-lock.json
    git commit -m "build(web): add xterm WebGL addon"

### Task 2: Specify WebGL loading and DOM fallback with tests

**Files:**

- Modify: `web/src/components/TerminalView.test.tsx`
- Modify: `web/src/components/TerminalView.tsx`

**Interfaces:**

- Consumes: `Terminal.loadAddon(addon: ITerminalAddon)` from `@xterm/xterm` and `WebglAddon` from `@xterm/addon-webgl`.
- Produces: `loadWebglRenderer(terminal: Pick<Terminal, "loadAddon">, createAddon?: () => ITerminalAddon): boolean` exported from `TerminalView.tsx`.

- [ ] **Step 1: Add the success-path failing test**

Extend the existing imports in `TerminalView.test.tsx` with `loadWebglRenderer` and `ITerminalAddon`, then add:

    test("loads the WebGL addon into an xterm terminal", () => {
      const addon: ITerminalAddon = {
        activate: () => undefined,
        dispose: () => undefined,
      };
      const loadAddon = vi.fn();

      expect(loadWebglRenderer({ loadAddon }, () => addon)).toBe(true);
      expect(loadAddon).toHaveBeenCalledOnce();
      expect(loadAddon).toHaveBeenCalledWith(addon);
    });

Run:

    npm test -- --run src/components/TerminalView.test.tsx -t "loads the WebGL addon"

Expected: FAIL because `loadWebglRenderer` is not exported yet.

- [ ] **Step 2: Add the fallback-path failing test**

Add:

    test("keeps the DOM renderer when WebGL addon loading fails", () => {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const loadAddon = vi.fn(() => {
        throw new Error("WebGL is unavailable");
      });

      expect(
        loadWebglRenderer(
          { loadAddon },
          () => ({
            activate: () => undefined,
            dispose: () => undefined,
          }),
        ),
      ).toBe(false);
      expect(warning).toHaveBeenCalledWith(
        "WebGL terminal renderer unavailable; using DOM renderer",
        expect.any(Error),
      );
    });

Run:

    npm test -- --run src/components/TerminalView.test.tsx -t "WebGL"

Expected: both new tests fail for the missing helper, with no unrelated test failure.

- [ ] **Step 3: Implement the minimal helper and production wiring**

In `TerminalView.tsx`:

1. Import `WebglAddon` from `@xterm/addon-webgl` and `type ITerminalAddon` from `@xterm/xterm`.
2. Add the helper before `defaultTerminal`:

    export function loadWebglRenderer(
      terminal: Pick<Terminal, "loadAddon">,
      createAddon: () => ITerminalAddon = () => new WebglAddon(),
    ): boolean {
      try {
        terminal.loadAddon(createAddon());
        return true;
      } catch (error) {
        console.warn("WebGL terminal renderer unavailable; using DOM renderer", error);
        return false;
      }
    }

3. Call `loadWebglRenderer(terminal)` directly after `terminal.open(element)` in `defaultTerminal`.
4. Keep `FitAddon` loaded as before. Do not change `TerminalDriver`, the React effect dependency list, or the terminal disposal path.

- [ ] **Step 4: Run the focused green test suite**

    npm test -- --run src/components/TerminalView.test.tsx

Expected: the full `TerminalView` suite passes, including both WebGL tests.

- [ ] **Step 5: Commit the implementation**

    git add web/src/components/TerminalView.tsx web/src/components/TerminalView.test.tsx
    git commit -m "perf(web): prefer xterm WebGL renderer"

### Task 3: Verify the integrated web client

**Files:**

- No additional files unless a verification command identifies a real regression.

**Interfaces:**

- Consumes: the committed dependency and `TerminalView` implementation from Tasks 1 and 2.
- Produces: fresh evidence that the web client type-checks, builds, and preserves its terminal behavior.

- [ ] **Step 1: Run all web unit tests**

    npm test -- --run

Expected: all test files pass with zero failures.

- [ ] **Step 2: Run TypeScript type checking**

    npm run typecheck

Expected: `tsc -b --pretty false` exits with code 0.

- [ ] **Step 3: Run the production Vite build**

    npm run build

Expected: TypeScript compilation and Vite bundling exit with code 0, with no unresolved `@xterm/addon-webgl` import.

- [ ] **Step 4: Run the existing terminal Playwright coverage when the Euphony test server is available**

From `web/`, run:

    npm run e2e -- e2e/terminal-reliability.spec.ts

Expected: the existing terminal reliability scenarios pass. Confirm that the terminal remains visible and interactive; do not require WebGL-specific canvas markup because environments without a WebGL context are valid DOM-fallback environments.

- [ ] **Step 5: Review the final diff and status**

    git diff HEAD~2..HEAD --stat
    git diff HEAD~2..HEAD --check
    git status --short --branch

Expected: only the design/plan docs, web dependency files, and the focused terminal implementation/tests are committed; no unrelated worktree files are changed.

### Task 4: Integrate the verified branch

**Files:**

- No new files.

**Interfaces:**

- Consumes: the verified commits on `codex/webgl-terminal-renderer`.
- Produces: the same commits merged into the base `main` branch without touching its pre-existing uncommitted changes.

- [ ] **Step 1: Confirm the feature branch is clean and verified**

    git status --short --branch
    git log --oneline --decorate -4

Expected: the feature worktree is clean and the WebGL dependency, implementation, and docs commits are present.

- [ ] **Step 2: Merge into `main` from the base worktree**

From `/Users/ryotarai/work/euphony`, run:

    git merge --no-ff codex/webgl-terminal-renderer -m "Merge terminal WebGL renderer"

Preserve the base worktree's existing `web/dist/.keep` deletion and untracked `tmp/` contents; resolve no unrelated files.

- [ ] **Step 3: Verify the merged tree**

    git status --short --branch
    git log --oneline --decorate -3

Expected: `main` contains the merge commit and retains the pre-existing unrelated working-tree state.
