# Terminal Resize and Byte Stream Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Claude Code terminals synchronized with pane width changes and preserve every PTY output byte across JSON WebSocket messages.

**Architecture:** The server will serialize PTY history and output as base64 by changing the wire payload to `[]byte`, while the frontend decodes the existing `data` field to `Uint8Array` for xterm. `TerminalView` will distinguish observed sizes from successfully sent sizes and receive the pane count as an explicit layout version for a trailing post-grid fit.

**Tech Stack:** Go 1.24, `encoding/json`, React 19, TypeScript, xterm.js, Vitest, Playwright

## Global Constraints

- Communicate with users in Japanese; write code and documents in English.
- Preserve the current visual design.
- Keep Playwright state isolated with `EUPHONY_DB=:memory:`.
- Start with a failing behavior test for every production change.
- Do not send a Claude prompt; launching the command is allowed.

---

### Task 1: Preserve PTY bytes across JSON

**Files:**
- Modify: `internal/server/terminal.go`
- Modify: `internal/server/terminal_test.go`
- Modify: `web/src/components/TerminalView.tsx`
- Modify: `web/src/components/TerminalView.test.tsx`

**Interfaces:**
- Produces: server messages shaped as `{ type: "history" | "output", data: string }`, where `data` is base64.
- Produces: `decodeTerminalData(data: string): Uint8Array`.
- Consumes: xterm's existing `write(data: string | Uint8Array, callback?)` contract.

- [ ] **Step 1: Write the failing server integration test**

Add a WebSocket test that disables shell echo, writes a Japanese character in separate byte fragments, base64-decodes every output payload, joins the decoded bytes, and expects valid UTF-8 containing `あ`.

- [ ] **Step 2: Run the server test and verify RED**

Run:

```bash
go test ./internal/server -run TestTerminalWebSocketPreservesSplitUTF8Bytes -count=1
```

Expected: FAIL because current `data` contains a JSON string rather than base64 and incomplete UTF-8 is replaced.

- [ ] **Step 3: Write the failing frontend byte-decoding test**

Send `{ type: "output", data: "44GC" }` through `FakeSocket` and assert the terminal driver receives `Uint8Array([0xe3, 0x81, 0x82])`.

- [ ] **Step 4: Run the frontend test and verify RED**

Run:

```bash
cd web && npm test -- --run src/components/TerminalView.test.tsx
```

Expected: FAIL because xterm currently receives the literal base64 string.

- [ ] **Step 5: Implement byte-safe serialization and decoding**

Change `serverMessage.Data` to `[]byte` so `encoding/json` emits base64. Change `TerminalDriver.write` to accept `string | Uint8Array`, decode history/output with `atob`, and write the resulting bytes. Catch malformed base64 without writing corrupt content.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
go test ./internal/server -run 'TestTerminal(WebSocketStreamsPTY|WebSocketPreservesSplitUTF8Bytes|ReconnectKeepsSessionAndReceivesNewOutput)' -count=1
cd web && npm test -- --run src/components/TerminalView.test.tsx
```

Expected: PASS.

### Task 2: Guarantee pane topology resize delivery

**Files:**
- Modify: `web/src/components/TerminalView.tsx`
- Modify: `web/src/components/TerminalView.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`

**Interfaces:**
- Produces: optional `layoutVersion?: number` on `TerminalViewProps`.
- Consumes: `panes.length` from `App` as the layout version.

- [ ] **Step 1: Write the failing pre-open resize test**

Trigger xterm `onResize(120, 40)` before the fake socket opens, then dispatch `open` and assert `{ type: "resize", cols: 120, rows: 40 }` is sent exactly once.

- [ ] **Step 2: Write the failing topology-change fit test**

Render with `layoutVersion={1}`, rerender with `layoutVersion={2}`, advance fake timers by 50 ms, and assert `fit()` receives an additional call without invoking `ResizeObserver`.

- [ ] **Step 3: Run the frontend tests and verify RED**

Run:

```bash
cd web && npm test -- --run src/components/TerminalView.test.tsx
```

Expected: FAIL because pre-open sizes are currently deduplicated before delivery and no layout version exists.

- [ ] **Step 4: Implement successful-send deduplication**

Make the internal `send` helper return whether an open socket accepted the message. Update `lastSize` only after a successful resize send, and force the WebSocket open handler to send the current fitted dimensions.

- [ ] **Step 5: Implement trailing topology fit**

Add `layoutVersion` to `TerminalView`, schedule `terminalRef.current?.fit()` after 50 ms whenever it changes, cancel the timer on cleanup, and pass `panes.length` from `App`.

- [ ] **Step 6: Run frontend tests and verify GREEN**

Run:

```bash
cd web && npm test -- --run src/components/TerminalView.test.tsx src/App.test.tsx
```

Expected: PASS.

### Task 3: Verify real Claude resizing and document the transport rule

**Files:**
- Create: `web/e2e/terminal-reliability.spec.ts`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: browser WebSocket resize messages and rendered xterm dimensions.
- Produces: a stable Playwright regression that launches Claude without sending a prompt.

- [ ] **Step 1: Convert the diagnostic into a bounded regression**

Keep one serial test that launches `claude`, switches between one and two panes 30 times, and asserts every resize sent for the Claude session has more than 20 columns and the final xterm screen fits within its host.

- [ ] **Step 2: Add the reusable byte-stream rule**

Add this concise rule to `AGENTS.md`:

```markdown
- Preserve arbitrary terminal byte streams across JSON boundaries with a
  lossless encoding such as base64; never stringify independent PTY chunks.
```

- [ ] **Step 3: Run focused Playwright verification**

Run:

```bash
cd web && npx playwright test e2e/terminal-reliability.spec.ts --project=chromium --workers=1
```

Expected: PASS with Claude launched and no prompt submitted.

- [ ] **Step 4: Run full verification**

Run:

```bash
make test
cd web && npx playwright test --project=chromium --workers=1
git diff --check
```

Expected: all Go packages, all Vitest tests, TypeScript typecheck, and all Playwright tests pass with no whitespace errors.

- [ ] **Step 5: Commit the implementation**

```bash
git add AGENTS.md internal/server/terminal.go internal/server/terminal_test.go web/src/App.tsx web/src/App.test.tsx web/src/components/TerminalView.tsx web/src/components/TerminalView.test.tsx web/e2e/euphony.spec.ts web/e2e/terminal-reliability.spec.ts docs/superpowers/plans/2026-07-29-terminal-resize-and-byte-stream.md
git commit -m "fix: keep terminal streams aligned with pane layout"
```
