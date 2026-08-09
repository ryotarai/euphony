# Inbox Full-Bleed Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Inbox tabs, message list, and selected detail fill the complete dashboard pane without removing Inbox actions.

**Architecture:** Keep the existing `AgentsView` data flow and selection components. Replace the page-style header region with a compact toolbar, then use a flex-column full-height shell so `.agents-mailbox` owns all remaining pane space. Preserve the existing list/detail grid and mobile breakpoint, while reducing list section headings to compact mailbox labels.

**Tech Stack:** React 19, TypeScript, CSS, Testing Library, Playwright.

## Global Constraints

- Communicate with users in Japanese, but write materials such as code and documents in English.
- Use the existing near-black Euphony palette, hairline dividers, amber attention state, and monospace utility labels.
- Preserve the existing Refresh button, Inbox/Done keyboard behavior, URL selection, and terminal automation behavior.
- Do not add dependencies or alter backend APIs.
- Keep the mailbox responsive down to the existing mobile breakpoint.

---

### Task 1: Move Inbox controls into a compact full-bleed toolbar

**Files:**
- Modify: `web/src/components/AgentsView.tsx` around the `AgentsView` return markup
- Test: `web/src/components/AgentsView.test.tsx` around the refresh and Inbox structure tests

**Interfaces:**
- Consumes: existing `AgentsViewProps`, tab state, refresh state, and existing `Refresh all agent summaries` button behavior.
- Produces: an `.agents-toolbar` containing the existing tablist and header actions, plus an accessible `h1` with id `agents-view-title`.

- [ ] **Step 1: Write the failing component assertion**

Add a test that renders `AgentsView` with `onRefresh` and asserts the toolbar contains the tablist and the existing refresh button:

```tsx
test("keeps Inbox controls in the compact toolbar", () => {
  renderAgents({ onRefresh: vi.fn() });

  const toolbar = document.querySelector(".agents-toolbar");
  expect(toolbar).toBeInTheDocument();
  expect(within(toolbar as HTMLElement).getByRole("tablist", { name: "Inbox views" })).toBeInTheDocument();
  expect(within(toolbar as HTMLElement).getByRole("button", {
    name: "Refresh all agent summaries",
  })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- --run src/components/AgentsView.test.tsx -t "keeps Inbox controls in the compact toolbar"`

Expected: FAIL because the current markup has no `.agents-toolbar`.

- [ ] **Step 3: Implement the compact toolbar markup**

Replace the current page-style header wrapper with this structure while keeping the existing tab map and refresh handlers unchanged:

```tsx
<h1 id="agents-view-title" className="sr-only">Inbox</h1>
<div className="agents-toolbar">
  <div className="agents-tabs" role="tablist" aria-label="Inbox views">
    {/* existing Inbox/Done tab buttons */}
  </div>
  <div className="agents-view-header-actions">
    {/* existing attention count and refresh button */}
  </div>
</div>
```

Keep loading and error messages after the toolbar. Update the existing visibility-only heading assertion in `web/src/App.test.tsx` to assert the accessible heading is present rather than visually visible, because the reference layout intentionally removes the oversized page header.

- [ ] **Step 4: Run component and App tests to verify behavior**

Run: `npm test -- --run src/components/AgentsView.test.tsx src/App.test.tsx --maxWorkers=1`

Expected: PASS with the refresh interaction, tab navigation, Inbox selection, and URL tests intact.

- [ ] **Step 5: Commit the toolbar change**

```bash
git add web/src/components/AgentsView.tsx web/src/components/AgentsView.test.tsx web/src/App.test.tsx
git commit -m "refactor: compact Inbox controls"
```

### Task 2: Make the Inbox surface fill the pane and compact section labels

**Files:**
- Modify: `web/src/styles.css` in the Inbox mailbox rules near the end of the file
- Modify: `AGENTS.md` in the layout guidance section

**Interfaces:**
- Consumes: `.agents-view`, `.agents-toolbar`, `.agents-tab-panel`, `.agents-mailbox`, `.agents-list`, and `.agents-detail` markup from Task 1.
- Produces: a zero-padding, full-height Inbox surface with a flexible mailbox grid, compact section headings, and preserved mobile stacking.

- [ ] **Step 1: Add layout assertions to the Playwright Inbox flow**

After opening Inbox in `web/e2e/euphony.spec.ts`, assert the computed layout removes page whitespace and the centered constraint:

```ts
await expect(page.locator(".agents-view")).toHaveCSS("padding-top", "0px");
await expect(page.locator(".agents-view")).toHaveCSS("padding-left", "0px");
await expect(page.locator(".agents-tab-panel")).toHaveCSS("max-width", "none");
await expect(page.locator(".agents-tab-panel")).toHaveCSS("margin-left", "0px");
await expect(page.locator(".agents-mailbox")).toHaveCSS("min-height", "0px");
await expect(page.locator(".agents-section-heading h2").first()).toHaveCSS("font-size", "9.6px");
```

- [ ] **Step 2: Run the focused E2E test to verify it fails**

Run: `EUPHONY_E2E_PORT=18087 npm run e2e -- e2e/euphony.spec.ts --grep "opens the Inbox and follows a summarized agent" --workers=1`

Expected: FAIL on the existing page padding, max-width, mailbox min-height, or section heading size.

- [ ] **Step 3: Implement the full-bleed CSS**

Add or update the final Inbox rules so the shell and toolbar consume the pane:

```css
.agents-view {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 0;
  overflow: hidden;
}

.agents-toolbar {
  display: flex;
  flex: 0 0 auto;
  align-items: stretch;
  justify-content: space-between;
  min-height: 3.75rem;
  border-bottom: 1px solid var(--border);
}

.agents-tabs,
.agents-tab-panel {
  max-width: none;
  margin: 0;
}

.agents-tab-panel {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}

.agents-mailbox {
  flex: 1 1 auto;
  min-height: 0;
  border-width: 0 1px 1px;
}

.agents-section-heading h2 {
  font-size: 0.6rem;
  line-height: 1;
}
```

Keep the existing `@media (max-width: 680px)` rule for one-column stacking, changing only its outer padding assumptions so the mobile surface also remains full bleed.

Add this reusable rule to `AGENTS.md`:

```text
- When a dashboard pane is explicitly requested to fill its viewport, remove page-level whitespace and let a compact toolbar plus flexible content surface own the available pane dimensions.
```

- [ ] **Step 4: Run the focused E2E test to verify it passes**

Run: `EUPHONY_E2E_PORT=18087 npm run e2e -- e2e/euphony.spec.ts --grep "opens the Inbox and follows a summarized agent" --workers=1`

Expected: PASS, including the existing Inbox selection and terminal navigation assertions.

- [ ] **Step 5: Commit the full-bleed layout**

```bash
git add web/src/styles.css web/e2e/euphony.spec.ts AGENTS.md
git commit -m "style: make Inbox fill its pane"
```

### Task 3: Run the complete verification suite and integrate

**Files:**
- Verify: `web/src/components/AgentsView.tsx`
- Verify: `web/src/styles.css`
- Verify: `web/src/components/AgentsView.test.tsx`
- Verify: `web/e2e/euphony.spec.ts`

**Interfaces:**
- Consumes: the toolbar and full-bleed layout from Tasks 1 and 2.
- Produces: tested, committed changes merged into `main` without touching the pre-existing `D web/dist/.keep` or `?? tmp/` state.

- [ ] **Step 1: Run the full frontend unit suite**

Run: `npm test -- --run --maxWorkers=1`

Expected: 261 or more tests pass with zero failures.

- [ ] **Step 2: Run typecheck and production build**

Run: `npm run typecheck`

Expected: TypeScript exits with code 0.

Run: `npm run build`

Expected: Vite produces the production bundle; existing large-chunk warnings are acceptable.

- [ ] **Step 3: Run Go tests**

Run: `go test ./...`

Expected: all Go packages pass.

- [ ] **Step 4: Run the Inbox E2E checks**

Run: `EUPHONY_E2E_PORT=18087 npm run e2e -- e2e/euphony.spec.ts --grep "opens the Inbox and follows a summarized agent|locks the terminal while an Inbox choice is resolved" --workers=1`

Expected: both Inbox-related scenarios pass.

- [ ] **Step 5: Review status and merge**

Run:

```bash
git -c core.fsmonitor=false status --short
git -c core.fsmonitor=false log -2 --oneline
```

Expected: only the intended commits are present in the worktree; pre-existing base changes remain unstaged and untouched.

Merge the verified branch into `main` with a fast-forward merge:

```bash
git -C /Users/ryotarai/work/euphony -c core.fsmonitor=false merge --ff-only codex/inbox-full-bleed
```
