# CWD-First Sidebar Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the status-first sidebar with a cwd-first two-level tree whose session rows carry lifecycle icons, attention dots, and direct cwd-scoped terminal creation.

**Architecture:** Keep `App`'s shared selection and filter state unchanged. Refactor `SessionNavigation` to group supplied sessions by exact cwd, render one cwd heading with a plus callback, and render each session with a status icon, existing selection checkbox, provider/title content, attention marker, and delete action. Add only the optional cwd argument at the App creation boundary.

**Tech Stack:** React 19, TypeScript, Testing Library, Vitest, Playwright, Vite, Lucide React, and the existing shadcn sidebar primitives.

## Global Constraints

- Communicate with users in Japanese; write code, tests, and repository documents in English.
- Work only in `tmp/worktrees/sidebar-cwd-tree` until the verified commit is merged into `main`.
- Keep shared URL/API selection filter compatibility even though status/cwd filter controls leave the sidebar.
- Preserve terminal split selection, Alt-click pinning, row selection, deletion confirmation, mobile drawer behavior, sidebar resize/collapse, and the existing attention accessibility contract.
- Use `#38bdf8` and a 6px circular marker for attention; do not pulse or replace lifecycle status with attention.
- Run frontend behavior verification with one Playwright worker and the existing in-memory backend configuration.

---

### Task 1: Replace sidebar component expectations with cwd-first failing tests

**Files:**
- Modify: `web/src/components/SessionNavigation.test.tsx`

**Interfaces:**
- Consumes: current `SessionNavigation` props (`sessions`, `selectedIDs`, `pinnedIDs`, `onSelect`, `onCreate`, `onDelete`, and optional settings callbacks).
- Produces: tests requiring `onCreate(cwd?: string)`, cwd-first DOM order, status marker classes/labels, and existing terminal checkbox behavior.

- [ ] **Step 1: Read the test-specific guidance and locate obsolete hierarchy assertions**

Run:

```bash
sed -n '1,260p' /Users/ryotarai/.codex/plugins/cache/openai-curated-remote/superpowers/6.2.0/skills/writing-good-tests.md
rg -n '^test\(|Show all|Show only|heading|attention-dot' web/src/components/SessionNavigation.test.tsx
```

Expected: the current status/cwd hierarchy tests are identified before editing them.

- [ ] **Step 2: Replace the hierarchy test with a cwd-first failing test**

Use two exact cwds, one running agent, one blocked agent with `needsAttention`,
and one plain terminal. Assert cwd headings appear in first-seen order, status
headings and `Show all … terminals` checkboxes are absent, the running marker
has `session-status-running`, the blocked marker has accessible name `Blocked`
and text `🚫`, and only the attention row has a `Needs attention` description.

```tsx
test("renders a cwd-first tree with lifecycle icons and trailing attention", () => {
  const grouped: Session[] = [
    { ...sessions[0], cwd: "/workspace/project", agentStatus: "running" },
    {
      ...sessions[1],
      id: "blocked",
      name: "Permission request",
      cwd: "/workspace/project",
      agent: "codex",
      agentStatus: "blocked",
      agentTitle: "Permission request",
      needsAttention: true,
    },
    { ...sessions[2], cwd: "/workspace/shell" },
  ];
  render(
    <SessionNavigation
      sessions={grouped}
      selectedIDs={["one"]}
      onSelect={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
    />,
  );

  expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
    "/workspace/project",
    "/workspace/shell",
  ]);
  expect(screen.queryByRole("heading", { name: "Running" })).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: /Show all/ })).not.toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Running" })).toHaveClass("session-status-running");
  expect(screen.getByRole("img", { name: "Blocked" })).toHaveTextContent("🚫");

  const attentionButton = screen.getByRole("button", { name: "Select Permission request" });
  expect(attentionButton).toHaveAccessibleDescription("Needs attention");
  expect(attentionButton.querySelector(".attention-dot")).toBeVisible();
  expect(screen.getByRole("button", { name: "Select Terminal" })).not.toHaveAccessibleDescription(
    "Needs attention",
  );
});
```

- [ ] **Step 3: Add a failing cwd-plus test**

```tsx
test("creates a terminal from the cwd heading", async () => {
  const onCreate = vi.fn();
  const user = userEvent.setup();
  render(
    <SessionNavigation
      sessions={sessions}
      selectedIDs={["one"]}
      onSelect={() => undefined}
      onCreate={onCreate}
      onDelete={() => undefined}
    />,
  );

  await user.click(screen.getByRole("button", { name: "Create terminal in ~/work/euphony" }));
  expect(onCreate).toHaveBeenCalledWith("/Users/ryotarai/work/euphony");
});
```

Run:

```bash
npm test -- --run web/src/components/SessionNavigation.test.tsx
```

Expected: FAIL because the current component still renders status parents and has no cwd-plus button.

- [ ] **Step 4: Remove only tests for deleted status/cwd filter controls**

Remove `statusFilters`, `pinnedStatusFilters`, `cwdFilters`,
`pinnedCwdFilters`, and their callback assertions from component JSX. Keep
mobile drawer, terminal split selection/pinning, deletion, collapse, resize,
settings, and overflow tests.

- [ ] **Step 5: Commit the red tests**

```bash
git add web/src/components/SessionNavigation.test.tsx
git commit -m "test: specify cwd-first sidebar tree"
```

---

### Task 2: Implement cwd grouping, status markers, attention placement, and cwd creation

**Files:**
- Modify: `web/src/components/SessionNavigation.tsx`
- Modify: `web/src/styles.css`
- Test: `web/src/components/SessionNavigation.test.tsx`

**Interfaces:**
- Consumes: `SessionNavigationProps` with `onCreate(cwd?: string): void`.
- Produces: ordered cwd groups, accessible `StatusIcon` output, `Create terminal in <display cwd>` buttons, and child rows with `.session-status-icon` plus `.attention-dot`.

- [ ] **Step 1: Change the component props and add exact-cwd grouping**

Remove sidebar-only status/cwd filter props while retaining the exported
`cwdFilterKey` used by `App`. Add this helper before `SessionList`:

```tsx
function groupSessionsByCwd(sessions: Session[]) {
  const groups = new Map<string, Session[]>();
  for (const session of sessions) {
    const group = groups.get(session.cwd);
    if (group) group.push(session);
    else groups.set(session.cwd, [session]);
  }
  return [...groups].map(([cwd, groupedSessions]) => ({
    cwd,
    sessions: groupedSessions,
  }));
}
```

- [ ] **Step 2: Add the status icon mapping**

Import `CircleCheckIcon`, `CircleHelpIcon`, `CirclePauseIcon`, `CircleXIcon`,
`LoaderCircleIcon`, and `SquareTerminalIcon`. Render
`LoaderCircleIcon` with `role="img"`, `aria-label="Running"`, and
`session-status-running`; render blocked as a `span` with `role="img"`,
`aria-label="Blocked"`, and literal `🚫`. Map waiting, terminal, starting,
exited, failed, and unknown values to static icons with readable labels.

- [ ] **Step 3: Run the focused tests to confirm a correct red failure**

Run:

```bash
npm test -- --run web/src/components/SessionNavigation.test.tsx
```

Expected: FAIL with missing cwd-first markup/callback behavior, not an import or syntax error.

- [ ] **Step 4: Replace the status-first render with cwd groups and child rows**

Render each cwd heading with an `h3`, full-path `title`, and a real button:

```tsx
<button
  className="cwd-create"
  aria-label={`Create terminal in ${displayPath(cwd)}`}
  title={`Create terminal in ${displayPath(cwd)}`}
  onClick={(event) => {
    event.stopPropagation();
    props.onCreate(cwd);
  }}
>
  <PlusIcon aria-hidden="true" />
</button>
```

Keep each terminal checkbox and delete action. Put `StatusIcon` before the
provider image/title, and retain the existing `aria-describedby`,
`aria-current`, and mobile row-selection behavior for attention.

- [ ] **Step 5: Add the final sidebar CSS rules**

Make the cwd heading position its plus button at the right, make
`.session-select` relative, and place `.attention-dot` at
`right: 0.6rem; top: 50%` with 6px size and `#38bdf8`. Keep deletion just to
the left of that slot when it appears. Add:

```css
@keyframes session-status-spin {
  to {
    transform: rotate(360deg);
  }
}

.session-status-running {
  animation: session-status-spin 900ms linear infinite;
}
```

The existing global `prefers-reduced-motion` rule must disable the animation.

- [ ] **Step 6: Run focused tests, then clean unused component styles**

Run:

```bash
npm test -- --run web/src/components/SessionNavigation.test.tsx
```

Expected: all SessionNavigation tests PASS. Only after green, remove unused
status-heading, status-select, badge, and cwd-select imports/styles.

- [ ] **Step 7: Commit the component implementation**

```bash
git add web/src/components/SessionNavigation.tsx web/src/styles.css web/src/components/SessionNavigation.test.tsx
git commit -m "feat: render sidebar as cwd-first session tree"
```

---

### Task 3: Thread cwd creation through App and add integration coverage

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: `SessionNavigation`'s `onCreate(cwd?: string)` callback.
- Produces: `onCreate={(cwd) => void createSession(false, cwd)}` and a POST regression test.

- [ ] **Step 1: Add the failing App integration test**

Use `syncSelection={false}` with one initial `/workspace/euphony` session and
a mocked `POST /api/sessions` response. Click
`Create terminal in /workspace/euphony`, then assert:

```tsx
expect(fetchMock).toHaveBeenNthCalledWith(
  2,
  "/api/sessions",
  expect.objectContaining({
    method: "POST",
    body: JSON.stringify({ name: "Terminal", cwd: "/workspace/euphony" }),
  }),
);
expect(await screen.findByRole("button", { name: "Select Terminal" })).toHaveAttribute(
  "aria-current",
  "true",
);
```

Run:

```bash
npm test -- --run web/src/App.test.tsx
```

Expected: FAIL because the App render boundary still invokes `createSession()` without the clicked cwd.

- [ ] **Step 2: Wire the callback and remove deleted sidebar props**

Replace `onCreate={() => void createSession()}` with:

```tsx
onCreate={(cwd) => void createSession(false, cwd)}
```

Remove only the deleted sidebar filter props/callbacks. Keep App filter state,
URL parsing, shared-selection writes, and quick actions intact.

- [ ] **Step 3: Run both focused suites**

```bash
npm test -- --run web/src/App.test.tsx web/src/components/SessionNavigation.test.tsx
```

Expected: PASS with zero failures.

- [ ] **Step 4: Commit the App integration**

```bash
git add web/src/App.tsx web/src/App.test.tsx
git commit -m "feat: create terminals from cwd sidebar groups"
```

---

### Task 4: Update browser coverage and verify the complete change

**Files:**
- Modify: `web/e2e/euphony.spec.ts`
- Modify only if needed: `web/src/styles.css`

**Interfaces:**
- Consumes: the Playwright backend from `web/playwright.config.ts`, which uses `EUPHONY_DB=:memory:` and one worker.
- Produces: browser evidence for cwd grouping, status markers, attention placement, and cwd-scoped creation.

- [ ] **Step 1: Replace the obsolete empty-status-group E2E test**

Create sessions in `/tmp` and `/var/tmp`, open the app, assert both cwd
headings appear in DOM order, assert no `Show all … terminals` checkbox or
`No terminal` placeholder exists, then click `Create terminal in /tmp` and poll
`/api/sessions` until `/tmp` contains two sessions. Keep a screenshot named
`cwd-first-sidebar.png`.

- [ ] **Step 2: Extend browser assertions for status and attention geometry**

Use the blocked-agent flow or add an optional cwd argument to `reportAgent` so
the session stays in its intended group. Assert `.session-status-running`, the
`🚫` marker, and the existing 6px circular `rgb(56, 189, 248)` attention dot;
keep existing pane attention assertions unchanged.

- [ ] **Step 3: Run the frontend unit, type, and build checks**

```bash
npm test -- --run
npm run typecheck
npm run build
```

Expected: Vitest passes, TypeScript exits 0, and Vite produces a production build.

- [ ] **Step 4: Run Playwright against the isolated one-worker backend**

```bash
EUPHONY_E2E_PORT=18081 npm run e2e -- --workers=1
```

Expected: all Playwright tests pass on the dedicated port without persisted local sessions.

- [ ] **Step 5: Run Go tests and inspect the final diff**

```bash
go test ./...
git -c core.fsmonitor=false diff --check origin/main..HEAD
git -c core.fsmonitor=false status --short
```

Expected: Go tests pass, `diff --check` has no output, and only intended
design, plan, component, App, style, and E2E files are changed in this branch.

- [ ] **Step 6: Commit any final browser/style adjustments**

```bash
git add web/e2e/euphony.spec.ts web/src/styles.css
git commit -m "test: verify cwd-first sidebar in browser"
```

If no files remain staged, keep the earlier commits and use fresh verification output as the merge gate.
