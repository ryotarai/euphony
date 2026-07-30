# Agent Log Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pane-local terminal/agent-log tab switcher that renders linked Claude Code and Codex JSONL transcripts as a live, readable HTML log.

**Architecture:** Capture each hook's trusted transcript path, persist it with the terminal, and expose a bearer-authenticated read-only endpoint that normalizes provider-specific JSONL into one transport shape. Compose the existing xterm view with an agent-log view that polls with ETags and delegates bottom-follow behavior to shadcn MessageScroller.

**Tech Stack:** Go `net/http`, `bufio`, `encoding/json`, SQLite, React 19, TypeScript, shadcn Base UI Tabs and MessageScroller, react-markdown, Vitest, Playwright.

## Global Constraints

- Work only in `tmp/worktrees/agent-log-tabs` until the verified branch is merged.
- Read transcripts only from configured Claude/Codex roots and never accept a browser-supplied path.
- Keep the xterm component mounted across tab switches.
- Poll only while the agent-log tab is visible.
- Start at the latest entry, follow only at the live edge, and never pull a reader who scrolled away.
- Raw transcript HTML must never be executed.
- Unknown or malformed provider records must not break later valid records.
- End-to-end tests use an isolated database and one worker for shared-state mutations.

---

### Task 1: Persist trusted transcript paths

**Files:**
- Modify: `internal/agenthook/report.go`
- Modify: `internal/agenthook/report_test.go`
- Modify: `internal/session/manager.go`
- Modify: `internal/session/manager_test.go`
- Modify: `internal/session/sqlite_store.go`
- Modify: `internal/session/sqlite_store_test.go`
- Modify: `internal/server/hooks.go`
- Modify: `internal/server/sessions_test.go`

**Interfaces:**
- Consumes: provider hook JSON with `transcript_path`.
- Produces: `Metadata.AgentTranscriptPath string` and `AgentUpdate.TranscriptPath string`, both hidden from session-list JSON.

- [ ] **Step 1: Write failing hook, manager, and store tests**

```go
input := `{"session_id":"agent-1","transcript_path":"/home/me/.claude/projects/p/agent-1.jsonl"}`
// Assert the hook POST contains agentTranscriptPath.
// Assert UpdateAgent persists the value.
// Assert SQLite close/reopen preserves the value.
```

- [ ] **Step 2: Run the focused tests and verify missing-field failures**

Run:

```bash
go test ./internal/agenthook ./internal/session ./internal/server
```

Expected: failures show that the transcript path is not forwarded or stored.

- [ ] **Step 3: Add the fields and SQLite migration**

Add `agent_transcript_path TEXT NOT NULL DEFAULT ''`, include it in load/save
queries, and forward `transcript_path` as `agentTranscriptPath` through the
hook endpoint.

- [ ] **Step 4: Re-run focused tests**

Run:

```bash
go test ./internal/agenthook ./internal/session ./internal/server
```

Expected: PASS.

### Task 2: Normalize Claude and Codex JSONL

**Files:**
- Create: `internal/agentlog/types.go`
- Create: `internal/agentlog/parser.go`
- Create: `internal/agentlog/parser_test.go`

**Interfaces:**
- Produces: `Parse(agent string, reader io.Reader) ([]Entry, error)`.
- `Entry.Kind` is one of `message`, `thinking`, `tool`, `tool_result`.

- [ ] **Step 1: Write table-driven failing parser tests**

Use literal JSONL fixtures covering:

```go
{"type":"assistant","timestamp":"2026-07-30T01:02:03Z","message":{"role":"assistant","content":[{"type":"text","text":"Done"},{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"go test ./..."}}]}}
{"type":"response_item","timestamp":"2026-07-30T01:02:04Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done"}]}}
```

Assert provider records produce hand-written expected entries, malformed lines
are skipped, and oversized tool output ends with a truncation marker.

- [ ] **Step 2: Run and verify the package does not exist**

Run:

```bash
go test ./internal/agentlog
```

Expected: FAIL because `Parse` and `Entry` do not exist.

- [ ] **Step 3: Implement tolerant provider parsers**

Decode each JSONL line into `json.RawMessage`, dispatch on agent and record
type, flatten only known text/tool blocks, generate stable IDs from source line
and block index, and cap individual tool content at 48 KiB.

- [ ] **Step 4: Re-run parser tests**

Run:

```bash
go test ./internal/agentlog
```

Expected: PASS.

### Task 3: Resolve only linked transcript files

**Files:**
- Create: `internal/agentlog/resolver.go`
- Create: `internal/agentlog/resolver_test.go`
- Modify: `internal/session/manager.go`

**Interfaces:**
- Produces: `Resolver.Resolve(agent, sessionID, recordedPath string) (string, error)`.
- Produces: `Manager.Metadata(id string) (Metadata, bool)`.

- [ ] **Step 1: Write failing confinement and fallback tests**

Create temporary Claude and Codex roots. Assert:

- a recorded path inside the matching root resolves;
- a path outside the root is rejected;
- Claude fallback finds only `<session-id>.jsonl`;
- Codex fallback finds only a rollout basename ending in `<session-id>.jsonl`;
- traversal-like and empty session IDs are rejected.

- [ ] **Step 2: Run and verify failures**

Run:

```bash
go test ./internal/agentlog ./internal/session
```

Expected: FAIL because `Resolver` and `Manager.Metadata` do not exist.

- [ ] **Step 3: Implement resolution and metadata lookup**

Resolve symlinks for roots and candidates before containment checks. Cache a
successful `(agent, sessionID)` fallback path, but stat the file on every
request.

- [ ] **Step 4: Re-run focused tests**

Run:

```bash
go test ./internal/agentlog ./internal/session
```

Expected: PASS.

### Task 4: Expose the authenticated ETag endpoint

**Files:**
- Create: `internal/server/agent_log.go`
- Create: `internal/server/agent_log_test.go`
- Modify: `internal/server/server.go`
- Modify: `cmd/euphony/main.go`
- Modify: `cmd/euphony/main_test.go`

**Interfaces:**
- Produces: `GET /api/sessions/{id}/agent-log`.
- Response: `{agent, sessionId, entries}` with `ETag`.

- [ ] **Step 1: Write failing handler tests**

Create a server with temporary transcript roots, create a terminal, update it
with a linked fixture transcript, then assert:

```text
unknown terminal -> 404 session_not_found
terminal without linked agent -> 404 agent_log_not_found
linked transcript -> 200 + normalized JSON + ETag
matching If-None-Match -> 304 with no body
modified transcript -> 200 with a different ETag and appended entry
```

- [ ] **Step 2: Run and verify route failures**

Run:

```bash
go test ./internal/server ./cmd/euphony
```

Expected: FAIL because the endpoint is not registered.

- [ ] **Step 3: Implement endpoint and root configuration**

Derive default roots as `$CODEX_HOME/sessions` and
`$CLAUDE_CONFIG_DIR/projects`, falling back to `~/.codex/sessions` and
`~/.claude/projects`. Parse only after path resolution succeeds.

- [ ] **Step 4: Re-run handler tests**

Run:

```bash
go test ./internal/server ./cmd/euphony
```

Expected: PASS.

### Task 5: Add the pane tabs and log renderer

**Files:**
- Create: `web/src/components/TerminalPane.tsx`
- Create: `web/src/components/TerminalPane.test.tsx`
- Create: `web/src/components/AgentLogView.tsx`
- Create: `web/src/components/AgentLogView.test.tsx`
- Add with shadcn CLI: `web/src/components/ui/tabs.tsx`
- Add with shadcn CLI: `web/src/components/ui/message-scroller.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/api.ts`
- Modify: `web/src/types.ts`
- Modify: `web/src/styles.css`
- Modify: `web/package.json`
- Modify: `web/package-lock.json`

**Interfaces:**
- Produces: `ApiClient.getAgentLog(id, etag?)`.
- Produces: `TerminalPane` with controlled terminal/log surfaces.
- Consumes: normalized agent-log endpoint.

- [ ] **Step 1: Write failing component tests**

Assert real user-visible behavior:

- terminal is the initial selected tab;
- choosing “Agent log” reveals the log and keeps the terminal DOM mounted;
- returning to terminal requests a new layout version;
- visible log polls after one second with the previous ETag;
- hidden log stops polling;
- Markdown headings, lists, links, and code render as elements while raw HTML
  remains inert text;
- loading, empty, and retrying error copy is accessible.

- [ ] **Step 2: Run and verify feature failures**

Run:

```bash
cd web
npm test -- --run src/components/TerminalPane.test.tsx src/components/AgentLogView.test.tsx
```

Expected: FAIL because the components and API method do not exist.

- [ ] **Step 3: Add dependencies and shadcn primitives**

Run:

```bash
cd web
npm install react-markdown remark-gfm
npx shadcn@latest add tabs message-scroller
```

Review generated imports and replace the registry icon placeholder in
MessageScroller with `ArrowDownIcon` from the configured Lucide library.

- [ ] **Step 4: Implement the components and styling**

Use accessible icon-only `TabsTrigger` controls with tooltips. Mount both tab
contents with the terminal hidden via `hidden`/CSS instead of conditional
unmounting. Configure:

```tsx
<MessageScrollerProvider autoScroll defaultScrollPosition="end">
```

Render messages through `ReactMarkdown` with `remarkGfm`; do not enable
`rehypeRaw`. Render tool/thinking entries with native `<details>` and semantic
`<summary>`.

- [ ] **Step 5: Re-run component and full web tests**

Run:

```bash
cd web
npm test -- --run
npm run typecheck
```

Expected: PASS.

### Task 6: Verify live-edge behavior end to end

**Files:**
- Modify: `web/e2e/euphony.spec.ts`
- Modify: `web/playwright.config.ts` only if fixture environment variables are required.

**Interfaces:**
- Consumes: production HTTP endpoint, tabs, and MessageScroller behavior.

- [ ] **Step 1: Add a failing Playwright scenario**

Start the isolated E2E server with temporary Claude/Codex roots and a fixture
transcript linked through the hook endpoint. Assert:

- the terminal/log rail is visible in each pane;
- opening a log starts at the final entry;
- appending a line while at the end keeps the new final entry visible;
- scrolling upward and appending another line preserves the prior viewport;
- pressing “Scroll to end” reveals the latest entry and resumes following.

- [ ] **Step 2: Run and verify the scenario fails before fixture wiring**

Run:

```bash
cd web
npx playwright test e2e/euphony.spec.ts --workers=1
```

Expected: FAIL at the first missing agent-log assertion.

- [ ] **Step 3: Add minimal isolated fixture wiring**

Extend the existing E2E launch helper with temporary transcript roots and
append-only fixture updates. Keep the SQLite database isolated from local
sessions.

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

Expected: all commands exit 0.

### Task 7: Commit and integrate

**Files:**
- Review all changed files.

- [ ] **Step 1: Inspect scope**

Run:

```bash
git status --short
git diff --check
git diff --stat
```

Expected: only agent-log tabs, tests, generated shadcn primitives, and design
documents are changed.

- [ ] **Step 2: Commit**

Run:

```bash
git add docs internal cmd web
git commit -m "feat: add live agent log tabs"
```

- [ ] **Step 3: Merge to the base branch**

From the base checkout, merge `feat/agent-log-tabs` without discarding or
staging unrelated local changes:

```bash
git merge --no-ff feat/agent-log-tabs
```

- [ ] **Step 4: Verify merged state**

Run the full verification commands again from the base checkout and report the
merge commit.
