# Windows Folder Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing project folder picker work on Windows instead of returning the unavailable-picker error.

**Architecture:** Keep the existing server-side picker abstraction and endpoint unchanged. Extend the command-selection boundary with a testable operating-system argument and launch a constant Windows PowerShell script that opens `System.Windows.Forms.FolderBrowserDialog` in STA mode. Prefer `powershell.exe`, then fall back to `pwsh.exe`; preserve the existing exit-code-1 cancellation behavior and path validation.

**Tech Stack:** Go 1.24, `os/exec`, Windows PowerShell/PowerShell Core, Go tests, Windows AMD64 cross-build.

## Global Constraints

- The existing `POST /api/projects/pick-directory` response contract must remain unchanged.
- Windows folder selection must use only executables normally available on Windows; no new Go dependency is required.
- The picker must select an existing directory and must not create a project automatically.
- Tests and code are written in English; user communication is in Japanese.
- Work is isolated under `tmp/worktrees/` and merged back to `main` after verification.

---

### Task 1: Add a failing Windows command-selection test

**Files:**
- Modify: `internal/server/project_picker_test.go` (create if absent)

**Interfaces:**
- Consumes: the planned `directoryPickerCommandFor(goos string, lookPath func(string) (string, error))` helper boundary.
- Produces: a regression test proving Windows chooses PowerShell and passes a folder-dialog script with UTF-8 output, STA mode, and cancellation exit code.

- [ ] **Step 1: Write the failing test**

Add a test with a fake `lookPath` that resolves `powershell.exe` to `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` and fails every other lookup. Assert that the returned command is that resolved path, that `-NoProfile`, `-NonInteractive`, and `-STA` are present, and that the command script contains `System.Windows.Forms.FolderBrowserDialog`, `Choose project directory`, UTF-8 output encoding, and `exit 1` for cancellation.

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/server -run TestDirectoryPickerCommandForWindows -count=1`

Expected: FAIL because `directoryPickerCommandFor` does not exist yet.

### Task 2: Implement the Windows picker command

**Files:**
- Modify: `internal/server/project_picker.go`
- Modify: `internal/server/project_picker_test.go`

**Interfaces:**
- Consumes: `runtime.GOOS` and `exec.LookPath` from the existing picker entry point.
- Produces: `directoryPickerCommandFor`, which returns a PowerShell command and arguments for Windows, keeps the existing macOS/Linux behavior, and returns `errDirectoryPickerUnavailable` when no supported picker executable exists.

- [ ] **Step 1: Implement the minimal command-selection boundary**

Change `directoryPickerCommand()` to call `directoryPickerCommandFor(runtime.GOOS, exec.LookPath)`. Move the current switch into `directoryPickerCommandFor` and add a Windows branch that tries `powershell.exe` then `pwsh.exe`.

Use these Windows arguments:

```go
[]string{
    "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", windowsFolderPickerScript,
}
```

Define the constant script so it sets `[Console]::OutputEncoding` to UTF-8, loads `System.Windows.Forms`, opens a `FolderBrowserDialog` titled `Choose project directory`, writes the selected path to stdout, and exits with status 1 when the dialog is canceled.

- [ ] **Step 2: Add fallback and unavailable-picker tests**

Test that a missing `powershell.exe` falls back to a resolved `pwsh.exe`, and that both missing commands return an error matching `errDirectoryPickerUnavailable`.

- [ ] **Step 3: Run the focused tests to verify they pass**

Run: `go test ./internal/server -run 'TestDirectoryPickerCommandFor|TestProjectDirectoryPickerEndpoint' -count=1`

Expected: PASS.

### Task 3: Verify the regression fix across the supported build paths

**Files:**
- No additional source files.

**Interfaces:**
- Consumes: the Windows picker implementation and existing project-picker endpoint.
- Produces: fresh test and build evidence for native tests and the Windows AMD64 artifact.

- [ ] **Step 1: Run the complete Go test suite**

Run: `go test ./...`

Expected: PASS. If an unrelated pre-existing flaky test recurs, rerun that package in isolation and record the actual result before continuing.

- [ ] **Step 2: Cross-compile the Windows executable**

Run: `GOOS=windows GOARCH=amd64 go build -trimpath -o /private/tmp/euphony-windows-amd64.exe ./cmd/euphony`

Expected: exit code 0 and a Windows executable is produced.

- [ ] **Step 3: Inspect the final diff and commit**

Run: `git diff --check`, `git diff --stat`, and `git status --short`.

Commit with: `git add internal/server/project_picker.go internal/server/project_picker_test.go docs/superpowers/plans/2026-08-15-windows-folder-picker.md && git commit -m "fix: support Windows project folder picker"`

- [ ] **Step 4: Merge the verified branch into `main`**

From the repository root, run `git merge --no-ff codex/fix-windows-folder-picker` after confirming the worktree commit and base branch state. Preserve unrelated dirty files already present on `main`.
