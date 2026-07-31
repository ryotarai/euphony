# Expandable Agent Log Tool Pairs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let readers expand compact Agent Log tool counts and inspect each tool call together with its matching result.

**Architecture:** Preserve normalized tool entries inside the existing paginated `tool_group` transport object and retain agent call identifiers on calls and results. Derive paired execution units in React, render them inside an accessible disclosure, and merge detail arrays whenever adjacent page groups merge.

**Tech Stack:** Go JSONL normalization, OpenAPI 3.1, React 19, TypeScript, CSS, Vitest, Testing Library, Playwright.

## Global Constraints

- Work only in `tmp/worktrees/agent-log-tool-pairs` until the verified branch is merged.
- Keep newest/older pages bounded to 100 JSONL records and 2 MiB of source data.
- Keep normalized tool entry content capped at the existing 48 KiB limit.
- Never accept a browser-supplied transcript path or call identifier.
- Keep tool content as escaped preformatted text; never render it as HTML.
- Preserve existing polling, ETag, scroll-follow, and viewport-compensation behavior.
- Run end-to-end state mutations with one worker and an isolated database.
- Follow strict Red-Green-Refactor order for production changes.

---

### Task 1: Preserve grouped tool detail and call identity

**Files:**

- Modify: `internal/agentlog/types.go`
- Modify: `internal/agentlog/parser.go`
- Modify: `internal/agentlog/parser_test.go`
- Modify: `internal/agentlog/page.go`
- Modify: `internal/agentlog/page_test.go`
- Modify: `internal/server/openapi.json`

**Interfaces:**

- Produces: `Entry.CallID string` serialized as optional `callId`.
- Produces: `Entry.Entries []Entry` serialized as optional `entries`.
- Produces: `CompactTools(entries []Entry) []Entry`, retaining consecutive tool
  and result entries inside one `tool_group`.
- Preserves: `Entry.ToolCalls`, counting only `tool` children.

- [ ] **Step 1: Write failing parser and compaction tests**

Update literal parser expectations so Claude `tool_use`/`tool_result` and Codex
`function_call`/`function_call_output` entries contain the same hand-authored
call ID. Replace the payload-dropping compaction test with:

```go
entries := []Entry{
    {ID: "2-0", Kind: "tool", CallID: "call-1", Title: "exec", Content: `{"command":"go test"}`},
    {ID: "3-0", Kind: "tool_result", CallID: "call-1", Title: "exec", Content: "ok"},
}
want := []Entry{{
    ID: "2-0", Kind: "tool_group", ToolCalls: 1,
    Entries: entries,
}}
```

Add a result-only assertion whose expected group contains the result child and
has zero `ToolCalls`, proving a page fragment is not discarded.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
GOCACHE=/private/tmp/euphony-agent-log-go-cache go test ./internal/agentlog
```

Expected: FAIL because `Entry` has no `CallID` or nested `Entries`, the parser
drops call identity, and `CompactTools` drops child content.

- [ ] **Step 3: Implement the minimal normalized transport**

Add:

```go
CallID  string  `json:"callId,omitempty"`
Entries []Entry `json:"entries,omitempty"`
```

Set `CallID` from Claude `id`/`tool_use_id` and Codex `call_id`. Change
`CompactTools` so every consecutive `tool` or `tool_result` child is appended
to `group.Entries`, while only `tool` increments `group.ToolCalls`. Flush any
group with at least one child.

- [ ] **Step 4: Extend the OpenAPI schema**

Add optional `callId` and a recursive `entries` array referencing
`AgentTranscriptEntry`. Leave both optional and retain
`additionalProperties: false`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
GOCACHE=/private/tmp/euphony-agent-log-go-cache go test ./internal/agentlog
```

Expected: PASS.

---

### Task 2: Render expandable paired executions

**Files:**

- Modify: `web/src/types.ts`
- Modify: `web/src/components/AgentLogView.tsx`
- Modify: `web/src/components/AgentLogView.test.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/e2e/euphony.spec.ts`

**Interfaces:**

- Consumes: `AgentLogEntry.callId?: string`.
- Consumes: `AgentLogEntry.entries?: AgentLogEntry[]`.
- Produces: an accessible `<details className="agent-log-tool-group">`.
- Produces: paired execution articles with call and result regions.

- [ ] **Step 1: Write a failing React disclosure and pairing test**

Use a transcript group containing two calls and their results, including
distinct payload literals. Assert:

```tsx
const disclosure = await screen.findByText("2 tool calls");
expect(disclosure.closest("details")).not.toHaveAttribute("open");
expect(screen.queryByText("secret command 1")).not.toBeVisible();
await user.click(disclosure);
expect(within(firstExecution).getByText("secret command 1")).toBeVisible();
expect(within(firstExecution).getByText("secret result 1")).toBeVisible();
```

Locate execution containers by accessible article names derived from tool
names. This catches missing grouping, wrong call/result association, and
details that are expanded by default.

Add a page-merge test where one page contributes a call and the adjacent page
contributes its result. After merge and expansion, assert both are in the same
execution article.

- [ ] **Step 2: Run the focused React test and verify RED**

Run:

```bash
npm test -- --run src/components/AgentLogView.test.tsx
```

Expected: FAIL because the count row is not a disclosure, nested entries are
not typed, and no paired execution UI exists.

- [ ] **Step 3: Implement pairing and disclosure**

Extend `AgentLogEntry` with `callId` and `entries`. Add a pure
`pairToolEntries(entries)` helper that:

1. creates an execution for each call in source order;
2. indexes calls by non-empty `callId`;
3. attaches matching results by `callId`;
4. attaches an immediately available unkeyed result to the earliest unmatched
   call, otherwise creates a result-only execution.

Render a native `<details>` with the existing count in `<summary>`. Render each
execution as an `<article>` with a tool-name heading, a sequence number, a
`Call` preformatted region, and a `Result` preformatted region. Use `(empty)`,
`Waiting for result…`, and `Tool result` for boundary states.

When `mergeAdjacentToolGroups` joins groups, concatenate both nested `entries`
arrays in source order and sum `toolCalls`.

- [ ] **Step 4: Add trace styling**

Keep the existing console palette. Replace the dot count row with the existing
chevron disclosure pattern. Expanded executions use one left hairline trace,
monospace uppercase `Call`/`Result` labels, flush separators, horizontally
scrollable `<pre>` blocks, visible `:focus-visible`, and no rounded cards.
Disable the chevron transition under `prefers-reduced-motion: reduce`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
npm test -- --run src/components/AgentLogView.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Update and run the Playwright behavior**

Change the real transcript test to click `3 tool calls`, then assert
`secret command 1` and `secret result 1` are visible inside the same named
execution article. Capture the expanded trace screenshot.

Run with a dedicated port:

```bash
EUPHONY_E2E_PORT=18131 npm run e2e -- e2e/euphony.spec.ts \
  --grep "shows a live agent transcript"
```

Expected: PASS.

---

### Task 3: Verify before integration

**Files:**

- Verify all modified production, test, schema, spec, and plan files.

**Interfaces:**

- Produces: fresh verification evidence for `codex/agent-log-tool-pairs`.
- Produces: a clean diff package ready for the final whole-branch review.

- [ ] **Step 1: Run focused and full verification**

Run:

```bash
GOCACHE=/private/tmp/euphony-agent-log-go-cache go test ./internal/agentlog
GOCACHE=/private/tmp/euphony-agent-log-go-cache go test ./internal/server -run AgentLog
cd web && npm test -- --run && npm run typecheck && npm run build
```

Run the full server suite outside the sandbox if local listener restrictions
block it:

```bash
GOCACHE=/private/tmp/euphony-agent-log-go-cache go test ./...
```

Expected: every command exits zero with no test failures.

- [ ] **Step 2: Review the implementation diff**

Check `git diff --check`, inspect the complete diff, confirm the OpenAPI and
TypeScript fields agree, and verify no unrelated files changed.

- [ ] **Step 3: Record the verified branch state**

Record the current implementation commits and clean worktree:

```bash
git log --oneline "$(git merge-base main HEAD)"..HEAD
git status --short
```

Do not create another implementation commit or merge yet. The
`subagent-driven-development` final whole-branch review runs next. After that
review is clean, `finishing-a-development-branch` merges
`codex/agent-log-tool-pairs` into `main` from the base checkout without
modifying or discarding unrelated base-worktree changes.
