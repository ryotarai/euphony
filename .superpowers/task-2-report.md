# Task 2 Report: Isolate Terminal Input from Metadata Refresh

## Status

Implemented the Task 2 brief in the isolated `codex/agent-backend-perf`
worktree. The production changes:

- release the per-session `fileMu` before invoking the external foreground
  process command runner;
- resolve Codex transcript titles outside the manager mutex and apply results
  only when terminal, agent session, and transcript identities still match;
- return the current session snapshot immediately from `GET /api/sessions`
  and trigger a non-blocking, `TryLock`-guarded single-flight refresh;
- make the PTY master descriptor non-blocking and treat `EAGAIN` /
  `EWOULDBLOCK` as the end of the current drain batch.

## TDD Evidence

### Foreground process lookup

The test gates an injected foreground command runner after the PTY foreground
group has been captured, then writes to the PTY while the runner remains
blocked.

RED:

```text
--- FAIL: TestForegroundCommandDoesNotBlockTerminalWrite (0.38s)
    manager_test.go:1122: terminal write blocked while foreground command runner was active
```

GREEN:

```text
ok github.com/ryotarai/euphony/internal/session 0.493s
```

### Codex title resolution

Two gated resolver tests verify that metadata reads remain available during
resolution and that a result for an old session/transcript identity is
discarded.

RED:

```text
--- FAIL: TestRefreshCodexTitlesDoesNotBlockMetadata (0.25s)
    manager_test.go:784: Metadata() blocked while Codex title resolution was active
--- FAIL: TestRefreshCodexTitlesDiscardsStaleResolution (0.25s)
    manager_test.go:834: Metadata() blocked while stale title resolution was active
```

GREEN, including the existing synchronous title-refresh tests:

```text
ok github.com/ryotarai/euphony/internal/session 0.410s
```

### Immediate session list and single-flight refresh

The server test gates the real foreground process refresh through a fake `ps`,
requires two overlapping HTTP requests to return their in-memory snapshots,
and verifies only one refresh process entered the gate.

RED:

```text
--- FAIL: TestListSessionsDoesNotWaitForMetadataRefresh (0.29s)
    sessions_test.go:105: GET /api/sessions waited for metadata refresh
```

GREEN:

```text
ok github.com/ryotarai/euphony/internal/server 0.588s
```

### Non-blocking PTY drain

The tests verify the real PTY descriptor mode, output-to-resize progress, and
the explicit would-block drain result.

RED:

```text
--- FAIL: TestPTYDrainDoesNotBlockResizeAfterReadableData (0.02s)
    manager_test.go:1500: PTY descriptor is blocking; drain can stall after readiness changes
--- FAIL: TestDrainTerminalOutputTreatsWouldBlockAsDrained (0.00s)
    manager_test.go:1534: drainTerminalOutput() = closed false, error resource temporarily unavailable; want drained and open
```

GREEN:

```text
ok github.com/ryotarai/euphony/internal/session 0.389s
```

## Verification

Focused Task 2 tests:

```text
ok github.com/ryotarai/euphony/internal/session 0.805s
ok github.com/ryotarai/euphony/internal/server 0.792s
```

Full target packages:

```text
ok github.com/ryotarai/euphony/internal/session 2.166s
ok github.com/ryotarai/euphony/internal/server 4.480s
```

Focused race tests:

```text
ok github.com/ryotarai/euphony/internal/session 1.427s
ok github.com/ryotarai/euphony/internal/server 1.742s
```

The full race command passed `internal/session`, but the server package hit one
known CWD WebSocket baseline failure:

```text
--- FAIL: TestTerminalWebSocketIgnoresTitlesThatAreNotDirectories
got cwd "/Users/ryotarai", want the test temporary directory
```

`go test ./... -count=1` likewise passed every package except
`internal/server`, where the same known CWD WebSocket test failed. A
non-race full `internal/session ./internal/server` run passed both packages
once; the final pre-commit rerun passed `internal/session` and hit the other
known CWD baseline case,
`TestTerminalWebSocketUpdatesCurrentWorkingDirectory`, in `internal/server`.
Earlier sandboxed runs also showed `ps: operation not permitted`; verification
was therefore rerun with the approved unsandboxed `go test` command.

## Self-review and Concerns

- `Manager.List()` still performs a synchronous refresh when it can acquire
  the refresh slot, preserving existing non-HTTP callers. If another refresh
  is active, it returns the current snapshot instead of waiting.
- `RefreshMetadata()` owns the mutex before starting its goroutine, so polling
  cannot enqueue duplicate refresh goroutines.
- Codex resolution snapshots identity under `RLock`, performs all transcript
  reads without the manager lock, and revalidates identity under `Lock` before
  mutating metadata.
- SQLite persistence for an actual title change remains under the manager lock.
  This is rare compared with every-poll transcript scanning, but it remains a
  bounded input-path contention point if storage stalls.
- An asynchronous refresh is best-effort and is not joined by `Manager.Close`.
  It only snapshots live sessions and ignored persistence errors were already
  the existing title-refresh behavior, but explicit lifecycle joining could be
  considered separately if shutdown ordering becomes observable.
- Making the shared PTY master descriptor non-blocking also changes its write
  mode. Go's `os.File` integrates non-blocking descriptors with the runtime
  poller, and the full session tests passed, but sustained input backpressure
  deserves a future stress benchmark.
- `git diff --check` passed. No unrelated files were changed.
