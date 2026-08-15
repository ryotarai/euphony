# New Session Placeholder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display `New session` for sessions whose purpose and summary are both empty and no agent metadata supplies a meaningful label.

**Architecture:** Keep the fallback in the two existing React presentation components. `ProjectSidebar` continues to decide the compact row label, while `SessionInfoPane` continues to decide the detail heading. No API, domain model, persistence, or CSS changes are needed.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, npm.

## Global Constraints

- Do not persist or inject `New session` into session metadata or API responses.
- Preserve existing priority for generated purpose, agent title, and process name.
- Preserve `No summary yet.` and `No action required.` in the session information pane.
- Keep the existing typography and layout classes; the short fallback needs no new visual treatment.

---

### Task 1: Add failing sidebar coverage

**Files:**
- Modify: `web/src/components/ProjectSidebar.test.tsx`

**Interfaces:**
- Consumes: `ProjectSidebar` with a `Session` that has no `agent`, `agentStatus`, `agentTitle`, `processName`, or `AgentSummary`.
- Produces: A regression test requiring the compact row to contain `New session`.

- [x] **Step 1: Write the failing test**

Add a `newSession` fixture with an empty purpose/summary and assert that its row
renders the requested fallback:

```tsx
test("labels a session with no purpose or summary as New session", () => {
  renderSidebar({
    sessions: [{ ...terminalSession, id: "new-session", name: "Shell" }],
    agentSummaries: [],
  });

  expect(screen.getByRole("button", { name: "Select Shell" }))
    .toHaveTextContent("New session");
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- --run src/components/ProjectSidebar.test.tsx -t "labels a session with no purpose or summary as New session"`

Expected: FAIL because the row currently renders no purpose or summary text.

- [x] **Step 3: Commit**

```bash
git add web/src/components/ProjectSidebar.test.tsx
git commit -m "test: cover new session sidebar label"
```

### Task 2: Implement the sidebar fallback

**Files:**
- Modify: `web/src/components/ProjectSidebar.tsx:235`

**Interfaces:**
- Consumes: `purpose`, `latestSummary`, and the existing `.project-session-purpose` presentation class.
- Produces: `purposeText` with `New session` as its final fallback.

- [x] **Step 1: Write minimal implementation**

Change the row label selection from:

```tsx
const purposeText = purpose || latestSummary;
```

to:

```tsx
const purposeText = purpose || latestSummary || "New session";
```

- [x] **Step 2: Run the focused test to verify it passes**

Run: `cd web && npm test -- --run src/components/ProjectSidebar.test.tsx -t "labels a session with no purpose or summary as New session"`

Expected: PASS.

- [x] **Step 3: Commit**

```bash
git add web/src/components/ProjectSidebar.tsx
git commit -m "feat: label empty sessions in the project sidebar"
```

### Task 3: Add failing information-pane coverage

**Files:**
- Modify: `web/src/components/SessionInfoPane.test.tsx`

**Interfaces:**
- Consumes: `SessionInfoPane` with a session whose generated purpose, agent title, process name, and summary are empty.
- Produces: A regression test requiring the detail heading to read `New session`.

- [x] **Step 1: Write the failing test**

Add a test using the existing `session` fixture with identifying metadata
removed:

```tsx
test("uses New session when the session has no purpose or summary", () => {
  render(
    <SessionInfoPane
      session={{
        ...session,
        name: "Shell",
        agent: undefined,
        agentTitle: undefined,
        processName: undefined,
      }}
    />,
  );

  expect(screen.getByRole("heading", { name: "New session", level: 2 })).toBeVisible();
  expect(screen.getByText("No summary yet.")).toBeVisible();
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- --run src/components/SessionInfoPane.test.tsx -t "uses New session when the session has no purpose or summary"`

Expected: FAIL because the detail heading currently reads `No purpose yet.`.

- [x] **Step 3: Commit**

```bash
git add web/src/components/SessionInfoPane.test.tsx
git commit -m "test: cover new session information heading"
```

### Task 4: Implement the information-pane fallback

**Files:**
- Modify: `web/src/components/SessionInfoPane.tsx:42`

**Interfaces:**
- Consumes: `summary?.purpose`, `session.agentTitle`, and `session.processName`.
- Produces: `purposeFor()` returning `New session` when all purpose sources are empty.

- [x] **Step 1: Write minimal implementation**

Change the final return in `purposeFor` from:

```tsx
return session.agentTitle?.trim() || session.processName?.trim() || "No purpose yet.";
```

to:

```tsx
return session.agentTitle?.trim() || session.processName?.trim() || "New session";
```

- [x] **Step 2: Run the focused test to verify it passes**

Run: `cd web && npm test -- --run src/components/SessionInfoPane.test.tsx -t "uses New session when the session has no purpose or summary"`

Expected: PASS.

- [x] **Step 3: Commit**

```bash
git add web/src/components/SessionInfoPane.tsx
git commit -m "feat: label empty sessions in the information pane"
```

### Task 5: Verify the complete change

**Files:**
- Test: `web/src/components/ProjectSidebar.test.tsx`
- Test: `web/src/components/SessionInfoPane.test.tsx`

- [x] **Step 1: Run component regressions**

Run: `cd web && npm test -- --run src/components/ProjectSidebar.test.tsx src/components/SessionInfoPane.test.tsx`

Expected: PASS with zero failures.

- [x] **Step 2: Run frontend typecheck**

Run: `cd web && npm run typecheck`

Expected: exit code 0 with no TypeScript errors.

- [x] **Step 3: Run changed-scope React Doctor**

Run: `cd web && npx react-doctor@latest --verbose --scope changed`

Expected: the scan completes without a score regression caused by the changed components.

- [x] **Step 4: Inspect the final diff**

Run: `git diff main...HEAD --check` and `git status --short --branch`.

Expected: no whitespace errors, only the design/plan documents and the two
component/test changes are present, and the pre-existing base-branch changes
remain outside this worktree.

- [x] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-08-15-new-session-placeholder.md
git commit -m "docs: plan new session placeholder"
```
