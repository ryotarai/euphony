# Resume Agents in Bash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore persisted Claude Code and Codex sessions through a Bash login shell without changing ordinary terminal restoration.

**Architecture:** Keep the existing `restoredCommand` boundary. For recognized agents, construct `/bin/bash -lc 'exec "$0" "$@"'` with the executable and resume arguments passed as Bash positional parameters; retain `exec.Command(shell)` for all other sessions.

**Tech Stack:** Go 1.24, `os/exec`, Go standard-library tests.

## Global Constraints

- Use `/bin/bash` for Claude and Codex restoration.
- Use a Bash login shell (`-l`) so CLI installation paths from login initialization are available.
- Pass the session ID as an argument, never by concatenating it into shell source.
- Preserve `exec`-based PTY lifecycle and the configured-shell fallback.
- Write the regression test before production code and verify the red-green cycle.

---

### Task 1: Restore Claude and Codex through Bash

**Files:**
- Modify: `internal/session/manager_test.go:1851-1869`
- Modify: `internal/session/manager.go:490-504`

**Interfaces:**
- Consumes: `restoredCommand(shell string, metadata Metadata) *exec.Cmd` and the existing `Metadata.Agent`, `Metadata.ResumeAgent`, and `Metadata.AgentSessionID` fields.
- Produces: `exec.Cmd` values with args shaped as `[/bin/bash, -lc, exec "$0" "$@", agent, resume-args..., sessionID]` for known agents, and the configured shell command for other metadata.

- [ ] **Step 1: Update the unit test with the required Bash command shape.**

Replace the known-agent expectations in `TestRestoredCommandResumesKnownAgents` with:

```go
want := []string{"/bin/bash", "-lc", `exec "$0" "$@"`, "codex", "resume", "codex-session"}
```

and the equivalent Claude expectation:

```go
want := []string{"/bin/bash", "-lc", `exec "$0" "$@"`, "claude", "--resume", "claude-session"}
```

Keep the no-agent expectation as `[]string{"/bin/sh"}`.

- [ ] **Step 2: Run the focused test and verify it fails for the missing Bash wrapper.**

Run:

```bash
go test ./internal/session -run '^TestRestoredCommandResumesKnownAgents$' -count=1
```

Expected: FAIL because the current implementation returns `codex` and `claude` as the command executable instead of `/bin/bash`.

- [ ] **Step 3: Implement the minimal Bash command construction.**

In `restoredCommand`, replace each recognized-agent direct command with:

```go
return exec.Command("/bin/bash", "-lc", `exec "$0" "$@"`, "codex", "resume", metadata.AgentSessionID)
```

and the matching Claude form:

```go
return exec.Command("/bin/bash", "-lc", `exec "$0" "$@"`, "claude", "--resume", metadata.AgentSessionID)
```

Do not change agent selection, session-ID checks, or the configured-shell fallback.

- [ ] **Step 4: Run focused and full Go tests.**

Run:

```bash
go test ./internal/session -run '^TestRestoredCommandResumesKnownAgents$' -count=1
go test ./...
```

Expected: both commands exit successfully with zero failed tests.

- [ ] **Step 5: Review and commit the implementation.**

Run:

```bash
gofmt -w internal/session/manager.go internal/session/manager_test.go
git diff --check
git status --short
```

Then commit only the implementation and test changes:

```bash
git add internal/session/manager.go internal/session/manager_test.go
git commit -m "fix: resume agents through bash"
```
