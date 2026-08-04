# Finder Terminal Path Drop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert shell-safe local paths when files or folders are dropped from Finder onto a terminal.

**Architecture:** Read Finder paths from the native macOS pasteboard, hit-test the terminal beneath the drop point, and dispatch a JSON-safe custom event into the web view. Keep POSIX quoting in a small pure TypeScript module and connect it to the existing `TerminalView` WebSocket input path.

**Tech Stack:** AppKit, WebKit, Swift, React 19, TypeScript, xterm.js, Vitest, Testing Library.

## Global Constraints

- Accept only local `file://` URLs.
- Insert quoted paths without Enter.
- Preserve dropped order and focus the target terminal.
- Do not add a setting, dependency, toast, or persistent visual state.
- Keep code and documentation in English.

---

### Task 1: Parse Finder file URLs into shell input

**Files:**
- Create: `web/src/components/terminalDrop.ts`
- Create: `web/src/components/terminalDrop.test.ts`

**Interfaces:**
- Produces: `terminalInputFromURIList(value: string): string | null`.

- [ ] Write failing table-driven tests with literal expected shell strings for spaces, percent-encoding, quotes, multiple paths, comments, remote hosts, malformed values, and HTTP URLs.
- [ ] Run `npm test --prefix web -- --run src/components/terminalDrop.test.ts` and confirm failure because the module is missing.
- [ ] Implement URL validation, decoding through `URL.pathname`, POSIX single-quote escaping, and ordered joining.
- [ ] Run the focused test and confirm it passes.

### Task 2: Send dropped paths to the target terminal

**Files:**
- Modify: `web/src/components/TerminalView.tsx`
- Modify: `web/src/components/TerminalView.test.tsx`

**Interfaces:**
- Consumes: `terminalInputFromURIList(value: string): string | null`.
- Produces: a host-level drop interaction that sends `{ type: "input", data }`.

- [ ] Add a failing component test that drops a URI list on the rendered terminal host and asserts one shell-safe input message, no newline, `preventDefault`, and terminal focus.
- [ ] Run the focused test and confirm it fails because no drop handler exists.
- [ ] Add `dragover` and `drop` listeners inside the terminal lifecycle effect, reusing its `send` closure and removing both listeners during cleanup.
- [ ] Run the focused component test and the parser tests.

### Task 3: Bridge Finder drops from WKWebView

**Files:**
- Create: `macos/FileDropBridge.swift`
- Create: `macos/FileDropBridgeTests.swift`
- Modify: `macos/EuphonyApp.swift`
- Modify: `scripts/build_macos_app.sh`
- Modify: `scripts/test_macos_app.sh`

**Interfaces:**
- Produces: `euphony-file-drop` with `{ paths: string[] }` on the terminal host beneath the drop point.

- [ ] Add a failing Swift test for JSON-safe path dispatch, terminal hit testing, and empty input.
- [ ] Implement `FinderDropWebView`, native pasteboard path extraction, coordinate conversion, and JavaScript dispatch.
- [ ] Use `FinderDropWebView` in the app and include the new source and test in macOS scripts.
- [ ] Run `./scripts/test_macos_app.sh`.

### Task 4: Verify and integrate

**Files:**
- No additional files expected.

**Interfaces:**
- Produces: a verified feature commit merged into the base branch.

- [ ] Run `npm test --prefix web -- --run`.
- [ ] Run `npm run typecheck --prefix web` and `npm run build --prefix web`.
- [ ] Run `GOCACHE=/tmp/euphony-finder-drop-go-cache go test ./...`.
- [ ] Inspect the diff, commit the worktree, merge it into the base branch, and verify the base worktree status.
