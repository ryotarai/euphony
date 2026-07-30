# Command-K Only Quick Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open Quick Actions with Command+K while leaving Control+K available to the terminal.

**Architecture:** Keep the existing window-level Quick Actions listener and narrow its modifier guard from Command-or-Control to Command. Protect the user-visible behavior at both the React integration boundary and the built-browser boundary.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Playwright

## Global Constraints

- Do not change Quick Actions visuals, contents, focus behavior, or navigation keys.
- Do not add a configurable shortcut or a new shortcut abstraction.
- Keep Control+P and Control+N navigation inside the open dialog unchanged.

---

### Task 1: Restrict Quick Actions to Command+K

**Files:**
- Modify: `web/src/App.test.tsx`
- Modify: `web/e2e/euphony.spec.ts`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: the existing window `keydown` event listener in `App`.
- Produces: Quick Actions opens when `KeyboardEvent.metaKey` is true for `K`; Control+K alone has no Quick Actions side effect.

- [ ] **Step 1: Write the failing React behavior test**

Add this test near the existing Quick Actions tests:

```tsx
test("opens Quick Actions with Command-K but not Control-K", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession]),
  );
  render(
    <App
      syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div>{session.id}</div>}
    />,
  );
  await screen.findByRole("button", { name: "Select Codex" });

  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  expect(
    screen.queryByRole("dialog", { name: "Quick Actions" }),
  ).not.toBeInTheDocument();

  fireEvent.keyDown(window, { key: "k", metaKey: true });
  expect(
    await screen.findByRole("dialog", { name: "Quick Actions" }),
  ).toBeVisible();
});
```

- [ ] **Step 2: Run the React test and verify RED**

Run:

```bash
cd web
npm test -- --run src/App.test.tsx -t "opens Quick Actions with Command-K but not Control-K"
```

Expected: FAIL because Control+K currently opens the Quick Actions dialog.

- [ ] **Step 3: Add the browser-level regression test**

Add this focused Playwright test near the existing Quick Actions tests:

```ts
test("opens Quick Actions with Command-K but not Control-K", async ({ page }) => {
  await clearSessions(page);
  await createSession(page, "Terminal");

  await page.goto("/?token=test-token");
  await page.keyboard.press("Control+K");
  await expect(page.getByRole("dialog", { name: "Quick Actions" })).toHaveCount(0);

  await page.keyboard.press("Meta+K");
  await expect(page.getByRole("dialog", { name: "Quick Actions" })).toBeVisible();
});
```

- [ ] **Step 4: Implement the minimal modifier guard**

Change the Quick Actions listener guard to:

```ts
if (event.key.toLowerCase() !== "k" || !event.metaKey) return;
```

- [ ] **Step 5: Verify the focused and full frontend checks**

Run:

```bash
cd web
npm test -- --run src/App.test.tsx
npm run typecheck
npm run build
EUPHONY_E2E_PORT=18081 npm run e2e -- --grep "opens Quick Actions with Command-K but not Control-K"
```

Expected: all commands exit successfully, the React suite reports zero failures,
and the focused Playwright test passes against the isolated in-memory database.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-07-31-command-k-only-design.md \
  docs/superpowers/plans/2026-07-31-command-k-only.md \
  web/src/App.test.tsx web/e2e/euphony.spec.ts web/src/App.tsx
git commit -m "fix: restrict quick actions to command k"
```
