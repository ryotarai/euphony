# Auto-Select Attention Terminals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default-on setting that selects newly attention-needing terminals without moving focus.

**Architecture:** Persist a new boolean in the existing Go settings model,
SQLite row, and JSON API. The React polling flow records attention-transition
IDs and the existing workspace-selection effect appends them without changing
focus, while a controlled Settings checkbox edits the persisted value.

**Tech Stack:** Go, SQLite, React 19, TypeScript, Vitest, Testing Library,
shadcn/Base UI, Playwright

## Global Constraints

- Automatic attention selection must never change `focusedID`.
- Attention acknowledgement remains driven only by explicit focus.
- The setting defaults to enabled for new and migrated databases.
- Existing notification and attention-sound behavior remains unchanged.
- Existing selected terminals, pins, and filters remain active.

---

### Task 1: Persist the Setting

**Files:**
- Modify: `internal/session/manager.go`
- Modify: `internal/session/sqlite_store.go`
- Test: `internal/session/sqlite_store_test.go`
- Modify: `internal/server/settings.go`
- Test: `internal/server/settings_test.go`

**Interfaces:**
- Produces: `Settings.AutoSelectAttention bool` serialized as
  `autoSelectAttention`
- Produces: SQLite `settings.auto_select_attention INTEGER NOT NULL DEFAULT 1`

- [x] **Step 1: Write failing persistence and API tests**

Extend expected settings values with `AutoSelectAttention: true`, save
`AutoSelectAttention: false`, and require the PATCH payload below to round-trip:

```json
{
  "prefix": "Ctrl+A",
  "paneTabShortcut": "Ctrl+J",
  "sidebarWidth": 420,
  "sidebarCollapsed": true,
  "interfaceFontSize": 18,
  "terminalFontSize": 17,
  "agentLogFontSize": 16,
  "terminalHistoryLimit": 0,
  "autoSelectAttention": false
}
```

Add a legacy schema test that opens a settings table without
`auto_select_attention` and expects the loaded value to be `true`.

- [x] **Step 2: Run focused tests and verify the missing field fails**

Run:

```bash
go test ./internal/session ./internal/server
```

Expected: FAIL because `Settings.AutoSelectAttention` does not exist and the
API does not accept `autoSelectAttention`.

- [x] **Step 3: Implement the setting through the Go stack**

Add the field and default:

```go
AutoSelectAttention bool `json:"autoSelectAttention"`
```

Add the SQLite column to table creation and migration, load it into an integer,
convert it to bool, and save it with the other settings columns. Add a required
boolean to the settings API input and copy it to `session.Settings`.

- [x] **Step 4: Run focused tests**

Run:

```bash
go test ./internal/session ./internal/server
```

Expected: PASS.

### Task 2: Add No-Focus Automatic Selection

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/App.tsx`
- Test: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: `Settings.autoSelectAttention: boolean`
- Produces: attention transitions append available session IDs to
  `selectedIDs` without changing `focusedID`

- [x] **Step 1: Write failing React behavior tests**

Use fake timers to return an initial pair of sessions and then return one or
more copies with `needsAttention: true`. Assert:

```ts
expect(screen.getByRole("button", { name: "Select Claude" })).toHaveAttribute(
  "aria-current",
  "true",
);
expect(screen.getByLabelText("session-1 terminal pane")).toHaveAttribute(
  "data-active",
  "true",
);
expect(fetchMock).not.toHaveBeenCalledWith(
  "/api/sessions/session-2/acknowledge-attention",
  expect.anything(),
);
```

Repeat with `autoSelectAttention: false` and assert the second terminal is not
selected. Cover multiple simultaneous transitions by asserting every
transitioned terminal becomes selected.

- [x] **Step 2: Run the focused React tests and verify failure**

Run:

```bash
npm test -- --run src/App.test.tsx
```

Expected: FAIL because settings do not contain the field and attention
transitions only notify.

- [x] **Step 3: Implement transition consumption**

Add `autoSelectAttention` to the TypeScript settings interface and defaults.
Store pending transition IDs in a ref during polling. In the existing
workspace-selection effect:

```ts
const attentionIDs = settings.autoSelectAttention
  ? [...pendingAttentionSelectionIDsRef.current]
  : [];
pendingAttentionSelectionIDsRef.current.clear();
```

Append available IDs without duplicates, delete them from
`filterSelectedIDsRef`, preserve `focusedID`, pins and filters, and update the
URL with replace mode. Do not call `focusPane`, `selectSession`, or
`setFocusedID` for attention selection.

- [x] **Step 4: Run the focused React tests**

Run:

```bash
npm test -- --run src/App.test.tsx
```

Expected: PASS.

### Task 3: Add the Settings Control

**Files:**
- Modify: `web/src/App.tsx`
- Test: `web/src/App.test.tsx`

**Interfaces:**
- Consumes and produces: controlled `autoSelectAttention` draft boolean

- [x] **Step 1: Write a failing Settings dialog test**

Open Settings, assert **Auto-select attention terminals** is checked, uncheck
it, save, and assert the PATCH body contains:

```ts
autoSelectAttention: false
```

Reopen and cancel coverage must demonstrate that draft edits do not change the
saved setting.

- [x] **Step 2: Run the focused test and verify failure**

Run:

```bash
npm test -- --run src/App.test.tsx
```

Expected: FAIL because the checkbox does not exist.

- [x] **Step 3: Implement the controlled shadcn field**

Add a draft initialized by `openSettings`, include it in `saveSettings`, and
compose:

```tsx
<Field orientation="horizontal">
  <Checkbox
    id="auto-select-attention"
    checked={autoSelectAttentionDraft}
    onCheckedChange={(checked) => setAutoSelectAttentionDraft(Boolean(checked))}
  />
  <FieldContent>
    <FieldLabel htmlFor="auto-select-attention">
      Auto-select attention terminals
    </FieldLabel>
    <FieldDescription>
      Add them to the workspace without moving focus.
    </FieldDescription>
  </FieldContent>
</Field>
```

- [x] **Step 4: Run React tests and typecheck**

Run:

```bash
npm test -- --run
npm run typecheck
```

Expected: PASS.

### Task 4: Verify the Integrated Behavior

**Files:**
- Modify: `web/e2e/euphony.spec.ts`
- Modify: `AGENTS.md`

**Interfaces:**
- Protects: attention auto-selection never changes focus

- [x] **Step 1: Add Playwright coverage and the product rule**

Extend the settings scenario to assert the checked default, persist the
unchecked state, and reopen the dialog. Add or extend an attention scenario so
the newly selected pane is visible while the prior pane retains focus and no
acknowledgement request occurs.

Add this concise rule to `AGENTS.md`:

```markdown
- Automatically selecting an attention-needing terminal must not move focus;
  acknowledge attention only after the user explicitly focuses that terminal.
```

- [x] **Step 2: Run complete verification**

Run:

```bash
go test ./...
npm test -- --run
npm run typecheck
npm run build
npm run e2e -- euphony.spec.ts
git diff --check
```

Expected: all commands exit zero.

- [x] **Step 3: Review the diff and commit**

Confirm every `Settings` fixture includes `autoSelectAttention`, no production
path moves focus for automatic selection, and migrations default to enabled.
Commit all implementation, test, plan, and instruction changes with:

```bash
git commit -m "feat: auto-select terminals needing attention"
```
