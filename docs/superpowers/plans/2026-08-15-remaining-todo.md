# Remaining Euphony TODO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the two unchecked active TODO items by fixing Agent Log list rendering and replacing the permanent session information pane with an accessible delayed hover card.

**Architecture:** Keep Markdown parsing unchanged and scope list presentation to Agent Log message content. Move session information presentation into a reusable card rendered by the agent-list row components, whose item interaction state controls a single fixed-position card; remove the information-pane grid track and its resize state from `App`.

**Tech Stack:** React 19, TypeScript, React Testing Library, Vitest, CSS, Playwright.

## Global Constraints

- Communicate with the user in Japanese; write repository code and documents in English.
- Work only in isolated git worktrees under `tmp/worktrees` and preserve unrelated user changes.
- Leave the `Pending` section of `Euphony TODO.md` unchanged.
- Keep the existing `react-markdown` and `remark-gfm` rendering/sanitization pipeline.
- Delay session-card display by exactly 500ms after pointer entry or focus.
- Keep the card inside the viewport and close it on leave, blur, replacement, or Escape.
- Do not change selection semantics or accessible names while removing the information-pane layout.

---

### Task 1: Restore Agent Log Markdown list presentation

**Files:**
- Modify: `web/src/components/AgentLogView.test.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: the existing `Markdown` component and `.agent-log-message` content wrapper.
- Produces: scoped list styles that apply to unordered, ordered, and nested lists rendered in Agent Log messages.

- [ ] **Step 1: Write the failing test**

Add a component assertion that the rendered Agent Log Markdown list is inside the Agent Log message content wrapper and that the wrapper identifies Markdown content with the existing scoped class.

```tsx
const list = await screen.findByRole("list");
expect(list.closest(".agent-log-message")).toBeInTheDocument();
expect(list.closest(".agent-log-message")).toHaveClass("agent-log-markdown");
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `cd web && npm test -- --run src/components/AgentLogView.test.tsx -t "renders normalized transcript"`

Expected: FAIL because the Markdown wrapper does not yet expose the scoped list class.

- [ ] **Step 3: Write the minimal implementation**

Add the `agent-log-markdown` class to the existing Markdown wrapper and add scoped CSS for marker type, indentation, and nested-list spacing:

```css
.agent-log-markdown ul { list-style: disc; }
.agent-log-markdown ol { list-style: decimal; }
.agent-log-markdown ul ul { list-style: circle; }
.agent-log-markdown ul,
.agent-log-markdown ol { padding-inline-start: 1.5rem; }
```

Extend the rules with the project’s existing spacing tokens without changing global list styles.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `cd web && npm test -- --run src/components/AgentLogView.test.tsx`

Expected: PASS with all Agent Log tests passing.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/AgentLogView.test.tsx web/src/styles.css
git commit -m "fix: restore agent log list styling"
```

### Task 2: Replace the information pane with a delayed hover card

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/SessionNavigation.tsx`
- Modify: `web/src/components/ProjectSidebar.tsx`
- Modify: `web/src/components/SessionInfoPane.tsx`
- Modify: `web/src/components/SessionInfoPane.test.tsx`
- Modify: `web/src/components/ProjectSidebar.test.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: the existing session, summary, selection, and navigation props.
- Produces: one `SessionInfoCard` rendered by the current project/legacy agent-list row components, positioned with fixed viewport coordinates and driven by pointer/focus lifecycle state.

- [ ] **Step 1: Write failing interaction tests**

Cover all externally visible behavior:

```tsx
fireEvent.mouseEnter(item, { clientX: 40, clientY: 80 });
vi.advanceTimersByTime(499);
expect(screen.queryByRole("dialog", { name: "Session information" })).not.toBeInTheDocument();
vi.advanceTimersByTime(1);
expect(screen.getByRole("dialog", { name: "Session information" })).toHaveTextContent(session.cwd);

fireEvent.mouseLeave(item);
expect(screen.queryByRole("dialog", { name: "Session information" })).not.toBeInTheDocument();
```

Also assert focus opens the card after 500ms, Escape closes it, and the rendered card has a bounded fixed-position style. Update the App test to assert the old information-pane region and resize separator are absent while the terminal remains visible.

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `cd web && npm test -- --run src/components/SessionInfoPane.test.tsx src/components/SessionNavigation.test.tsx src/App.test.tsx`

Expected: FAIL because the current App still reserves/renderers the information pane and the navigation items do not own delayed card state.

- [ ] **Step 3: Extract the reusable card and implement the interaction state**

Move the current information presentation into `SessionInfoCard` while preserving its text, summary fallback, and accessible heading. In `SessionNavigation`, store the pending/visible session ID, timer ID, and pointer coordinates; schedule the card with `window.setTimeout(..., 500)`, cancel stale timers on leave/blur/Escape, and clamp fixed coordinates against `window.innerWidth`/`window.innerHeight`.

- [ ] **Step 4: Remove the permanent information-pane layout**

Remove `SessionInfoPane` rendering, session-information width/resizing state, grid column, and separator from `App`. Keep all session selection, terminal rendering, dashboard selection, and URL synchronization behavior intact.

- [ ] **Step 5: Add card styling and verify focused tests**

Style the fixed card with the existing dark surface/border/radius conventions, give it a high stacking order, make it pointer-safe, and ensure narrow viewports clamp it without horizontal overflow. Run the focused test files again and expect PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/App.tsx web/src/components/SessionNavigation.tsx web/src/components/SessionInfoPane.tsx web/src/components/SessionInfoPane.test.tsx web/src/App.test.tsx web/src/styles.css
git commit -m "feat: show session information on hover"
```

### Task 3: Integrate, verify, and update the TODO

**Files:**
- Modify: `/Users/ryotarai/Library/Mobile Documents/iCloud~md~obsidian/Documents/ryotarai/Euphony/Euphony TODO.md`

- [ ] **Step 1: Review both worktree diffs**

Confirm that only the Agent Log list presentation and active hover-card requirement changed, that no `Pending` line changed, and that unrelated user files remain untouched.

- [ ] **Step 2: Run the complete verification suite**

Run:

```bash
go test ./...
cd web && npm test -- --run && npm run typecheck && npm run build
cd web && npx playwright test --workers=1
```

Expected: every command exits with status 0.

- [ ] **Step 3: Update only the active TODO checkboxes**

Change the two active lines to `[x]`:

```markdown
- [x] agent log: 箇条書きが箇条書きのスタイルになっていない![[Pasted image 20260815171140.png]]
- [x] info paneは削除。その代わりにagent listのitemにホバーして500 msec経ったらcardをマウスポインターあたりにホバーさせて、その情報を表示する
```

Leave the `# Pending` section byte-for-byte unchanged.

- [ ] **Step 4: Commit and merge**

Commit the final integrated branch, then merge it into the base `main` branch without staging unrelated pre-existing changes.
