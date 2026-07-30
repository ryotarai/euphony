# Terminal Font Family Setting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent, live-previewed terminal font-family setting that accepts arbitrary CSS fallback stacks.

**Architecture:** Extend the server-owned `Settings` record and SQLite singleton row with one validated string. Route a separate saved/draft value through `App` into `TerminalView`, where it becomes xterm's `fontFamily` option and participates in terminal recreation.

**Tech Stack:** Go, modernc SQLite, React 19, TypeScript, xterm.js, Vitest/Testing Library, Playwright

## Global Constraints

- Preserve the current default font stack exactly: `Menlo, Monaco, "Hiragino Sans", "Yu Gothic", "Noto Sans Mono CJK JP", monospace`.
- Trim leading and trailing whitespace before previewing and saving.
- Accept 1 through 256 Unicode code points.
- Preserve the existing Settings layout and black terminal-workspace visual identity.
- Write each behavior test first and observe the expected failure before production changes.

---

## File Structure

- `internal/session/manager.go`: declares the setting and its default.
- `internal/session/sqlite_store.go`: migrates, loads, and saves the setting.
- `internal/session/sqlite_store_test.go`: proves defaults, round trips, and legacy migration.
- `internal/server/settings.go`: validates and normalizes API input.
- `internal/server/settings_test.go`: proves the HTTP contract.
- `web/src/types.ts`: exposes the setting to TypeScript.
- `web/src/App.tsx`: owns draft, preview, validation, persistence, and prop routing.
- `web/src/App.test.tsx`: proves Settings dialog behavior and PATCH payloads.
- `web/src/components/TerminalView.tsx`: applies the family to xterm.
- `web/src/components/TerminalView.test.tsx`: proves creation and recreation inputs.
- `web/e2e/euphony.spec.ts`: proves live preview and reload persistence in Chromium.

### Task 1: Persist the Terminal Font Family

**Files:**
- Modify: `internal/session/manager.go`
- Modify: `internal/session/sqlite_store.go`
- Test: `internal/session/sqlite_store_test.go`

**Interfaces:**
- Produces: `session.Settings.TerminalFontFamily string`
- Produces: `session.DefaultTerminalFontFamily string`
- Produces: SQLite column `settings.terminal_font_family`

- [ ] **Step 1: Write failing persistence and migration assertions**

Add `TerminalFontFamily: "JetBrains Mono, monospace"` to the round-trip
`Settings` value. Assert new stores and the legacy-settings migration both
return `DefaultTerminalFontFamily`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
go test ./internal/session -run 'TestSQLiteStore(PersistsSettings|MigratesLegacySettings)' -count=1
```

Expected: compilation fails because `TerminalFontFamily` and
`DefaultTerminalFontFamily` do not exist.

- [ ] **Step 3: Add the field, default, schema, migration, and SQL bindings**

Declare:

```go
const DefaultTerminalFontFamily = `Menlo, Monaco, "Hiragino Sans", "Yu Gothic", "Noto Sans Mono CJK JP", monospace`

type Settings struct {
    // existing fields
    TerminalFontFamily string `json:"terminalFontFamily"`
}
```

Add `terminal_font_family TEXT NOT NULL DEFAULT '<default stack>'` to new
tables, add the same column when `hasColumn` is false, and include the value in
the `SELECT`, `Scan`, `UPDATE`, and update argument list.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
go test ./internal/session -run 'TestSQLiteStore(PersistsSettings|MigratesLegacySettings)' -count=1
```

Expected: PASS.

### Task 2: Validate the Settings API

**Files:**
- Modify: `internal/server/settings.go`
- Test: `internal/server/settings_test.go`

**Interfaces:**
- Consumes: `session.Settings.TerminalFontFamily`
- Produces: normalized JSON field `terminalFontFamily`

- [ ] **Step 1: Write failing API contract tests**

Add `terminalFontFamily` to all existing payload fixtures. In the persistence
test, send `"  JetBrains Mono, monospace  "` and expect
`"JetBrains Mono, monospace"`. Add invalid payloads for a missing field, an
empty/whitespace-only field, and `strings.Repeat("界", 257)`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
go test ./internal/server -run 'TestSettingsAPI' -count=1
```

Expected: the accepted request does not preserve the family and invalid values
are not rejected for the new contract.

- [ ] **Step 3: Decode, normalize, and validate the family**

Add `TerminalFontFamily string` to the request struct. Normalize with
`strings.TrimSpace`, then require:

```go
terminalFontFamily != "" &&
utf8.RuneCountInString(terminalFontFamily) <= 256
```

Store the normalized value in `session.Settings`.

- [ ] **Step 4: Run focused backend tests and verify GREEN**

Run:

```bash
go test ./internal/session ./internal/server -run 'TestSQLiteStore.*Settings|TestSettingsAPI' -count=1
```

Expected: PASS.

- [ ] **Step 5: Commit the backend slice**

```bash
git add internal/session/manager.go internal/session/sqlite_store.go internal/session/sqlite_store_test.go internal/server/settings.go internal/server/settings_test.go
git commit -m "feat: persist terminal font family"
```

### Task 3: Apply the Family to xterm

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/components/TerminalView.tsx`
- Test: `web/src/components/TerminalView.test.tsx`

**Interfaces:**
- Consumes: `Settings.terminalFontFamily`
- Produces: `TerminalViewProps.fontFamily?: string`
- Produces: `createTerminal(fontFamily: string, fontSize: number, scrollback: number): TerminalDriver`

- [ ] **Step 1: Write a failing terminal creation test**

Extend the configured-font test to collect both values:

```tsx
const receivedFonts: Array<[string, number]> = [];
createTerminal={(fontFamily, fontSize) => {
  receivedFonts.push([fontFamily, fontSize]);
  return terminal;
}}
```

Render with `fontFamily="JetBrains Mono, monospace"` and then rerender with
`fontFamily="Iosevka, monospace"`. Expect the two exact tuples, proving a font
change recreates the driver.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd web
npm test -- --run src/components/TerminalView.test.tsx -t 'configured font'
```

Expected: the callback receives the old `(fontSize, scrollback)` signature.

- [ ] **Step 3: Route the family to xterm**

Add `fontFamily` with the existing default stack to `TerminalView`, change
`defaultTerminal` and `createTerminal` to accept the family first, set
`new Terminal({ fontFamily })`, and include `fontFamily` in the creation
effect's dependencies.

- [ ] **Step 4: Run the component tests and verify GREEN**

Run:

```bash
cd web
npm test -- --run src/components/TerminalView.test.tsx
```

Expected: PASS.

### Task 4: Add Settings Draft, Preview, and Validation

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/App.tsx`
- Test: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: `Settings.terminalFontFamily`
- Produces: `renderTerminal(..., fontFamily: string, fontSize: number, ...)`
- Produces: labeled Settings input `Terminal font`

- [ ] **Step 1: Write failing App behavior assertions**

Add the default family to every `Settings` fixture and a `data-font-family`
attribute to the custom terminal renderer. In the Settings test:

1. Fill `Terminal font` with `"JetBrains Mono", monospace`.
2. Assert the rendered terminal receives the draft immediately.
3. Escape and assert the rendered terminal returns to the saved default.
4. Reopen, enter `  Iosevka, monospace  `, save, and assert the PATCH body
   contains `terminalFontFamily: "Iosevka, monospace"`.
5. Add a focused validation test proving whitespace-only input keeps the dialog
   open with `Choose a font family of 1 to 256 characters.`

- [ ] **Step 2: Run focused App tests and verify RED**

Run:

```bash
cd web
npm test -- --run src/App.test.tsx -t 'settings|font'
```

Expected: no `Terminal font` field exists and the renderer lacks the family
argument.

- [ ] **Step 3: Implement draft and preview state**

Add `terminalFontFamily` to TypeScript settings/defaults, a
`terminalFontFamilyDraft` state, and this normalization helper:

```ts
function parseTerminalFontFamily(value: string): string | null {
  const trimmed = value.trim();
  return trimmed && Array.from(trimmed).length <= 256 ? trimmed : null;
}
```

Reset the draft in `openSettings` and after initial API settings load. While the
dialog is open, preview a valid parsed draft and otherwise preserve the saved
family.

- [ ] **Step 4: Implement the Settings field and save validation**

Add a full-width `Field` after Font sizes:

```tsx
<Field data-invalid={settingsError?.field === "terminalFontFamily"}>
  <FieldLabel htmlFor="terminalFontFamily">Terminal font</FieldLabel>
  <Input
    id="terminalFontFamily"
    name="terminalFontFamily"
    value={terminalFontFamilyDraft}
    onChange={(event) => setTerminalFontFamilyDraft(event.target.value)}
    aria-invalid={settingsError?.field === "terminalFontFamily"}
  />
  <FieldDescription>
    Use a CSS font family or fallback list. Unavailable fonts use the next family.
  </FieldDescription>
  {settingsError?.field === "terminalFontFamily" && (
    <FieldError>{settingsError.message}</FieldError>
  )}
</Field>
```

Extend the error-field union, reject invalid input with the specified message,
save the parsed value, and pass the preview family through `renderTerminal` to
`TerminalView`.

- [ ] **Step 5: Run App tests and verify GREEN**

Run:

```bash
cd web
npm test -- --run src/App.test.tsx src/components/TerminalView.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit the frontend slice**

```bash
git add web/src/types.ts web/src/App.tsx web/src/App.test.tsx web/src/components/TerminalView.tsx web/src/components/TerminalView.test.tsx
git commit -m "feat: configure terminal font family"
```

### Task 5: Verify Persistence in Chromium

**Files:**
- Modify: `web/e2e/euphony.spec.ts`

**Interfaces:**
- Consumes: `/api/settings`, `Terminal font`, and xterm's rendered row styles.
- Produces: transport and browser-level regression coverage.

- [ ] **Step 1: Extend the E2E settings reset and persistence scenario**

Add the default `terminalFontFamily` to `clearSessions`. In the existing
settings persistence scenario, fill `Terminal font` with
`"Courier New", monospace`, assert `.xterm-rows` has that computed
`font-family`, save, reload, reopen Settings, and assert the input retains the
exact value.

- [ ] **Step 2: Run the focused E2E test**

Run with an isolated database and one worker:

```bash
cd web
EUPHONY_E2E_PORT=18087 npm run e2e -- --grep 'persists sidebar controls, settings' --workers=1
```

Expected: PASS.

- [ ] **Step 3: Run complete verification**

```bash
go test ./...
cd web
npm test -- --run
npm run build
EUPHONY_E2E_PORT=18087 npm run e2e -- --workers=1
```

Expected: all commands exit 0 with no failures.

- [ ] **Step 4: Commit E2E coverage**

```bash
git add web/e2e/euphony.spec.ts
git commit -m "test: cover terminal font persistence"
```
