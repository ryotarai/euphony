# Windows Folder Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing project folder picker work on Windows instead of returning the unavailable-picker error.

**Architecture:** Keep the existing server-side picker abstraction and endpoint unchanged. Route Windows through a build-tagged Go implementation that initializes COM on a locked STA thread and calls the native `SHBrowseForFolderW`/`SHGetPathFromIDListW` APIs directly. Keep the existing command-based picker for macOS and Linux, and preserve cancellation and path validation at the shared boundary.

**Tech Stack:** Go 1.24, `os/exec`, `golang.org/x/sys/windows`, Win32 Shell32/Ole32 APIs, Go tests, Windows AMD64 cross-build.

## Global Constraints

- The existing `POST /api/projects/pick-directory` response contract must remain unchanged.
- Windows folder selection must use native Win32 APIs; no child process or PowerShell dependency is allowed.
- The picker must select an existing directory and must not create a project automatically.
- Tests and code are written in English; user communication is in Japanese.
- Work is isolated under `tmp/worktrees/` and merged back to `main` after verification.

---

### Task 1: Add a failing Windows native-routing test

**Files:**
- Modify: `internal/server/project_picker_test.go` (create if absent)

**Interfaces:**
- Consumes: the planned `pickDirectoryForOS(goos string, ctx context.Context, nativeWindows func(context.Context) (string, error))` helper boundary.
- Produces: a regression test proving Windows invokes the native picker and preserves native cancellation.

- [ ] **Step 1: Write the failing test**

Add a test with a fake native picker that returns a temporary directory and count its invocation through `pickDirectoryForOS("windows", context.Background(), nativePicker)`. Add a second test where the native picker returns `errDirectoryPickerCanceled` and assert that the sentinel error is preserved.

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/server -run TestPickDirectoryForWindows -count=1`

Expected: FAIL because `pickDirectoryForOS` does not exist yet.

### Task 2: Implement the native Windows picker

**Files:**
- Modify: `internal/server/project_picker.go`
- Modify: `internal/server/project_picker_test.go`
- Create: `internal/server/project_picker_windows.go`
- Create: `internal/server/project_picker_nonwindows.go`

**Interfaces:**
- Consumes: `runtime.GOOS`, the existing command-based picker, and `golang.org/x/sys/windows`.
- Produces: `pickDirectoryNativeWindows`, which opens the system folder dialog directly and returns a filesystem path or `errDirectoryPickerCanceled`.

- [ ] **Step 1: Implement the shared platform boundary**

Change `pickDirectory` to route `runtime.GOOS == "windows"` to `pickDirectoryNativeWindows`, while macOS and Linux continue through `pickDirectoryWithCommand`. Centralize `filepath.Abs`, `os.Stat`, empty-path, and cancellation handling in `normalizePickedDirectory`.

- [ ] **Step 2: Implement the Windows build-tagged picker**

Lock the goroutine to its OS thread, initialize COM with `COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE`, and call `SHBrowseForFolderW` with `BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE | BIF_NONEWFOLDERBUTTON`. Free the returned PIDL with `CoTaskMemFree`, resolve it with `SHGetPathFromIDListW`, and uninitialize COM before returning. Add a non-Windows stub so the common package remains buildable on macOS and Linux.

- [ ] **Step 3: Run the focused tests to verify they pass**

Run: `go test ./internal/server -run 'TestPickDirectoryForWindows|TestProjectDirectoryPickerEndpoint' -count=1`

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

Run: `GOOS=windows GOARCH=amd64 go build -trimpath -o /private/tmp/euphony-windows-picker-native.exe ./cmd/euphony`

Expected: exit code 0 and a Windows executable is produced.

- [ ] **Step 3: Inspect the final diff and commit**

Run: `git diff --check`, `git diff --stat`, and `git status --short`.

Commit with: `git add internal/server/project_picker.go internal/server/project_picker_test.go internal/server/project_picker_windows.go internal/server/project_picker_nonwindows.go docs/superpowers/plans/2026-08-15-windows-folder-picker.md && git commit -m "fix: use native Windows project folder picker"`

- [ ] **Step 4: Merge the verified branch into `main`**

From the repository root, run `git merge --no-ff codex/fix-windows-folder-picker` after confirming the worktree commit and base branch state. Preserve unrelated dirty files already present on `main`.
