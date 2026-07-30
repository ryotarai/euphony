# Annotation Comment Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make selection comments explicit through a floating `Comment` action and make the global comment a single draft submitted without an Add step.

**Architecture:** `AnnotationView` separates a pending selection action from the active selection editor and derives the floating action position from the selected range. The global textarea stays controlled locally and is folded into the API payload only when comments are sent.

**Tech Stack:** React 19, TypeScript, Testing Library, Vitest, Playwright, CSS.

## Global Constraints

- Preserve the existing annotation API payload shape.
- Keep explicit approval with no comments available.
- Preserve drafts after a failed send.
- Use the existing amber annotation color and square operator-console controls.

---

### Task 1: Selection and global comment behavior

**Files:**
- Modify: `web/src/components/AnnotationView.test.tsx`
- Modify: `web/src/components/AnnotationView.tsx`

**Interfaces:**
- Consumes: `selectionAnchor(root, selection)` and `ApiClient.completeAnnotation(id, comments)`.
- Produces: a `Comment` button for a pending selection and a payload containing saved selection comments plus at most one global comment.

- [ ] **Step 1: Write the failing component tests**

Update the selection scenario so the selected range first exposes only:

```ts
expect(screen.getByRole("button", { name: "Comment" })).toBeVisible();
expect(
  screen.queryByRole("textbox", { name: "Comment on selection" }),
).not.toBeInTheDocument();
await user.click(screen.getByRole("button", { name: "Comment" }));
expect(
  screen.getByRole("textbox", { name: "Comment on selection" }),
).toHaveFocus();
```

Update the global scenario so it fills the single textarea, asserts the Add
button is absent, sends immediately, and expects:

```ts
expect(
  screen.queryByRole("button", { name: "Add global comment" }),
).not.toBeInTheDocument();
await user.click(screen.getByRole("button", { name: "Send comments" }));
expect(completeAnnotation).toHaveBeenCalledWith("annotation-1", [
  { kind: "global", body: "The overall structure works." },
]);
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd web
npm test -- --run src/components/AnnotationView.test.tsx
```

Expected: FAIL because selection currently opens the editor immediately and
the global draft still requires `Add global comment`.

- [ ] **Step 3: Implement the minimal state and submit changes**

Add a pending-selection state containing the anchor and viewport coordinates.
On document mouseup, store that pending state. On `Comment`, promote its anchor
to `selectionDraft`, clear the pending action, and let the existing focus effect
focus the editor.

Build the completion payload without mutating saved state:

```ts
const body = globalBody.trim();
const submittedComments = body
  ? [...comments, { kind: "global" as const, body }]
  : comments;
await api.completeAnnotation(annotation.id, submittedComments);
```

Remove `addGlobalComment` and the `Add global comment` button. Derive the ready
count from `comments.length + (globalBody.trim() ? 1 : 0)`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
cd web
npm test -- --run src/components/AnnotationView.test.tsx
```

Expected: PASS.

### Task 2: Floating action styling and public workflow

**Files:**
- Modify: `web/src/styles.css`
- Modify: `web/e2e/automation.spec.ts`

**Interfaces:**
- Consumes: inline `left` and `top` coordinates from `AnnotationView`.
- Produces: a bounded amber floating action and an end-to-end verified review workflow.

- [ ] **Step 1: Update the Playwright scenario before production styling**

After programmatically selecting the passage, assert and click the floating
action before filling the selection editor:

```ts
await expect(
  page.getByRole("textbox", { name: "Comment on selection" }),
).toHaveCount(0);
await page.getByRole("button", { name: "Comment" }).click();
await page.getByRole("textbox", { name: "Comment on selection" })
  .fill("Make the rollout criteria concrete.");
```

Remove both `Add global comment` clicks so the global textareas are submitted
directly.

- [ ] **Step 2: Add the floating action styles**

Add `.annotation-selection-action` as an absolutely positioned, high z-index
amber button with a small shadow and square corners. Keep its transition
limited to color and transform, and disable that transition under the existing
reduced-motion query.

- [ ] **Step 3: Run focused tests, typecheck, build, and Playwright**

Run:

```bash
cd web
npm test -- --run src/annotationSelection.test.ts src/components/AnnotationView.test.tsx
npm run typecheck
npm run build
npx playwright test e2e/automation.spec.ts --workers=1
```

Expected: all commands PASS.

- [ ] **Step 4: Run repository verification**

Run:

```bash
cd web
npm test -- --run
cd ..
go test ./...
```

Expected: annotation tests and Go tests PASS. If the three recorded baseline
`App.test.tsx` failures recur unchanged, report them separately as pre-existing.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-07-31-annotation-comment-interaction-design.md \
  docs/superpowers/plans/2026-07-31-annotation-comment-interaction.md \
  web/src/components/AnnotationView.test.tsx \
  web/src/components/AnnotationView.tsx \
  web/src/styles.css \
  web/e2e/automation.spec.ts
git commit -m "feat: refine annotation comment interactions"
```
