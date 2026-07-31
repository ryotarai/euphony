# Terminal Appearance Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent controls for terminal line height, cursor style, cursor blinking, and scroll sensitivity while preserving the current terminal appearance by default.

**Architecture:** Extend the server-owned session.Settings record and SQLite row with four validated fields, then carry them through the settings API. Keep React's saved values and Settings-dialog drafts separate so valid drafts preview through the existing terminal render path and canceled drafts disappear. Pass the values to the xterm constructor so appearance changes use the existing terminal recreation and resize flow.

**Tech Stack:** Go, SQLite, React 19, TypeScript, xterm.js, shadcn field primitives, Vitest/Testing Library, Playwright

## Global Constraints

- Terminal line height is finite, between 1.00 and 2.00 inclusive, and uses 0.05 increments; default is 1.25.
- Cursor style is exactly bar, block, or underline; default is bar.
- Cursor blink is a boolean; default is false.
- Scroll sensitivity is a whole number from 1 through 5; default is 3.
- Existing databases migrate additively and retain the current terminal appearance.
- Valid drafts preview while Settings is open; Cancel, Escape, or dismissal restores the saved settings.
- Preserve existing font size, font family, history, shortcut, sidebar, and attention-setting behavior.
- Use one E2E worker with the isolated EUPHONY_DB=:memory: database and a dedicated port.

## File Map

- internal/session/manager.go: source-of-truth settings fields and defaults.
- internal/session/sqlite_store.go: new settings columns, additive migrations, load/save mapping.
- internal/session/sqlite_store_test.go: default, round-trip, and legacy migration coverage.
- internal/server/settings.go: JSON decoding and validation for the four fields.
- internal/server/settings_test.go: accepted and rejected Settings API payloads.
- web/src/types.ts: shared TypeScript settings shape and cursor-style union.
- web/src/settings.ts: terminal appearance defaults shared by App and fallback navigation.
- web/src/components/TerminalView.tsx: xterm option plumbing and recreation dependencies.
- web/src/components/TerminalView.test.tsx: terminal factory argument and recreation coverage.
- web/src/App.tsx: drafts, preview values, save validation, Settings controls, and render propagation.
- web/src/App.test.tsx: Settings preview, save, cancel, and pane propagation coverage.
- web/src/components/SessionNavigation.tsx: complete fallback settings object for isolated component use.
- web/src/components/SessionNavigation.test.tsx: Settings fixture fields required by the shared type.
- web/src/styles.css: compact terminal-appearance control layout and native select styling.
- web/e2e/euphony.spec.ts: persistence and live terminal appearance assertions.
- web/e2e/terminal-reliability.spec.ts: complete reset payload for the new API fields.

---

### Task 1: Persist and validate terminal appearance settings

**Files:**
- Modify: internal/session/manager.go
- Modify: internal/session/sqlite_store.go
- Test: internal/session/sqlite_store_test.go
- Modify: internal/server/settings.go
- Test: internal/server/settings_test.go

**Interfaces:**
- Consumes: existing session.Settings, SQLite settings row, and the /api/settings PATCH payload.
- Produces: Settings.TerminalLineHeight float64, Settings.TerminalCursorStyle string, Settings.TerminalCursorBlink bool, Settings.TerminalScrollSensitivity int, with JSON names terminalLineHeight, terminalCursorStyle, terminalCursorBlink, and terminalScrollSensitivity.

- [ ] **Step 1: Extend persistence tests with defaults and round trip**

In TestSQLiteStorePersistsSettings, assert new defaults and include non-default values in want:

~~~go
if defaults.TerminalLineHeight != 1.25 || defaults.TerminalCursorStyle != "bar" ||
	defaults.TerminalCursorBlink || defaults.TerminalScrollSensitivity != 3 {
	t.Fatalf("default terminal appearance settings = %#v", defaults)
}

want := Settings{
	Prefix: "Ctrl+A", PaneTabShortcut: "Ctrl+J",
	SidebarWidth: 420, SidebarCollapsed: true,
	InterfaceFontSize: 18, TerminalFontSize: 17,
	TerminalFontFamily: "JetBrains Mono, monospace", AgentLogFontSize: 16,
	TerminalHistoryLimit: 0, AutoSelectAttention: false,
	TerminalLineHeight: 1.5, TerminalCursorStyle: "underline",
	TerminalCursorBlink: true, TerminalScrollSensitivity: 5,
}
~~~

Update TestSQLiteStoreMigratesLegacySettingsWithDefaultPaneTabShortcut so its
expected Settings also contains 1.25, "bar", false, and 3.

- [ ] **Step 2: Run persistence tests and verify RED**

Run:

~~~bash
go test ./internal/session -run 'TestSQLiteStore(PersistsSettings|MigratesLegacySettingsWithDefaultPaneTabShortcut)'
~~~

Expected: compilation fails because Settings does not yet expose the four
requested fields.

- [ ] **Step 3: Add fields, defaults, and additive SQLite migration**

Add these fields in internal/session/manager.go:

~~~go
TerminalLineHeight        float64
TerminalCursorStyle       string
TerminalCursorBlink       bool
TerminalScrollSensitivity int
~~~

Use defaults 1.25, "bar", false, and 3. Add the four columns to the initial
settings table, then use the existing hasColumn migration flow for old
databases:

~~~sql
ALTER TABLE settings ADD COLUMN terminal_line_height REAL NOT NULL DEFAULT 1.25
ALTER TABLE settings ADD COLUMN terminal_cursor_style TEXT NOT NULL DEFAULT 'bar'
ALTER TABLE settings ADD COLUMN terminal_cursor_blink INTEGER NOT NULL DEFAULT 0
ALTER TABLE settings ADD COLUMN terminal_scroll_sensitivity INTEGER NOT NULL DEFAULT 3
~~~

Select and scan the columns in LoadSettings, convert blink between SQLite
integer and Go boolean in load/save, include all four values in the existing
UPDATE, and bump PRAGMA user_version from 8 to 9.

- [ ] **Step 4: Run persistence tests and verify GREEN**

Run:

~~~bash
go test ./internal/session -run 'TestSQLiteStore(PersistsSettings|MigratesLegacySettingsWithDefaultPaneTabShortcut)'
~~~

Expected: PASS, including the reopened database round trip.

- [ ] **Step 5: Add API acceptance and rejection cases**

Extend the accepted PATCH in TestSettingsAPIReadsAndPersistsSettings with
terminalLineHeight:1.5, terminalCursorStyle:"underline",
terminalCursorBlink:true, and terminalScrollSensitivity:5, and include the
same values in the expected Settings.

Add the four default values to every valid baseline in
TestSettingsAPIRejectsInvalidSettings, then cover:

~~~go
terminalLineHeight: 0.95, 2.05, 1.01
terminalCursorStyle: "dot", ""
terminalCursorBlink: "yes"
terminalScrollSensitivity: 0, 6, 3.5
~~~

Also omit each new property once. Merge each override into an otherwise valid
payload so each 400 response identifies the named field.

- [ ] **Step 6: Run API tests and verify RED**

Run:

~~~bash
go test ./internal/server -run 'TestSettingsAPI'
~~~

Expected: the new accepted payload is rejected because the handler does not
decode and validate the four properties.

- [ ] **Step 7: Implement API decoding and validation**

Decode the new fields, using a pointer for the required boolean:

~~~go
TerminalLineHeight        float64
TerminalCursorStyle       string
TerminalCursorBlink       *bool
TerminalScrollSensitivity float64
~~~

Implement these helpers and include them in the existing invalid-settings
condition:

~~~go
func validTerminalLineHeight(value float64) bool {
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 1 || value > 2 {
		return false
	}
	scaled := value * 20
	return math.Abs(scaled-math.Round(scaled)) < 1e-9
}

func validTerminalCursorStyle(value string) bool {
	return value == "bar" || value == "block" || value == "underline"
}

func validTerminalScrollSensitivity(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) &&
		math.Trunc(value) == value && value >= 1 && value <= 5
}
~~~

Construct session.Settings with the validated float line height, cursor style,
dereferenced blink value, and integer scroll sensitivity.

- [ ] **Step 8: Run backend tests**

Run:

~~~bash
go test ./internal/session ./internal/server
~~~

Expected: PASS.

- [ ] **Step 9: Commit backend deliverable**

~~~bash
git add internal/session/manager.go internal/session/sqlite_store.go internal/session/sqlite_store_test.go internal/server/settings.go internal/server/settings_test.go
git commit -m "feat: persist terminal appearance settings"
~~~

### Task 2: Pass terminal appearance values to xterm

**Files:**
- Modify: web/src/types.ts
- Modify: web/src/settings.ts
- Modify: web/src/components/TerminalView.tsx
- Test: web/src/components/TerminalView.test.tsx

**Interfaces:**
- Consumes: the four persisted settings from Task 1.
- Produces: TerminalCursorStyle = "bar" | "block" | "underline"; TerminalView props lineHeight, cursorStyle, cursorBlink, and scrollSensitivity; and a terminal factory whose first three arguments remain (fontFamily, fontSize, scrollback) followed by the four appearance values.

- [ ] **Step 1: Add a failing factory-argument test**

Extend the configured-font test so the factory records the four appearance
arguments:

~~~tsx
const received: unknown[][] = [];
render(
	<TerminalView
		session={runningSession}
		api={api}
		fontFamily="Iosevka, monospace"
		fontSize={18}
		lineHeight={1.5}
		cursorStyle="underline"
		cursorBlink
		scrollSensitivity={5}
		createTerminal={(fontFamily, fontSize, scrollback, lineHeight, cursorStyle, cursorBlink, scrollSensitivity) => {
			received.push([fontFamily, fontSize, scrollback, lineHeight, cursorStyle, cursorBlink, scrollSensitivity]);
			return terminal;
		}}
		createSocket={() => socket}
	/>,
);
expect(received[0]).toEqual([
	"Iosevka, monospace", 18, 8192, 1.5, "underline", true, 5,
]);
~~~

Rerender with lineHeight={1.75} and assert a second factory call has the new
value. Keep the history-limit test to prove scrollback-only changes still
call setScrollback without reconnecting.

- [ ] **Step 2: Run focused terminal tests and verify RED**

Run:

~~~bash
cd web && npm test -- --run src/components/TerminalView.test.tsx
~~~

Expected: TypeScript or the assertion fails because the new props and factory
values are not wired.

- [ ] **Step 3: Add shared type and defaults**

In web/src/types.ts, add:

~~~ts
export type TerminalCursorStyle = "bar" | "block" | "underline";
~~~

Add the four fields to Settings. In web/src/settings.ts, export defaults
defaultTerminalLineHeight = 1.25, defaultTerminalCursorStyle = "bar",
defaultTerminalCursorBlink = false, and defaultTerminalScrollSensitivity = 3.

- [ ] **Step 4: Wire values into TerminalView and xterm**

Add optional props with those defaults. Extend createTerminal and
defaultTerminal after the existing (fontFamily, fontSize, scrollback)
arguments. Construct xterm with:

~~~ts
new Terminal({
	// existing options...
	fontFamily,
	fontSize,
	lineHeight,
	cursorStyle,
	cursorBlink,
	scrollSensitivity,
	scrollback,
});
~~~

Include all four props in the creation effect dependency list so a change
recreates and refits the xterm. Preserve the existing history-only scrollback
effect and socket/resize behavior.

- [ ] **Step 5: Run focused and full frontend tests**

Run:

~~~bash
cd web && npm test -- --run src/components/TerminalView.test.tsx
cd web && npm test -- --run
~~~

Expected: PASS.

- [ ] **Step 6: Commit terminal wiring**

~~~bash
git add web/src/types.ts web/src/settings.ts web/src/components/TerminalView.tsx web/src/components/TerminalView.test.tsx
git commit -m "feat: apply terminal appearance settings"
~~~

### Task 3: Add Settings drafts, preview, and controls

**Files:**
- Modify: web/src/App.tsx
- Test: web/src/App.test.tsx
- Modify: web/src/components/SessionNavigation.tsx
- Modify: web/src/components/SessionNavigation.test.tsx
- Modify: web/src/styles.css

**Interfaces:**
- Consumes: Settings and terminal defaults from Task 2.
- Produces: labeled controls Terminal line height, Cursor style, Cursor blink, and Scroll sensitivity, saved in the PATCH payload and passed through renderTerminal to TerminalView.

- [ ] **Step 1: Add a failing App test for preview and save**

Add the four fields to the defaultSettings fixture, then add this interaction
to the existing Settings test:

~~~tsx
fireEvent.change(within(dialog).getByLabelText("Terminal line height"), {
	target: { value: "1.5" },
});
await user.selectOptions(within(dialog).getByLabelText("Cursor style"), "underline");
await user.click(within(dialog).getByRole("checkbox", { name: "Cursor blink" }));
fireEvent.change(within(dialog).getByLabelText("Scroll sensitivity"), {
	target: { value: "5" },
});
~~~

Extend the render stub to expose data-line-height, data-cursor-style,
data-cursor-blink, and data-scroll-sensitivity; assert the four preview
values before saving. Assert the PATCH body contains 1.5, "underline", true,
and 5. Add a cancel assertion that changes the controls, presses Escape,
reopens Settings, and sees the saved values.

- [ ] **Step 2: Run the App test and verify RED**

Run:

~~~bash
cd web && npm test -- --run src/App.test.tsx
~~~

Expected: the new labels are not found or the render stub does not receive
the new values.

- [ ] **Step 3: Add drafts and parsing helpers**

Import the four defaults and TerminalCursorStyle, add the fields to
defaultSettings, and add string/boolean drafts:

~~~ts
const [terminalLineHeightDraft, setTerminalLineHeightDraft] = useState(
	String(settings.terminalLineHeight),
);
const [terminalCursorStyleDraft, setTerminalCursorStyleDraft] = useState(
	settings.terminalCursorStyle,
);
const [terminalCursorBlinkDraft, setTerminalCursorBlinkDraft] = useState(
	settings.terminalCursorBlink,
);
const [terminalScrollSensitivityDraft, setTerminalScrollSensitivityDraft] = useState(
	String(settings.terminalScrollSensitivity),
);
~~~

Implement parseTerminalLineHeight with finite/range/0.05-step checks,
parseTerminalCursorStyle with the three-value union, and
parseTerminalScrollSensitivity with integer/range checks. Add the four
field names to settingsError and reset all drafts after API load and in
openSettings.

- [ ] **Step 4: Add preview and save validation**

Fold valid drafts into previewSettings while Settings is open:

~~~ts
terminalLineHeight:
	parseTerminalLineHeight(terminalLineHeightDraft) ?? settings.terminalLineHeight,
terminalCursorStyle:
	parseTerminalCursorStyle(terminalCursorStyleDraft) ?? settings.terminalCursorStyle,
terminalCursorBlink: terminalCursorBlinkDraft,
terminalScrollSensitivity:
	parseTerminalScrollSensitivity(terminalScrollSensitivityDraft) ?? settings.terminalScrollSensitivity,
~~~

Validate the same values in saveSettings, report these messages, and include
the values in persistSettings:
Choose a value from 1.00 to 2.00 in 0.05 increments.
Choose Bar, Block, or Underline.
Choose a whole number from 1 to 5.

- [ ] **Step 5: Route preview values through the terminal renderer**

Append the four appearance arguments after the existing sourceVisible argument
in the renderTerminal callback type, keeping all existing positional
arguments stable. Pass the four previewSettings values from the pane map; the
default callback passes them to TerminalView.

Update the fallback Settings object in SessionNavigation.tsx and its test
fixture with the four defaults.

- [ ] **Step 6: Render the controls**

Add a Terminal appearance section after the font controls. Use a number input
with min=1, max=2, step=0.05, and inputMode=decimal for line height; a native
select with bar, block, and underline; a Checkbox labeled Cursor blink; and a
number input with min=1, max=5, step=1 for scroll sensitivity. Each control
clears its own validation error and exposes aria-invalid when invalid.

- [ ] **Step 7: Style the responsive appearance section**

Reuse the existing section heading and input language. Add a two-column
desktop terminal-appearance-fields grid, stack it at max-width 480px, and
style settings-select with the same min-height, border, radius, and focus
treatment as existing Settings inputs. Keep the existing dialog max-height
and scroll behavior for mobile.

- [ ] **Step 8: Run frontend tests and build**

Run:

~~~bash
cd web && npm test -- --run src/App.test.tsx src/components/SessionNavigation.test.tsx
cd web && npm run typecheck
cd web && npm run build
~~~

Expected: PASS. The App test must prove preview values reach the render stub,
successful save sends all four fields, and Escape restores saved values.

- [ ] **Step 9: Commit Settings UI deliverable**

~~~bash
git add web/src/App.tsx web/src/App.test.tsx web/src/components/SessionNavigation.tsx web/src/components/SessionNavigation.test.tsx web/src/styles.css
git commit -m "feat: add terminal appearance controls"
~~~

### Task 4: Update transport fixtures and add Playwright coverage

**Files:**
- Modify: web/e2e/euphony.spec.ts
- Modify: web/e2e/terminal-reliability.spec.ts

**Interfaces:**
- Consumes: complete /api/settings payload and Settings labels from Tasks 1–3.
- Produces: one-worker E2E coverage for live preview, persistence across reload, and mobile dialog layout.

- [ ] **Step 1: Extend reset payloads**

Add to both clearSessions PATCH payloads:

~~~ts
terminalLineHeight: 1.25,
terminalCursorStyle: "bar",
terminalCursorBlink: false,
terminalScrollSensitivity: 3,
~~~

- [ ] **Step 2: Extend the existing persistence scenario**

In persists sidebar controls, settings, and tmux-style commands, fill line
height with 1.5, choose underline, check blink, and fill sensitivity with 5.
Capture the first terminal row's height after applying the font-only controls,
then assert with `expect.poll` that the row becomes taller after applying the
1.5 line-height setting. xterm.js uses the line-height option for cell
geometry, so the browser's computed `line-height` property remains `normal`.
Also assert the Settings dialog reopens with the same values after reload:

~~~ts
await settingsDialog.getByLabel("Terminal line height").fill("1.5");
await settingsDialog.getByLabel("Cursor style").selectOption("underline");
await settingsDialog.getByRole("checkbox", { name: "Cursor blink" }).check();
await settingsDialog.getByLabel("Scroll sensitivity").fill("5");
await expect
  .poll(async () => page.locator(".xterm-rows").first().evaluate(
    (rows) => rows.firstElementChild?.getBoundingClientRect().height ?? 0,
  ))
  .toBeGreaterThan(fontOnlyRowHeight);
~~~

After reload, assert the input, select, checkbox, and sensitivity value before
continuing with the existing history assertions.

- [ ] **Step 3: Run focused E2E with the isolated backend**

Run:

~~~bash
cd web && EUPHONY_E2E_PORT=18081 npm run e2e -- --workers=1 --grep "persists sidebar controls, settings"
~~~

Expected: PASS using EUPHONY_DB=:memory: and port 18081.

- [ ] **Step 4: Run complete verification**

Run each command freshly:

~~~bash
go test ./...
cd web && npm test -- --run
cd web && npm run typecheck
cd web && npm run build
cd web && EUPHONY_E2E_PORT=18082 npm run e2e -- --workers=1
~~~

Expected: all commands exit 0; frontend and Playwright complete with one
worker.

- [ ] **Step 5: Inspect desktop and mobile screenshots**

Use the Playwright output to confirm labels remain associated, the appearance
grid stacks at 390px, and the scrollable Settings dialog stays within the
844px viewport.

- [ ] **Step 6: Commit E2E coverage**

~~~bash
git add web/e2e/euphony.spec.ts web/e2e/terminal-reliability.spec.ts
git commit -m "test: cover terminal appearance settings"
~~~

### Task 5: Finish the isolated branch and merge it back

- [ ] **Step 1: Inspect final diff and unrelated changes**

Run:

~~~bash
git status --short --branch
git diff main...HEAD --stat
git diff main...HEAD --check
~~~

Expected: only the design spec, implementation plan, implementation, tests,
and E2E fixture updates appear.

- [ ] **Step 2: Merge the verified branch into main**

From the base checkout, run:

~~~bash
git merge --no-ff codex/terminal-line-height-settings -m "Merge terminal appearance settings"
~~~

Preserve the base checkout's pre-existing web/dist/.keep deletion and
untracked tmp/ contents; do not reset or clean them.
