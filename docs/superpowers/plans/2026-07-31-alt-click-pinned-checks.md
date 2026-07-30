# Alt-Click Pinned Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Shift-click pinning with Alt-click (Option-click on macOS) for every pinned sidebar checkbox.

**Architecture:** Keep modifier interpretation inside `SessionNavigation`, which already owns checkbox click translation. Change only the forwarded modifier and user-facing tooltip, then update integration and end-to-end interactions to express the new contract.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Playwright

## Global Constraints

- Plain clicks and Shift-clicks remain ordinary checkbox selection actions.
- Alt-click is the only modified click that requests a pin.
- Existing pinned-state appearance, direct removal, URL state, and persistence stay unchanged.
- Use `Option-click to pin` in the macOS-facing tooltip.

---

### Task 1: Change the pinned-checkbox modifier

**Files:**
- Modify: `web/src/components/SessionNavigation.test.tsx`
- Modify: `web/src/components/SessionNavigation.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/e2e/euphony.spec.ts`
- Modify: `docs/superpowers/specs/2026-07-30-pinned-terminal-checkboxes-design.md`
- Modify: `docs/superpowers/specs/2026-07-30-pinned-filter-checkboxes-design.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: React `MouseEvent.altKey` from sidebar checkbox clicks.
- Produces: Existing `onSelect`, `onStatusFilter`, and `onCwdFilter` callbacks with `pin=true` only for Alt-click.

- [ ] **Step 1: Write the failing component tests**

Rename the two modifier-forwarding tests to Alt-click, send
`{ altKey: true }`, and add a terminal-checkbox Shift-click assertion:

```tsx
fireEvent.click(terminalCheckbox, { altKey: true });
expect(onSelect).toHaveBeenCalledWith("three", true, true);

onSelect.mockClear();
fireEvent.click(terminalCheckbox, { shiftKey: true });
expect(onSelect).toHaveBeenCalledWith("three", true, false);
```

Also assert that an unpinned checkbox exposes the
`Option-click to pin` tooltip.

- [ ] **Step 2: Run the component tests and verify RED**

Run:

```bash
cd web
npm test -- --run src/components/SessionNavigation.test.tsx
```

Expected: FAIL because the component still reads `shiftKey` and displays
`Shift-click to pin`.

- [ ] **Step 3: Implement Alt-click forwarding**

In all three checkbox handlers in `SessionNavigation.tsx`, replace
`event.shiftKey` with `event.altKey`. Replace all three unpinned tooltip
strings with `Option-click to pin`.

- [ ] **Step 4: Update integration and end-to-end scenarios**

Replace pin-creating `{ shiftKey: true }` events with `{ altKey: true }` in
the pinning scenarios in `App.test.tsx`. Replace Playwright
`modifiers: ["Shift"]` with `modifiers: ["Alt"]` in terminal, status, and cwd
pinning scenarios. Rename test descriptions that name Shift-pinning.

Update the existing pinning design specs from Shift-click to Alt/Option-click,
and add the reusable shortcut rule to `AGENTS.md`.

- [ ] **Step 5: Run focused tests and type checking**

Run:

```bash
cd web
npm test -- --run src/components/SessionNavigation.test.tsx
npm test -- --run src/App.test.tsx -t "pinned|pin added|removes a pin"
npm run typecheck
```

Expected: all commands PASS.

- [ ] **Step 6: Run the Playwright pinning scenarios**

Run:

```bash
cd web
npm run e2e -- --grep "pins a terminal checkbox|pins status and cwd filters"
```

Expected: both scenarios PASS against the isolated test database.

- [ ] **Step 7: Commit**

```bash
git add AGENTS.md docs/superpowers/specs/2026-07-31-alt-click-pinned-checks-design.md docs/superpowers/plans/2026-07-31-alt-click-pinned-checks.md docs/superpowers/specs/2026-07-30-pinned-terminal-checkboxes-design.md docs/superpowers/specs/2026-07-30-pinned-filter-checkboxes-design.md web/src/components/SessionNavigation.tsx web/src/components/SessionNavigation.test.tsx web/src/App.test.tsx web/e2e/euphony.spec.ts
git commit -m "fix: pin checks with option click"
```
