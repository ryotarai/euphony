# Running Status Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the frozen running spinner with static, semantically distinct running and starting status icons without reintroducing persistent animation or changing sidebar geometry.

**Architecture:** Keep `sessionStatusIcon` as the single state-to-icon mapping in `SessionNavigation.tsx`. Change only the icon components for `running` and `starting`; preserve existing CSS sizing, colors, labels, and all other status mappings. Verify the visual result through the existing Playwright E2E surface after unit tests pass.

**Tech Stack:** React 19, TypeScript, lucide-react, Vitest, Testing Library, Playwright, Vite.

## Global Constraints

- Running and starting indicators must be static; do not restore perpetual CSS animation.
- Preserve the existing 1rem status icon box and `#60a5fa` running color.
- Preserve `role="img"` and existing `aria-label` values.
- Do not alter selection, navigation, or session status behavior.
- Communicate with users in Japanese; write code and documents in English.

---

### Task 1: Add status icon regression tests

**Files:**
- Modify: `web/src/components/SessionNavigation.test.tsx` near the existing status icon assertions

**Interfaces:**
- Consumes: the current `SessionNavigation` rendered status icons and accessible labels.
- Produces: assertions that distinguish the running and starting icon SVGs while preserving their accessible labels.

- [ ] **Step 1: Write the failing test**

Extend the existing status icon test so it asserts the running and starting icons
use different SVG `data-lucide` names. Keep the existing `aria-label` assertions:

```tsx
expect(screen.getByRole("img", { name: "Running" })).toHaveAttribute(
  "data-lucide",
  "circle-dot",
);
expect(screen.getByRole("img", { name: "Starting" })).toHaveAttribute(
  "data-lucide",
  "clock-3",
);
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
npm test -- --run src/components/SessionNavigation.test.tsx -t "renders a cwd-first tree with lifecycle icons"
```

Expected: FAIL because the current implementation renders `LoaderCircleIcon` for
both `running` and `starting`.

- [ ] **Step 3: Commit the test change**

```bash
git add web/src/components/SessionNavigation.test.tsx
git commit -m "test: define static running status icons"
```

### Task 2: Replace frozen spinner icons

**Files:**
- Modify: `web/src/components/SessionNavigation.tsx` imports and `sessionStatusIcon`

**Interfaces:**
- Consumes: the existing `statusLabel`, icon props, and status switch.
- Produces: `CircleDotIcon` for `running` and `Clock3Icon` for `starting`, with unchanged props and labels.

- [ ] **Step 1: Update icon imports and the status mapping**

Import `CircleDotIcon` and `Clock3Icon` from `lucide-react`, then update only the
two switch cases:

```tsx
case "running":
  return <CircleDotIcon {...props} />;
case "starting":
  return <Clock3Icon {...props} />;
```

Leave all other cases untouched.

- [ ] **Step 2: Run the focused tests to verify they pass**

Run:

```bash
npm test -- --run src/components/SessionNavigation.test.tsx src/styles.test.ts
```

Expected: PASS, including the new icon identity assertions and the existing
assertion that running status has no perpetual animation.

- [ ] **Step 3: Commit the implementation**

```bash
git add web/src/components/SessionNavigation.tsx web/src/components/SessionNavigation.test.tsx
git commit -m "fix(web): clarify running session status icon"
```

### Task 3: Verify the rendered sidebar

**Files:**
- Test: `web/e2e/euphony.spec.ts` existing sidebar/status coverage
- Test: `web/e2e/terminal-reliability.spec.ts` existing terminal reliability coverage

**Interfaces:**
- Consumes: the built Vite application and isolated E2E server.
- Produces: browser evidence that sidebar layout and status accessibility remain stable.

- [ ] **Step 1: Run the complete web unit suite and typecheck**

Run:

```bash
npm test -- --run --maxWorkers=1 --testTimeout=30000
npm run typecheck
```

Expected: all unit tests pass and TypeScript exits with code 0.

- [ ] **Step 2: Build and run the terminal E2E suite**

Run:

```bash
npm run build
EUPHONY_E2E_PORT=18087 npm run e2e -- e2e/terminal-reliability.spec.ts
```

Expected: build succeeds and all terminal reliability tests pass on the new
isolated port/database.

- [ ] **Step 3: Inspect the final diff**

Run:

```bash
git diff --check HEAD~2..HEAD
git status --short
```

Expected: no whitespace errors; only the intended source, test, design, and plan
files are changed, while existing `web/dist/.keep` and `tmp/` workspace changes
remain untouched.

### Task 4: Integrate into main

**Files:**
- Modify: `main` branch history only through a non-destructive merge

**Interfaces:**
- Consumes: the verified `codex/status-icon-ui` commits.
- Produces: a merge commit on `main` containing the design, plan, tests, and UI implementation.

- [ ] **Step 1: Merge the verified worktree branch**

From the repository root, run:

```bash
git merge --no-ff codex/status-icon-ui -m "Merge static running status icon"
```

- [ ] **Step 2: Verify main contains the icon mapping**

Run:

```bash
git status --short --branch
rg -n "CircleDotIcon|Clock3Icon" web/src/components/SessionNavigation.tsx
```

Expected: `main` contains the merge commit, the existing user changes remain
untouched, and both static icon mappings are present.
