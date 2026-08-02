# Delete Selected Terminals Quick Action Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a confirmed Quick Actions command that deletes every currently selected terminal session through the existing deletion flow.

**Architecture:** Keep the feature in `web/src/App.tsx`. Derive a stable selected-session snapshot for the command catalog, reuse the existing pending-delete dialog with a session list, and delete the snapshot sequentially through the existing API. Apply the final shared-selection snapshot or reconcile URL-local selection after successful deletions, preserving partial progress on errors.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Playwright, existing Go HTTP API.

## Global Constraints

- Show `Delete selected terminals` only when at least one selected terminal still exists in the current session list.
- Opening the command must not delete anything.
- Reuse the existing destructive confirmation dialog pattern.
- Delete selected terminals through the existing terminal deletion API, one at a time, in a stable order.
- Do not add a backend bulk endpoint or change the Quick Actions visual language.
- Keep arbitrary test state isolated; use `syncEvents={false}` for the unit test and the Playwright-configured in-memory backend with a dedicated `EUPHONY_E2E_PORT`.

---

### Task 1: Add the failing App behavior test

**Files:**
- Modify: `web/src/App.test.tsx` near the existing Quick Actions tests around the Command-K coverage.

**Interfaces:**
- Consumes: Existing `runningSession`, `secondRunningSession`, `jsonResponse`, Testing Library helpers, and the current `App` Quick Actions UI.
- Produces: A regression test named `deletes selected terminals from Quick Actions after confirmation` that requires the new action and count-aware dialog.

- [x] **Step 1: Write the failing test**

Add this test after the existing Command-K Quick Actions test:

```tsx
test("deletes selected terminals from Quick Actions after confirmation", async () => {
  history.replaceState(null, "", "/?terminal=session-1&terminal=session-2");
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() =>
      jsonResponse([runningSession, secondRunningSession]),
    )
    .mockImplementationOnce(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    )
    .mockImplementationOnce(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
  const user = userEvent.setup();
  render(
    <App
      syncSelection={false}
      syncEvents={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => (
        <div aria-label={`${session.name} terminal pane`} />
      )}
    />,
  );

  await screen.findByLabelText("Codex terminal pane");
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  await user.click(
    await screen.findByRole("option", {
      name: /^Delete selected terminals/,
    }),
  );

  expect(
    screen.getByRole("dialog", { name: "Delete selected terminals?" }),
  ).toBeVisible();
  expect(
    screen.getByText(/2 selected terminals will be stopped/),
  ).toBeVisible();
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.queryByRole("dialog", { name: "Delete selected terminals?" }),
  ).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);

  fireEvent.keyDown(window, { key: "k", metaKey: true });
  await user.click(
    await screen.findByRole("option", {
      name: /^Delete selected terminals/,
    }),
  );
  await user.click(screen.getByRole("button", { name: "Delete terminals" }));

  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Select Codex" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Select Claude" })).not.toBeInTheDocument();
  });
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "/api/sessions/session-1",
    expect.objectContaining({ method: "DELETE" }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    "/api/sessions/session-2",
    expect.objectContaining({ method: "DELETE" }),
  );

  fireEvent.keyDown(window, { key: "k", metaKey: true });
  expect(
    screen.queryByRole("option", { name: /^Delete selected terminals/ }),
  ).not.toBeInTheDocument();
});
```

- [x] **Step 2: Run the focused test and verify it fails for the missing feature**

Run from `web`:

```bash
npm test -- --run src/App.test.tsx -t "deletes selected terminals from Quick Actions after confirmation"
```

Expected: FAIL because the Quick Actions catalog has no `Delete selected terminals` option.

### Task 2: Implement the Quick Action and bulk confirmation flow

**Files:**
- Modify: `web/src/App.tsx` in the pending-delete state, delete handlers, Quick Actions catalog, sidebar callback, and confirmation dialog.

**Interfaces:**
- Consumes: `selectedIDs`, `sessions`, `syncSelection`, `api.deleteTerminal`, `api.deleteSession`, `applyServerSelection`, `replacementSession`, and the existing `SessionNavigation` callback.
- Produces: `deleteSessions(items: Session[])`, a `Session[] | null` pending-delete state, and a Quick Actions item with value `delete-selected-terminals`.

- [x] **Step 1: Store a session list for pending deletion**

Change the state from a single nullable session to a nullable non-empty list:

```tsx
const [pendingDelete, setPendingDelete] = useState<Session[] | null>(null);
```

Pass sidebar deletes as one-item lists:

```tsx
onDelete={(session) => setPendingDelete([session])}
```

- [x] **Step 2: Add the selected-session snapshot and Quick Actions item**

Immediately after deriving `panes`, derive the current valid selection in `selectedIDs` order:

```tsx
const selectedSessions = selectedIDs
  .map((id) => sessions.find((session) => session.id === id))
  .filter((session): session is Session => Boolean(session));
```

Insert this item at the start of the existing `Actions` entries, only when `selectedSessions.length > 0`:

```tsx
{
  value: "delete-selected-terminals",
  label: "Delete selected terminals",
  detail: `${selectedSessions.length} selected terminal${selectedSessions.length === 1 ? "" : "s"}`,
  search: "delete remove selected terminals",
  run: () => {
    setCommandOpen(false);
    setPendingDelete(selectedSessions);
  },
  group: "Actions",
}
```

Use the existing array spread pattern so the item is absent when there is no valid selection.

- [x] **Step 3: Replace single-item deletion with sequential deletion**

Rename the existing `deleteSession(item)` implementation to `deleteSessions(items)` and make it return immediately for an empty list. Keep a `Set` of successful IDs and the latest shared-selection snapshot. For each item, await the existing delete call, record success, and remove that item from `sessions` with a functional state update. Do not use `Promise.all`, because each shared-selection delete must observe the previous server mutation.

After the loop, apply the latest shared-selection snapshot with `applyServerSelection(snapshot, "push")`. In URL-local mode, remove successful IDs from `selectedIDs` and `pinnedIDs`, choose the existing replacement-terminal behavior only if selection becomes empty and no filters are active, repair focus to an ID still in the next selection, and write the updated workspace URL.

Run the same local reconciliation after a partial failure so successful deletions remain reflected in the UI. Catch the first error and set the existing `requestError` message without restoring deleted sessions.

The key local reconciliation shape is:

```tsx
const remaining = previousSessions.filter((session) => !deletedIDs.has(session.id));
const lastDeletedID = [...items]
  .reverse()
  .find((item) => deletedIDs.has(item.id))?.id;
const replacement = lastDeletedID
  ? replacementSession(previousSessions, lastDeletedID, remaining)
  : undefined;
let nextIDs = selectedIDs.filter((id) => !deletedIDs.has(id));
if (
  nextIDs.length === 0 &&
  statusFilters.length === 0 &&
  cwdFilters.length === 0 &&
  replacement
) {
  nextIDs = [replacement.id];
}
const nextFocus = focusedID && nextIDs.includes(focusedID)
  ? focusedID
  : nextIDs[0] ?? null;
const nextPinnedIDs = pinnedIDs.filter((id) => !deletedIDs.has(id));
```

Keep `deleteSession` as a one-item wrapper only if that makes existing call sites clearer; the confirmation handler must invoke `deleteSessions(pendingDelete)` once.

- [x] **Step 4: Update confirmation text and confirmation handler**

Read the first item for single-delete copy and the list length for bulk copy:

```tsx
const pendingDeleteCount = pendingDelete?.length ?? 0;
const deletingMultiple = pendingDeleteCount > 1;
```

Use `Delete selected terminals?`, `N selected terminals will be stopped and removed from this workspace. This cannot be undone.`, and `Delete terminals` for bulk deletion. Preserve `Delete terminal?`, the quoted single name, and `Delete terminal` for one-item deletion. `confirmDelete` should clear the dialog state and call `void deleteSessions(items)`.

- [x] **Step 5: Run the focused test and verify it passes**

Run:

```bash
npm test -- --run src/App.test.tsx -t "deletes selected terminals from Quick Actions after confirmation"
```

Expected: PASS, including the no-action state after all selected sessions have been removed.

### Task 3: Add browser-level coverage and verify the feature

**Files:**
- Modify: `web/e2e/euphony.spec.ts` near the existing Quick Actions scenarios.

**Interfaces:**
- Consumes: `clearSessions`, `createSession`, `replaceSharedSelection`, Playwright Quick Actions locators, and the isolated in-memory server from `playwright.config.ts`.
- Produces: A browser regression test proving cancel is non-destructive and confirmation removes both selected sessions.

- [x] **Step 1: Add the Playwright scenario**

Add this test after the existing Quick Actions navigation test:

```ts
test("deletes selected terminals from Quick Actions", async ({ page }) => {
  await clearSessions(page);
  const left = await createSession(page, "Left");
  const right = await createSession(page, "Right");
  await replaceSharedSelection(page, [left.id, right.id], left.id);

  await page.goto("/?token=test-token");
  await page.keyboard.press("Meta+K");
  await page.getByRole("option", { name: /^Delete selected terminals/ }).click();
  await expect(
    page.getByRole("dialog", { name: "Delete selected terminals?" }),
  ).toBeVisible();
  await expect(
    page.getByText(/2 selected terminals will be stopped/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(
    page.getByRole("button", { name: "Select Left" }),
  ).toBeVisible();

  await page.keyboard.press("Meta+K");
  await page.getByRole("option", { name: /^Delete selected terminals/ }).click();
  await page.getByRole("button", { name: "Delete terminals" }).click();

  await expect(page.getByRole("button", { name: "Select Left" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Select Right" })).toHaveCount(0);
  const sessions = await page.request.get("/api/sessions", {
    headers: { Authorization: "Bearer test-token" },
  });
  expect(await sessions.json()).toEqual([]);
});
```

- [x] **Step 2: Run the focused browser test with an isolated port**

Run from `web`:

```bash
EUPHONY_E2E_PORT=18081 npm run e2e -- --grep "deletes selected terminals from Quick Actions"
```

Expected: PASS with one Playwright worker and an in-memory backend.

- [x] **Step 3: Run static and focused regression checks**

Run:

```bash
npm run typecheck
npm run build
npm test -- --run src/App.test.tsx -t "deletes selected terminals from Quick Actions|creates a terminal in the focused terminal cwd, selects it, and confirms deletion"
```

Expected: typecheck, build, and both focused App tests pass. If the pre-existing full-suite failures recur, record their exact names separately rather than widening this change.

- [x] **Step 4: Inspect the diff and commit the implementation**

Run:

```bash
git diff --check
git status --short
git diff -- web/src/App.tsx web/src/App.test.tsx web/e2e/euphony.spec.ts
git add web/src/App.tsx web/src/App.test.tsx web/e2e/euphony.spec.ts
git commit -m "feat: add bulk delete quick action"
```

Expected: only the planned Web files are modified, whitespace checks are clean, and the implementation commit is created after the focused checks pass.
