# Project Terminal Creation Error Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve and display the platform-specific reason when project terminal creation fails.

**Architecture:** The v1 terminal endpoint adds the existing startup error as `details.cause` while preserving its stable code and message. The Web API client formats that optional cause into `ApiError.message`, and the project-agent flow relies on the formatted message instead of overwriting it.

**Tech Stack:** Go HTTP server, TypeScript/React, Vitest, Testing Library.

## Global Constraints

- Keep the stable `terminal_create_failed` code and generic top-level message.
- Include a cause only for terminal creation failures, not validation errors.
- Preserve existing behavior when no cause is returned.
- Use public HTTP/API/UI behavior in tests.

---

### Task 1: Document and verify the error contract

**Files:**
- Create: `docs/superpowers/specs/2026-08-15-project-terminal-error-details-design.md`
- Create: `docs/superpowers/plans/2026-08-15-project-terminal-error-details.md`

- [x] **Step 1: Record the design and implementation boundaries.**

  The design keeps stable error codes and messages, adds only
  `error.details.cause` for terminal startup failures, and displays that
  cause in the Web client.

- [x] **Step 2: Self-review the documents.**

  Confirm there are no placeholders, the error flow matches the files being
  changed, and every design requirement has a corresponding test or code
  task below.

- [ ] **Step 3: Commit the documents.**

  Run:

  ```bash
  git add docs/superpowers/specs/2026-08-15-project-terminal-error-details-design.md docs/superpowers/plans/2026-08-15-project-terminal-error-details.md
  git commit -m "docs: plan project terminal error details"
  ```

### Task 2: Add failing API and UI regression tests

**Files:**
- Modify: `internal/server/projects_test.go`
- Modify: `web/src/api.test.ts`
- Modify: `web/src/App.test.tsx`

- [ ] **Step 1: Test the HTTP error contract.**

  Configure a project test server with a missing shell, create a real
  project, and POST a project terminal. Assert the 500 response keeps code
  `terminal_create_failed`, keeps the stable message, and returns a non-empty
  `details.cause`.

- [ ] **Step 2: Test Web API cause formatting.**

  Return a v1 error envelope containing
  `{ code: "terminal_create_failed", message: "The terminal could not be created.", details: { cause: "start ConPTY process: ..." } }` and assert the rejected `ApiError.message` includes both the stable message and cause.

- [ ] **Step 3: Test the project-agent alert.**

  Drive the existing project-agent dialog through its real button flow,
  return the v1 terminal error, and assert the workspace alert contains the
  cause rather than `The project terminal could not be created.`.

- [ ] **Step 4: Run the focused tests and confirm RED.**

  Run:

  ```bash
  go test ./internal/server -run 'TestProjectTerminalCreationIncludesStartFailureDetails' -count=1
  cd web && npm test -- --run src/api.test.ts src/App.test.tsx
  ```

  The new tests must fail because the server omits the cause, the API client
  ignores `details.cause`, and the UI overwrites the detailed message.

### Task 3: Implement cause propagation and display

**Files:**
- Modify: `internal/server/v1_terminal.go`
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Return the startup cause from the v1 endpoint.**

  In the default terminal-creation error branch, call
  `writeV1Error` with `map[string]string{"cause": err.Error()}` while
  retaining the existing status, code, and message.

- [ ] **Step 2: Parse and format an optional cause in the API client.**

  Add optional `details` to `ApiErrorBody`, pass it into `ApiError`, and
  append a string `cause` detail to the v1 error message. Leave messages
  unchanged when `details` is absent or malformed.

- [ ] **Step 3: Preserve the formatted project-agent error.**

  In `startAgentInProject`, return after `createSession` fails without
  replacing the alert with a fixed generic message. Keep the fallback only
  for a null result that did not already set an error.

- [ ] **Step 4: Run the focused tests and confirm GREEN.**

  Re-run the commands from Task 2 and confirm all focused tests pass.

### Task 4: Verify the full change

**Files:**
- No additional files.

- [ ] **Step 1: Format changed Go files.**

  Run `gofmt -w internal/server/v1_terminal.go internal/server/projects_test.go`.

- [ ] **Step 2: Run repository tests and builds.**

  Run `go test ./...`, `GOOS=windows GOARCH=amd64 go test ./internal/server ./internal/session`, `cd web && npm test -- --run`, and `npm run build`.

- [ ] **Step 3: Inspect the diff and commit the implementation.**

  Confirm only the API, client, UI, and regression-test files changed, then
  run `git add` and `git commit -m "fix: show project terminal startup errors"`.
