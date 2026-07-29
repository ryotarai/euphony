# Prefix Command Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the prefix timeout with an explicit, cancellable prefix mode and bottom command legend.

**Architecture:** Keep prefix state in `App` so keyboard handling and presentation share one source of truth. Render a non-interactive status line from that state and style it as a viewport overlay.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Playwright, CSS

## Global Constraints

- Prefix mode has no timeout and survives session polling or listener rebuilds.
- Escape cancels without reaching xterm.
- Unsupported keys leave prefix mode and continue to xterm.
- The command guide uses existing Euphony visual tokens.

---

### Task 1: Prefix State and Command Guide

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/components/SessionNavigation.tsx`
- Modify: `web/src/components/SessionNavigation.test.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/e2e/euphony.spec.ts`

**Interfaces:**
- Consumes: configured `Settings.prefix` and existing tmux command handlers.
- Produces: React `prefixActive` state and `.prefix-command-guide`.

- [ ] **Step 1: Write failing unit tests**

Add tests that enter prefix mode, advance fake timers beyond 1.5 seconds, assert the guide remains, then press Escape and assert the guide disappears without invoking the terminal key handler.

- [ ] **Step 2: Verify the unit tests fail**

Run `npm test -- --run src/App.test.tsx`. Expect failures because prefix mode is local to the effect and expires after 1.5 seconds.

- [ ] **Step 3: Implement the state transition**

Move prefix activity into React state, remove the timer, handle Escape before command dispatch, clear state for every post-prefix key, and render the command legend.

- [ ] **Step 4: Style the guide**

Add a fixed bottom status line using the existing `#111417`, `#b8f34a`, `#829099`, and monospace typography. Keep it single-line, horizontally scrollable, and pointer-transparent.

- [ ] **Step 5: Verify unit tests**

Run `npm test -- --run src/App.test.tsx && npm run typecheck`. Expect all tests and type checking to pass.

- [ ] **Step 6: Add and run browser coverage**

Focus `.xterm-helper-textarea`, press the configured prefix, verify the guide, press Escape, and verify it disappears. Run the targeted Playwright scenario.

- [ ] **Step 7: Run the full suite**

Run `make test`. Expect Go, Vitest, and TypeScript checks to pass.

- [ ] **Step 8: Verify sidebar selection controls**

Add component and App tests proving terminal checkboxes toggle additive pane membership and status text replaces the current selection without changing status-checkbox semantics.
