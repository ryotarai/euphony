# Summary Generation Additional Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users configure and persist workspace-wide instructions included in every generated agent summary.

**Architecture:** Extend `session.Settings` and `/api/settings` with an optional `agentSummaryPrompt`, persisted in a schema version 12 SQLite column with an empty default. Pass the value through the summary service into the existing prompt builder, where it is bounded and inserted after the built-in rules. Add a controlled textarea below Summary provider in the existing Settings dialog.

**Tech Stack:** Go, SQLite, React 19, TypeScript, Vitest, Testing Library.

## Global Constraints

- The setting is workspace-wide and applies to both Claude and Codex summary generation.
- Empty `agentSummaryPrompt` disables the additional prompt; an omitted PATCH field preserves the stored value.
- The server accepts at most 8,000 Unicode runes and the final prompt remains bounded by `maxPromptBytes`.
- Existing databases migrate to schema version 12 with an empty additional prompt.
- Preserve unrelated dirty files in the base checkout and work only in the isolated worktree until merge.

---

### Task 1: Persist the additional summary prompt

**Files:**
- Modify: `internal/session/manager.go`
- Modify: `internal/session/sqlite_store.go`
- Modify: `internal/session/sqlite_store_test.go`
- Modify: `internal/server/settings.go`
- Modify: `internal/server/settings_test.go`

**Interfaces:**
- `session.Settings.AgentSummaryPrompt string` is the persisted value.
- `session.DefaultAgentSummaryPrompt` is the empty default.
- `PATCH /api/settings` accepts optional `agentSummaryPrompt`; nil preserves the current value, including an explicit empty string.

- [ ] **Step 1: Add failing model, migration, and API tests.**

Add `AgentSummaryPrompt: ""` to default settings assertions and expect SQLite `PRAGMA user_version` 12. Add a settings API case that PATCHes a multi-line prompt, verifies the response contains it, then PATCHes the same settings without `agentSummaryPrompt` and verifies the saved prompt remains. Add an overlong prompt case using `strings.Repeat("x", 8001)` that expects HTTP 400.

- [ ] **Step 2: Run focused tests to verify the expected failures.**

Run `go test ./internal/session ./internal/server -run 'Test(SQLiteStore|SettingsAPI)' -count=1`.

Expected: FAIL because `Settings` has no prompt field, the schema remains version 11, and the API does not accept or persist the new JSON field.

- [ ] **Step 3: Add the setting and SQLite version 12 migration.**

Add the field and empty default to `internal/session/manager.go`. Add `agent_summary_prompt TEXT NOT NULL DEFAULT ''` to the create-table statement. Detect the column and add it for existing databases, read and write it in `LoadSettings` and `SaveSettings`, and set `PRAGMA user_version = 12` after migration. Keep the existing provider migration gated at version 11.

- [ ] **Step 4: Extend settings validation and PATCH compatibility.**

Decode `AgentSummaryPrompt` as `*string`. If it is nil, load the current stored value; otherwise validate `utf8.RuneCountInString(*input.AgentSummaryPrompt) <= 8000` and save the exact text. Include the field in the settings value passed to `UpdateSettings` and returned by the handler.

- [ ] **Step 5: Run focused tests and commit.**

Run `go test ./internal/session ./internal/server -run 'Test(SQLiteStore|SettingsAPI)' -count=1`; expect PASS for schema version 12, defaults, round-trip persistence, omitted-field preservation, and overlong rejection. Then run `git add internal/session internal/server && git commit -m "feat: persist summary generation prompt"`.

### Task 2: Include the setting in generated summary prompts

**Files:**
- Modify: `internal/agentsummary/prompt.go`
- Modify: `internal/agentsummary/service.go`
- Modify: `internal/agentsummary/service_test.go`

**Interfaces:**
- `BuildPrompt(metadata, entries, terminalTail, additionalPrompt string) string` includes the optional instruction section.
- `Service.promptFor` reads `s.sessions.Settings().AgentSummaryPrompt` and passes it to `BuildPrompt`.

- [ ] **Step 1: Add failing prompt tests.**

Call `BuildPrompt` with a multi-line instruction and assert both lines are present. Assert that an empty instruction omits `Additional instructions from the workspace owner:`. Assert that a long instruction still produces a result no longer than `maxPromptBytes`.

- [ ] **Step 2: Run `go test ./internal/agentsummary -run 'TestBuildPrompt' -count=1` and verify the expected compile failure because the new argument is missing.**

- [ ] **Step 3: Implement bounded prompt composition.**

Add `maxAdditionalPromptRunes = 8000`, trim only for the empty check, insert the labeled section after the built-in rules and before session context, bound by runes before formatting, and retain the existing final byte cap. Update `Service.promptFor` to load and pass the setting.

- [ ] **Step 4: Run `go test ./internal/agentsummary -run 'TestBuildPrompt|TestService' -count=1`; expect PASS, then commit with `git add internal/agentsummary && git commit -m "feat: apply summary generation prompt"`.**

### Task 3: Expose the setting in the Settings dialog

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/components/SessionNavigation.test.tsx`
- Modify: `web/src/components/SessionNavigation.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- `Settings.agentSummaryPrompt: string` is present in all frontend settings fixtures and defaults.
- The Settings dialog exposes a textarea with accessible label `Additional summary instructions` and `maxLength={8000}`.

- [ ] **Step 1: Add a failing React settings test.**

Give the shared default fixture a non-empty prompt. Extend the existing settings test to find the textarea, assert its loaded value, edit it, save, expect `agentSummaryPrompt` in the PATCH body, and assert reopening loads the saved value. Add the empty field to other `Settings` fixtures.

- [ ] **Step 2: Run `cd web && npm test -- --run src/App.test.tsx` and verify failure because the settings type, draft state, and textarea do not exist.**

- [ ] **Step 3: Wire the field through the UI.**

Add the field to `Settings` and defaults. Create `agentSummaryPromptDraft`, synchronize it while loading settings and opening the dialog, include it in `persistSettings`, and render an existing `Textarea` directly below Summary provider with helper text and `maxLength={8000}`. Keep it controlled so cancel leaves the saved setting unchanged.

- [ ] **Step 4: Add compact styling.**

Give the settings textarea a minimum height of approximately 7rem, allow vertical resize, and preserve the existing grid spacing and focus treatment. Keep copy sentence case and avoid decorative additions.

- [ ] **Step 5: Run `cd web && npm test -- --run src/App.test.tsx && npm run typecheck`; expect PASS, then commit with `git add web/src && git commit -m "feat: add summary prompt setting"`.**

### Task 4: Verify and integrate

**Files:**
- Verify all files changed by Tasks 1–3.

- [ ] **Step 1: Run `go test ./...`; expect every Go package to pass.**

- [ ] **Step 2: Run `cd web && npm test -- --run --maxWorkers=1`, `npm run typecheck`, and `npm run build`; expect 0 failures, a clean typecheck, and a successful build.**

- [ ] **Step 3: Review with `git -c core.fsmonitor=false diff main...HEAD --stat` and `git -c core.fsmonitor=false status --short --branch`. Confirm only the spec, plan, persistence/API, prompt, and settings UI files are changed; restore any tracked build placeholder removed by the build.**

- [ ] **Step 4: From `/Users/ryotarai/work/euphony`, merge with `git -c core.fsmonitor=false merge --no-ff codex/summary-prompt-settings -m "Merge summary generation prompt setting"`, preserving the base checkout's pre-existing `web/dist/.keep` deletion and `tmp/` contents.**
