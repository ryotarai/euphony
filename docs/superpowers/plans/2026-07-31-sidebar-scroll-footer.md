# Sidebar Scroll and Fixed Footer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep sidebar actions visible while the terminal tree scrolls and fades at its bottom edge only when more terminals remain below.

**Architecture:** Restore the shadcn sidebar container's viewport-bound positioning, use `SidebarContent` as the only terminal-tree scroller, and expose its bottom-overflow state as a data attribute consumed by CSS. The footer remains a non-scrolling sibling.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Testing Library, Playwright

## Global Constraints

- Preserve the existing sidebar palette, typography, spacing, and controls.
- Keep **New terminal** and **Settings** outside the terminal-tree scroller.
- Show the fade only while additional content exists below the current scroll position.
- Use the existing isolated E2E database and one Playwright worker.

---

### Task 1: Viewport-Bound Sidebar with Conditional Tree Fade

**Files:**
- Modify: `web/src/components/SessionNavigation.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/src/components/SessionNavigation.test.tsx`
- Modify: `web/e2e/euphony.spec.ts`

**Interfaces:**
- Consumes: `SessionNavigationProps.sessions`, shadcn `SidebarContent`, and native scroll metrics.
- Produces: `data-overflow-bottom="true"` on the terminal-tree scroll container while more content exists below.

- [ ] **Step 1: Add the failing Playwright regression**

Add a test that sets a 1280 × 720 viewport, creates 30 terminal sessions, opens
the app, and reads the sidebar layout:

```ts
test("keeps sidebar actions visible while the terminal tree scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  for (let index = 0; index < 30; index += 1) {
    await createSession(page, `Overflow terminal ${index + 1}`, "/tmp");
  }
  await page.goto("/");
  await authenticate(page);

  const tree = page.locator('[data-slot="sidebar-content"]');
  const footer = page.locator('[data-slot="sidebar-footer"]');
  const layout = await tree.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  const footerBox = await footer.boundingBox();

  expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
  expect(footerBox).not.toBeNull();
  expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(720);
  await expect(tree).toHaveAttribute("data-overflow-bottom", "true");

  await tree.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect(tree).not.toHaveAttribute("data-overflow-bottom");
});
```

- [ ] **Step 2: Run the Playwright regression and verify RED**

Run:

```bash
cd web
EUPHONY_E2E_PORT=18132 npx playwright test e2e/euphony.spec.ts --grep "keeps sidebar actions visible while the terminal tree scrolls"
```

Expected: FAIL because the footer's lower edge is below 720 px and the terminal
tree has no bottom overflow.

- [ ] **Step 3: Add the failing component overflow-state test**

Render `SessionNavigation`, define `clientHeight`, `scrollHeight`, and writable
`scrollTop` values on the `SidebarContent` element, dispatch `scroll`, and
assert that `data-overflow-bottom` changes from `"true"` at the top to absent at
the bottom.

- [ ] **Step 4: Run the component test and verify RED**

Run:

```bash
cd web
npm test -- --run src/components/SessionNavigation.test.tsx
```

Expected: FAIL because `SidebarContent` does not expose overflow state.

- [ ] **Step 5: Implement the minimal layout and overflow-state fix**

In `SessionNavigation.tsx`, attach a ref and scroll handler to
`SidebarContent`. Recalculate:

```ts
const hasOverflowBelow =
  element.scrollTop + element.clientHeight < element.scrollHeight - 1;
```

Update the state after renders that can change layout and from a
`ResizeObserver`. Render the state as:

```tsx
<SidebarContent
  ref={terminalTreeRef}
  data-overflow-bottom={hasOverflowBelow || undefined}
  onScroll={updateTerminalTreeOverflow}
>
```

In `styles.css`, remove the `.desktop-sidebar` declarations that override fixed
positioning and viewport height. Remove nested scrolling from `.session-list`
so `SidebarContent` is the single scroller. Apply a 24 px bottom mask only to
`[data-slot="sidebar-content"][data-overflow-bottom="true"]`.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
cd web
npm test -- --run src/components/SessionNavigation.test.tsx
EUPHONY_E2E_PORT=18132 npx playwright test e2e/euphony.spec.ts --grep "keeps sidebar actions visible while the terminal tree scrolls"
```

Expected: both focused test commands pass.

- [ ] **Step 7: Verify the complete web package**

Run:

```bash
cd web
npm test -- --run
npm run typecheck
npm run build
```

Expected: all unit tests pass, TypeScript reports no errors, and the production
build exits successfully.

- [ ] **Step 8: Verify the visual result**

Start the isolated E2E server on port 18131, create 30 sessions, and inspect the
1280 × 720 layout in Chromium. Capture the tree at its top and bottom. Confirm
the footer is visible in both states, the top state fades, and the last terminal
is fully visible at the bottom.

- [ ] **Step 9: Commit**

```bash
git add docs/superpowers/specs/2026-07-31-sidebar-scroll-footer-design.md \
  docs/superpowers/plans/2026-07-31-sidebar-scroll-footer.md \
  web/src/components/SessionNavigation.tsx \
  web/src/components/SessionNavigation.test.tsx \
  web/src/styles.css \
  web/e2e/euphony.spec.ts
git commit -m "fix(web): keep sidebar actions visible"
```
