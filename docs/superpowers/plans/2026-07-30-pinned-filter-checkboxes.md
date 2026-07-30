# Pinned Filter Checkboxes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin status and cwd dynamic filters with Shift-click and represent every pin through an amber checkbox instead of a pin icon.

**Architecture:** Extend shared selection state with pinned filters, persist and transport the new fields, then let `App` preserve pinned filters across replacement operations. `SessionNavigation` forwards modifier intent at every hierarchy level and renders pin state only through checkbox attributes and CSS.

**Tech Stack:** Go, SQLite, React 19, TypeScript, Base UI Checkbox, Vitest, Testing Library, Playwright.

## Global Constraints

- Pinned group selections remain dynamic as terminal metadata changes.
- Pinned filters are a normalized subset of active filters.
- The shared server selection remains the source of truth when synchronization is enabled.
- Amber `#f59e0b` is the only visual pin marker; render no pin glyph.
- Preserve existing parent/child filter decomposition behavior.

---

### Task 1: Shared pinned-filter selection state

**Files:**
- Modify: `internal/selection/types.go`
- Modify: `internal/selection/reducer.go`
- Test: `internal/selection/reducer_test.go`

**Interfaces:**
- Produces: `State.PinnedFilters Filters`, `Snapshot.PinnedFilters Filters`, and `Action.PinnedStatuses` / `Action.PinnedCWDFilters`.
- Guarantees: pinned filters are active, a pinned parent status subsumes child cwd pins, and replacement actions preserve pins.

- [ ] **Step 1: Write failing reducer tests**

Add literal-state tests for:

```go
Action{
    Type:             ActionReplaceState,
    Statuses:         []string{"running"},
    PinnedStatuses:   []string{"running"},
}
```

Assert `Resolve` returns `PinnedFilters.Statuses == []string{"running"}` and
that a later `ActionReplace` keeps the running filter and its dynamically
matching terminals. Add a removal test proving a terminal exclusion
decomposes a pinned status into pinned cwd filters for sibling directories.

- [ ] **Step 2: Run reducer tests to verify RED**

Run: `go test ./internal/selection -run 'Test.*PinnedFilter' -count=1`

Expected: FAIL because the pinned-filter fields do not exist.

- [ ] **Step 3: Implement minimal reducer state**

Add the pinned filter fields, include them in validation, normalization,
equality, resolution snapshots, replacement preservation, explicit removal,
and terminal-driven parent decomposition.

- [ ] **Step 4: Run reducer tests to verify GREEN**

Run: `go test ./internal/selection -count=1`

Expected: PASS.

### Task 2: Persistence and public selection contract

**Files:**
- Modify: `internal/session/sqlite_store.go`
- Test: `internal/session/sqlite_store_test.go`
- Modify: `internal/control/service.go`
- Modify: `internal/server/v1_selection.go`
- Test: `internal/server/v1_selection_test.go`
- Modify: `internal/apiclient/client.go`
- Modify: `cmd/euphony/cli_test.go`
- Modify: `internal/server/openapi.json`
- Modify: `docs/automation.md`

**Interfaces:**
- Consumes: `selection.Filters` from Task 1.
- Produces: JSON `pinnedFilters: {"statuses": string[], "cwds": CWDFilter[]}` on snapshots and complete replacement requests.

- [ ] **Step 1: Write failing storage and transport tests**

Round-trip a state containing one pinned status and one pinned cwd. PUT a
complete selection request containing:

```json
"pinnedFilters": {
  "statuses": ["waiting"],
  "cwds": [{"status": "running", "cwd": "/repo"}]
}
```

Assert the GET/PUT response and CLI request preserve the literal values.

- [ ] **Step 2: Run focused tests to verify RED**

Run: `go test ./internal/session ./internal/server ./cmd/euphony -run 'Test.*PinnedFilter' -count=1`

Expected: FAIL because persistence and request types omit `pinnedFilters`.

- [ ] **Step 3: Implement storage and contract support**

Add `pinned_status_filters` and `pinned_cwd_filters` JSON columns through
idempotent schema migration, extend load/save and cloning, accept
`pinnedFilters` in PUT requests, update the API client request type, schema,
and automation example.

- [ ] **Step 4: Run focused and package tests to verify GREEN**

Run: `go test ./internal/session ./internal/control ./internal/server ./internal/apiclient ./cmd/euphony -count=1`

Expected: PASS.

### Task 3: Checkbox interaction and visual language

**Files:**
- Modify: `web/src/components/SessionNavigation.tsx`
- Modify: `web/src/styles.css`
- Test: `web/src/components/SessionNavigation.test.tsx`

**Interfaces:**
- Consumes: `pinnedStatusFilters: string[]`, `pinnedCwdFilters: string[]`.
- Produces: `onStatusFilter(status, checked, pin?)` and `onCwdFilter(status, cwd, checked, pin?)`.

- [ ] **Step 1: Write failing component tests**

Shift-click checked and unchecked status/cwd controls and assert the callbacks
receive `pin: true`. Render pinned status/cwd/terminal controls and assert
`data-pinned="true"` appears on the checkbox, including inherited cwd state,
while no pin SVG exists.

- [ ] **Step 2: Run the component test to verify RED**

Run: `npm test -- --run src/components/SessionNavigation.test.tsx`

Expected: FAIL because group callbacks do not receive Shift intent and the
terminal still renders `PinIcon`.

- [ ] **Step 3: Implement checkbox behavior and CSS**

Forward `event.shiftKey` from controlled checkbox clicks, add pinned props and
attributes, remove `PinIcon`, and style
`[data-slot="checkbox"][data-pinned="true"]` with amber fill/border and
near-black foreground.

- [ ] **Step 4: Run the component test to verify GREEN**

Run: `npm test -- --run src/components/SessionNavigation.test.tsx`

Expected: PASS.

### Task 4: Browser selection state and dynamic pin behavior

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/App.tsx`
- Test: `web/src/App.test.tsx`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: shared `pinnedFilters` and group pin callbacks.
- Produces: repeated `pin-status` / `pin-cwd` URL values and synchronized complete selection requests.

- [ ] **Step 1: Write failing App tests**

Test these observable flows:

1. Shift-click Running, select a Waiting row, and keep Running's dynamic panes,
   amber checkbox, and `pin-status=running`.
2. Shift-click a cwd, select another status label, and keep the pinned cwd with
   `pin-cwd=running\u0000/repo`.
3. Exclude one cwd from a pinned status and observe pinned sibling cwd filters;
   recheck all cwd controls and observe consolidation to the pinned status.
4. Restore pinned status/cwd values from URL when server synchronization is
   disabled.

- [ ] **Step 2: Run App tests to verify RED**

Run: `npm test -- --run src/App.test.tsx`

Expected: FAIL because `App` has no pinned-filter state.

- [ ] **Step 3: Implement local and synchronized state**

Extend URL parsing/writing, selection signatures, server snapshot application,
pending writes, browser navigation, filter updates, replacement selection,
agent promotion handling, and `SessionNavigation` props. Add the reusable
project rule: pinned selection uses amber checkbox state without a separate
pin icon and applies at terminal, cwd, and status levels.

- [ ] **Step 4: Run App tests and typecheck to verify GREEN**

Run: `npm test -- --run src/App.test.tsx`

Run: `npm run typecheck`

Expected: PASS.

### Task 5: End-to-end verification and integration

**Files:**
- Modify: `web/e2e/euphony.spec.ts`

**Interfaces:**
- Consumes: the complete status/cwd pin workflow.
- Produces: browser-level proof for interaction, persistence, and amber styling.

- [ ] **Step 1: Write the Playwright regression**

Create terminals in two groups, Shift-click a status and a cwd checkbox,
replace the ordinary selection, and assert pinned panes remain. Use
`getComputedStyle` to assert the pinned checkbox background resolves to
`rgb(245, 158, 11)` and assert no pin icon is rendered.

- [ ] **Step 2: Run the focused Playwright test**

Run: `npm run e2e -- --workers=1 --grep "pins status and cwd filters"`

Expected: PASS against an isolated test database.

- [ ] **Step 3: Run complete verification**

Run: `go test ./...`

Run: `npm test -- --run`

Run: `npm run typecheck`

Run: `npm run build`

Run: `npm run e2e -- --workers=1`

Expected: every command exits 0 with no failures.

- [ ] **Step 4: Commit and merge**

```bash
git add AGENTS.md docs internal cmd web
git commit -m "feat: pin status and cwd filters"
git -C /Users/ryotarai/work/euphony merge --no-ff feat/pinned-filter-checkboxes
```
