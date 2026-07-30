# Compact Terminal List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce terminal navigation rows and nested group spacing to a Codex-like compact density.

**Architecture:** Preserve `SessionNavigation` markup and interaction behavior. Protect the visible density with a browser-level geometry test, then change only the navigation-specific CSS overrides.

**Tech Stack:** React 19, TypeScript, CSS, Playwright, Vitest.

## Global Constraints

- Preserve status, cwd, terminal selection, attention, and pin behavior.
- Preserve exactly 8 CSS pixels of indentation at each hierarchy level.
- Keep terminal checkboxes 16 CSS pixels square.
- Keep the default interface font size at 16 CSS pixels.

---

### Task 1: Compact terminal navigation density

**Files:**
- Modify: `web/e2e/euphony.spec.ts`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: existing `.session-group`, `.cwd-group`, `.status-heading`, `.cwd-heading`, `.session-select`, and `.session-channel` markup.
- Produces: a terminal row whose rendered height is at most 32 CSS pixels at the default interface font size.

- [ ] **Step 1: Write the failing browser test**

Add a test beside the existing sidebar indentation test:

```ts
test("keeps terminal navigation rows compact", async ({ page }) => {
  await clearSessions(page);
  await createSession(page, "Compact terminal", "/tmp");
  await page.goto("/?token=test-token");

  const row = page.getByRole("button", { name: "Select Compact terminal" });
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeLessThanOrEqual(32);
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
EUPHONY_E2E_PORT=18081 npm run e2e -- --grep "keeps terminal navigation rows compact"
```

Expected: FAIL because `.session-select` currently renders at 48 CSS pixels.

- [ ] **Step 3: Implement the minimal CSS change**

Set `.session-select` to `height: 2rem`, reduce nested group vertical
padding/gaps, and set the status/cwd heading rhythm to 1.5–1.625rem. Do not
change horizontal padding that establishes the existing 8 pixel hierarchy.

- [ ] **Step 4: Run the focused Playwright tests to verify GREEN**

Run:

```bash
EUPHONY_E2E_PORT=18081 npm run e2e -- --grep "terminal navigation rows compact|0.5rem indentation"
```

Expected: both tests PASS.

- [ ] **Step 5: Run complete verification**

Run:

```bash
npm test -- --run
npm run typecheck
npm run build
EUPHONY_E2E_PORT=18081 npm run e2e -- --workers=1
```

Expected: every command exits 0 with no test failures.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers web/src/styles.css web/e2e/euphony.spec.ts
git commit -m "style: compact terminal navigation rows"
```
