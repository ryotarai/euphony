# Agent Log Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open long agent logs from a bounded newest page, summarize tool activity, and load older entries on demand from the top of the log.

**Architecture:** Add byte-range pagination to the normalized transcript endpoint, with backward pages for history and forward ranges for polling. Compact tool calls server-side, then let the React view prepend older pages while preserving its viewport and append only newly written records at the live edge.

**Tech Stack:** Go `net/http`, `os.File.ReadAt`, JSONL parsing, React 19, TypeScript, shadcn MessageScroller, Vitest, Playwright.

## Global Constraints

- Work only in `tmp/worktrees/agent-log-pagination` until the verified branch is merged.
- The newest request reads at most 100 JSONL records rather than the complete transcript.
- Never return tool arguments or tool result content from the paginated endpoint.
- Keep transcript path confinement unchanged and never accept a browser-supplied path.
- Keep initial scroll at the live edge and preserve the visible reading position when prepending history.
- Poll only while the Agent Log tab is active.
- Run end-to-end state mutations with one worker and an isolated database.

---

### Task 1: Add bounded transcript pages

**Files:**
- Create: `internal/agentlog/page.go`
- Create: `internal/agentlog/page_test.go`
- Modify: `internal/agentlog/parser.go`
- Modify: `internal/agentlog/parser_test.go`
- Modify: `internal/agentlog/types.go`

**Interfaces:**
- Produces: `ParseAt(agent string, reader io.Reader, startOffset int64) ([]Entry, error)`.
- Produces: `ReadPage(agent string, file *os.File, before int64, recordLimit int) (Page, error)`.
- Produces: `ReadAfter(agent string, file *os.File, after int64) (Page, error)`.
- Produces: `CompactTools(entries []Entry) []Entry`.

- [ ] **Step 1: Write failing range and compaction tests**

Create a temporary JSONL transcript with 105 messages and a run containing
three tool calls and three results. Assert that `ReadPage(..., size, 100)`
starts at message 6, returns a non-empty older cursor, uses absolute byte
offset IDs, and contains `Entry{Kind: "tool_group", ToolCalls: 3}` without
tool content. Assert a second page ending at the cursor returns messages 1–5,
and `ReadAfter` returns only bytes appended after its cursor.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
go test ./internal/agentlog
```

Expected: FAIL because `Page`, `ReadPage`, `ReadAfter`, `ParseAt`, and
`CompactTools` do not exist.

- [ ] **Step 3: Implement absolute-offset parsing and bounded reads**

Keep `Parse` compatible with its line-number IDs. Add a shared parser loop
whose paginated ID factory formats `<absolute-byte-offset>-<block-index>`.
Scan backward in fixed chunks to find the Nth prior newline, read only
`[start,before)`, and parse that range. `ReadAfter` reads `[after,size)`.

- [ ] **Step 4: Implement tool compaction**

Replace each consecutive tool/result run with:

```go
Entry{
    ID: firstToolID,
    Kind: "tool_group",
    ToolCalls: callCount,
    Timestamp: firstToolTimestamp,
}
```

Do not emit a group when a range contains results but no calls.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```bash
go test ./internal/agentlog
```

Expected: PASS.

### Task 2: Expose cursor pagination through the endpoint

**Files:**
- Modify: `internal/server/agent_log.go`
- Modify: `internal/server/agent_log_test.go`
- Modify: `internal/server/openapi.json`

**Interfaces:**
- Consumes: optional `before` or `after` decimal byte cursor.
- Produces: transcript fields `startCursor`, `endCursor`, and optional
  `nextCursor`.

- [ ] **Step 1: Write failing endpoint tests**

Write a linked transcript with 105 message records. Assert the default GET
returns messages 6–105 and `nextCursor`; GET with that `before` cursor returns
messages 1–5; append message 106 and assert GET with the prior `after` cursor
returns only message 106. Assert malformed and simultaneous cursors return
`400 invalid_agent_log_cursor`.

- [ ] **Step 2: Run the server test and verify RED**

Run:

```bash
go test ./internal/server -run AgentLog
```

Expected: FAIL because the endpoint still returns the full transcript and
does not validate cursors.

- [ ] **Step 3: Route requests through the page reader**

Parse cursor query values with `strconv.ParseInt`, select default/before/after
mode, call the bounded reader, attach session identity, and retain existing
ETag handling. Update the OpenAPI schema with `tool_group`, `toolCalls`, and
cursor fields.

- [ ] **Step 4: Run focused server tests and verify GREEN**

Run:

```bash
go test ./internal/server -run AgentLog
```

Expected: PASS.

### Task 3: Load and merge pages in the Agent Log view

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Modify: `web/src/api.test.ts`
- Modify: `web/src/components/AgentLogView.tsx`
- Modify: `web/src/components/AgentLogView.test.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Produces: `AgentLogRequest { etag?: string; before?: string; after?: string }`.
- Produces: `ApiClient.getAgentLog(id, request?)`.
- Consumes: `tool_group`, `toolCalls`, `startCursor`, `endCursor`, and
  `nextCursor`.

- [ ] **Step 1: Write failing API and component tests**

Assert cursor options create `?before=...` and `?after=...` URLs. Render a
newest page with a `tool_group` and assert `3 tool calls` is a non-expandable
row. Click `Load more`, assert the older page is prepended and the API receives
its cursor, and assert an appended polling page is merged using `after`.

- [ ] **Step 2: Run the web tests and verify RED**

Run:

```bash
cd web
npm test -- --run src/api.test.ts src/components/AgentLogView.test.tsx
```

Expected: FAIL because request options, cursors, compact rows, and `Load more`
do not exist.

- [ ] **Step 3: Implement typed cursor requests and page merging**

Build the URL with `URLSearchParams`. Keep the oldest `nextCursor` and newest
`endCursor` in refs/state. Prepend older entries, append polling entries, and
merge adjacent `tool_group` entries by summing `toolCalls`. Replace the
transcript when session identity or an `after` range no longer matches.

- [ ] **Step 4: Preserve the viewport during prepend**

Before requesting history, record the MessageScroller viewport's
`scrollHeight` and `scrollTop`. After React commits the prepended entries, set
`scrollTop` to `oldScrollTop + newScrollHeight - oldScrollHeight`.

- [ ] **Step 5: Style the compact rows and top control**

Use the existing monospace metadata scale, hairline separators, and dark
palette. Keep `Load more` keyboard visible, full-width, and 36px high. Render
tool groups as plain rows without `<details>`.

- [ ] **Step 6: Run focused and full web checks**

Run:

```bash
cd web
npm test -- --run src/api.test.ts src/components/AgentLogView.test.tsx
npm run typecheck
```

Expected: PASS.

### Task 4: Verify the user flow end to end

**Files:**
- Modify: `web/e2e/euphony.spec.ts`

**Interfaces:**
- Consumes: the real HTTP endpoint and MessageScroller behavior.

- [ ] **Step 1: Extend the Playwright transcript fixture**

Create at least 105 records plus three tool calls/results. Open Agent Log and
assert the newest page is visible, the oldest record is absent, `3 tool calls`
is visible, and no tool payload/result text appears.

- [ ] **Step 2: Exercise top loading**

Scroll to the top, click `Load more`, assert the oldest record appears, and
assert the viewport stays on the same previously visible message rather than
jumping to the inserted history.

- [ ] **Step 3: Verify live append still follows**

Return to the end, append one message, and assert it appears and remains at
the live edge.

- [ ] **Step 4: Run full verification**

Run:

```bash
go test ./...
cd web
npm test -- --run
npm run typecheck
npm run build
npx playwright test --workers=1
```

Expected: every command exits 0.

### Task 5: Commit and integrate

**Files:**
- Review all changed files.

- [ ] **Step 1: Inspect scope**

Run:

```bash
git status --short
git diff --check
git diff --stat
```

Expected: only the agent-log pagination implementation, tests, and its design
documents are changed.

- [ ] **Step 2: Commit**

Run:

```bash
git add docs internal web
git commit -m "perf: paginate agent logs"
```

- [ ] **Step 3: Merge to the base branch**

From `/Users/ryotarai/work/euphony`, merge `codex/agent-log-pagination`
without staging or discarding the existing unrelated local changes:

```bash
git merge --no-ff codex/agent-log-pagination
```

- [ ] **Step 4: Verify the merged state**

Run the full verification commands from the base checkout and report the merge
commit.
