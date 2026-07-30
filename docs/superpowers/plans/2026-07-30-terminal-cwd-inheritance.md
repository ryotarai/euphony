# Terminal CWD Inheritance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start each new terminal in the focused terminal's working directory, or in the user's home directory when no working directory can be inherited.

**Architecture:** Keep focused-session lookup in `App`, which already owns session and focus state, and pass the derived `cwd` through the existing optional API field. Change `Manager.Create` so an omitted `cwd` resolves with `os.UserHomeDir()` instead of `os.Getwd()`, while preserving validation for explicitly supplied paths.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Go 1.24, `creack/pty`

## Global Constraints

- Do not add a new API field or visual control.
- Preserve the explicit directory dialog and invalid-directory validation.
- Use the focused terminal, not another selected pane, as the inheritance source.
- Use the home directory only when creation has no inherited or explicit `cwd`.

---

### Task 1: Inherit the Focused Terminal CWD in Frontend Creation Paths

**Files:**
- Modify: `web/src/App.tsx`
- Test: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: `sessions: Session[] | null`, `focusedID: string | null`, and `ApiClient.createSession(name: string, cwd?: string)`
- Produces: `createSession(split?: boolean, cwd?: string)` calls the API with the explicit `cwd`, or otherwise the focused session's `cwd`

- [x] **Step 1: Update the sidebar creation regression test**

Rename the existing creation test to `creates a terminal in the focused terminal cwd, selects it, and deletes it`, then require the POST body to contain the literal focused directory:

```tsx
expect(fetchMock).toHaveBeenNthCalledWith(
  2,
  "/api/sessions",
  expect.objectContaining({
    method: "POST",
    body: JSON.stringify({
      name: "Terminal",
      cwd: "/workspace/euphony",
    }),
  }),
);
```

- [x] **Step 2: Cover dynamic focus inheritance for prefix create and split**

Extend `tmux create and vertical split keys create the expected selection` so
the `c` request inherits `runningSession.cwd` and the following `v` request
inherits `createdByC.cwd`:

```tsx
expect(fetchMock).toHaveBeenNthCalledWith(
  2,
  "/api/sessions",
  expect.objectContaining({
    body: JSON.stringify({
      name: "Terminal",
      cwd: "/workspace/euphony",
    }),
  }),
);
expect(fetchMock).toHaveBeenNthCalledWith(
  3,
  "/api/sessions",
  expect.objectContaining({
    body: JSON.stringify({
      name: "Terminal",
      cwd: "/workspace/shell",
    }),
  }),
);
```

- [x] **Step 3: Run the focused tests to verify RED**

Run:

```bash
cd web
npm test -- --run src/App.test.tsx
```

Expected: FAIL because the current creation requests contain only
`{"name":"Terminal"}`.

- [x] **Step 4: Implement focused CWD lookup at the creation boundary**

In `createSession`, preserve an explicitly passed value, otherwise resolve the
focused session:

```tsx
const focusedCWD = sessions?.find((session) => session.id === focusedID)?.cwd;
const created = await api.createSession("Terminal", cwd ?? focusedCWD);
```

- [x] **Step 5: Run the focused tests to verify GREEN**

Run:

```bash
cd web
npm test -- --run src/App.test.tsx
```

Expected: 1 test file passes with all App tests green.

### Task 2: Default Omitted CWD to the User Home Directory

**Files:**
- Modify: `internal/session/manager.go`
- Test: `internal/session/manager_test.go`

**Interfaces:**
- Consumes: `Manager.Create(ctx context.Context, name string, requestedCWD ...string)` and `os.UserHomeDir()`
- Produces: creation without `requestedCWD` starts the PTY in the user's home directory

- [x] **Step 1: Write the backend fallback regression test**

Add a test that separates the process directory from the configured home:

```go
func TestCreateWithoutWorkingDirectoryUsesHomeDirectory(t *testing.T) {
	home := t.TempDir()
	processCWD := t.TempDir()
	t.Setenv("HOME", home)
	t.Chdir(processCWD)

	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	metadata, err := manager.Create(context.Background(), "Terminal")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if metadata.CWD != home {
		t.Fatalf("CWD = %q, want home %q", metadata.CWD, home)
	}

	running, _ := manager.Get(metadata.ID)
	_, output, unsubscribe := running.Subscribe()
	defer unsubscribe()
	if _, err := running.Write([]byte("pwd\n")); err != nil {
		t.Fatalf("Write(pwd) error = %v", err)
	}
	got := receiveUntil(t, output, home, 3*time.Second)
	if !strings.Contains(got, home) {
		t.Fatalf("pwd output = %q, want home %q", got, home)
	}
}
```

- [x] **Step 2: Run the backend test to verify RED**

Run:

```bash
go test ./internal/session -run TestCreateWithoutWorkingDirectoryUsesHomeDirectory -count=1
```

Expected: FAIL with `CWD` equal to `processCWD`, proving the old
`os.Getwd()` behavior.

- [x] **Step 3: Implement the home-directory default**

Replace the omitted-CWD branch in `Manager.Create`:

```go
if cwd == "" {
	var err error
	cwd, err = os.UserHomeDir()
	if err != nil {
		return Metadata{}, fmt.Errorf("resolve home directory: %w", err)
	}
}
```

- [x] **Step 4: Run the backend test to verify GREEN**

Run:

```bash
go test ./internal/session -run TestCreateWithoutWorkingDirectoryUsesHomeDirectory -count=1
```

Expected: PASS.

- [x] **Step 5: Keep the hook-environment test focused on explicit CWD**

Update `TestCreateRecordsCWDAndExposesTerminalHookEnvironment` to pass a
`t.TempDir()` into `Manager.Create`. The home default has its own regression
test; this existing test should continue to cover explicit CWD metadata and
hook environment propagation without depending on an implicit default.

- [x] **Step 6: Run complete verification**

Run:

```bash
go test ./...
cd web
npm test -- --run
npm run typecheck
npm run build
```

Expected: every command exits 0 with no test failures or type errors.

- [x] **Step 7: Review and commit the implementation**

Run:

```bash
git diff --check
git diff -- web/src/App.tsx web/src/App.test.tsx internal/session/manager.go internal/session/manager_test.go
git add web/src/App.tsx web/src/App.test.tsx internal/session/manager.go internal/session/manager_test.go docs/superpowers/plans/2026-07-30-terminal-cwd-inheritance.md
git commit -m "feat: inherit cwd for new terminals"
```
