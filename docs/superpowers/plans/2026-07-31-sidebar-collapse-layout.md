# Sidebar Collapse Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release all sidebar width when collapsed, keep its expand control on-screen, and toggle it with Meta-B but not Control-B.

**Architecture:** Retain the controlled shadcn sidebar and persisted settings. Explicitly collapse the outer sidebar grid item, render a collapsed-state trigger outside the off-canvas container, and route an exact Meta-B shortcut through the existing sidebar context.

**Tech Stack:** React 19, TypeScript, Tailwind CSS 4, Vitest, Testing Library, Playwright

## Global Constraints

- Preserve the existing black workspace visual language and compact pane tabs.
- Preserve Control-B for the configurable terminal prefix.
- Keep mobile drawer behavior unchanged.
- Run browser tests against the existing in-memory isolated test database.

---

### Task 1: Repair desktop sidebar collapse and keyboard access

**Files:**
- Modify: `AGENTS.md:55-62`
- Modify: `web/src/components/SessionNavigation.tsx:300-470`
- Modify: `web/src/components/SessionNavigation.test.tsx:480-525`
- Modify: `web/src/styles.css:1327-1335`
- Modify: `web/src/styles.css:1837-1870`
- Modify: `web/e2e/euphony.spec.ts:1379-1510`

**Interfaces:**
- Consumes: `SidebarProvider.open`, `SidebarProvider.onOpenChange`, `useSidebar().toggleSidebar`
- Produces: `.sidebar-provider`, `.sidebar-expand`, `aria-keyshortcuts="Meta+B"`, a full-width collapsed `.terminal-stage`

- [ ] **Step 1: Strengthen the component regression test**

Extend `collapses and restores the desktop sidebar` to dispatch an exact
Meta-B event and assert the expand control becomes the collapse control. Then
dispatch Control-B and assert the collapse control remains present.

```tsx
fireEvent.keyDown(window, { key: "b", metaKey: true });
expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();

fireEvent.keyDown(window, { key: "b", ctrlKey: true });
expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
```

- [ ] **Step 2: Strengthen the browser regression test**

After clicking `Collapse sidebar`, derive literal layout expectations from the
viewport and verify the terminal stage and restore button coordinates.

```ts
const collapsedLayout = await page.evaluate(() => {
  const stage = document.querySelector<HTMLElement>(".terminal-stage")!
    .getBoundingClientRect();
  const expand = document.querySelector<HTMLElement>(".sidebar-expand")!
    .getBoundingClientRect();
  return {
    stageLeft: stage.left,
    stageRight: stage.right,
    viewportWidth: window.innerWidth,
    expandLeft: expand.left,
    expandRight: expand.right,
  };
});
expect(collapsedLayout.stageLeft).toBe(0);
expect(collapsedLayout.stageRight).toBe(collapsedLayout.viewportWidth);
expect(collapsedLayout.expandLeft).toBeGreaterThanOrEqual(0);
expect(collapsedLayout.expandRight).toBeLessThanOrEqual(
  collapsedLayout.viewportWidth,
);
```

Also use `page.keyboard.press("Control+B")` to prove the sidebar remains
collapsed, then `page.keyboard.press("Meta+B")` to expand and collapse. Other
end-to-end cases already verify Control-B prefix handling when that prefix is
configured; this scenario changes the configured prefix to Control-A.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
npm test -- --run src/components/SessionNavigation.test.tsx
EUPHONY_E2E_PORT=18133 npx playwright test e2e/euphony.spec.ts --workers=1 --grep "persists sidebar controls"
```

Expected: the component test cannot find the collapsed-state external trigger
after Meta-B, and the browser test reports a nonzero stage left coordinate or
an off-screen expand-button coordinate.

- [ ] **Step 4: Implement the minimal shared-state fix**

In `SessionNavigationContent`, read `toggleSidebar` from `useSidebar`, register
a capture-phase `keydown` handler that accepts only unshifted, unmodified
Meta-B, and render an external trigger only while desktop state is collapsed.
Give the provider wrapper `className="sidebar-provider"` and keep its built-in
shortcut disabled to avoid accepting Control-B.

```tsx
const { isMobile, setOpenMobile, state, toggleSidebar } = useSidebar();

useEffect(() => {
  const toggleWithCommandB = (event: KeyboardEvent) => {
    if (
      event.key.toLowerCase() !== "b" ||
      !event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey
    ) return;
    event.preventDefault();
    toggleSidebar();
  };
  window.addEventListener("keydown", toggleWithCommandB, { capture: true });
  return () =>
    window.removeEventListener("keydown", toggleWithCommandB, { capture: true });
}, [toggleSidebar]);
```

Render `.sidebar-expand` outside `<Sidebar>` while collapsed. In CSS, keep the
provider at `display: contents`, transition its outer sidebar child to zero
width for `data-state="collapsed"`, fix the expand button into the tab-bar
corner, and inset the tab rail only while the workspace contains that button.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
npm test -- --run src/components/SessionNavigation.test.tsx
EUPHONY_E2E_PORT=18134 npx playwright test e2e/euphony.spec.ts --workers=1 --grep "persists sidebar controls"
```

Expected: both commands exit 0.

- [ ] **Step 6: Run full verification**

Run:

```bash
go test ./...
npm test -- --run
npm run typecheck
npm run build
EUPHONY_E2E_PORT=18135 npx playwright test --workers=1
```

Expected: every command exits 0 with no test failures.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-07-31-sidebar-collapse-layout-design.md \
  docs/superpowers/plans/2026-07-31-sidebar-collapse-layout.md \
  web/src/components/SessionNavigation.tsx \
  web/src/components/SessionNavigation.test.tsx \
  web/src/styles.css \
  web/e2e/euphony.spec.ts
git commit -m "fix(web): restore collapsed sidebar controls"
```
