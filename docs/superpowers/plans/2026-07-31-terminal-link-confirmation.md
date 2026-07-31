# Terminal Link Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open HTTP(S) OSC 8 terminal links directly in a new tab without xterm.js's confirmation dialog.

**Architecture:** Keep xterm.js responsible for parsing and rendering OSC 8 links. Configure its existing `linkHandler` option with a small validated opener that preserves the safe new-window/opener behavior while removing only the default `confirm` call.

**Tech Stack:** React 19, TypeScript, `@xterm/xterm` 6, Vitest, Playwright, Go-backed Euphony test server.

## Global Constraints

- Clicking an HTTP or HTTPS hyperlink opens it in a new browser tab.
- The link activation path does not call `window.confirm`.
- The new window's `opener` is cleared before navigation.
- Invalid URLs and non-HTTP(S) protocols remain blocked.
- Do not add a settings toggle or a new dependency.
- Keep code and test/document text in English.

---

### Task 1: Configure direct terminal-link opening

**Files:**
- Modify: `web/src/components/TerminalView.test.tsx`
- Modify: `web/src/components/TerminalView.tsx`

**Interfaces:**
- Consumes: xterm.js `Terminal` construction in `defaultTerminal`.
- Produces: `openTerminalLink(uri: string): void`, which validates an external
  URI, opens a blank tab, clears its opener, and navigates it.

- [ ] **Step 1: Write the failing tests**

Add these tests near the existing terminal utility tests:

```tsx
test("opens an HTTP terminal link without confirmation", () => {
  const popup = { location: { href: "" }, opener: window } as unknown as Window;
  const open = vi.spyOn(window, "open").mockReturnValue(popup);
  const confirm = vi.spyOn(window, "confirm");

  openTerminalLink("https://example.com/docs");

  expect(confirm).not.toHaveBeenCalled();
  expect(open).toHaveBeenCalledWith();
  expect(popup.opener).toBeNull();
  expect(popup.location.href).toBe("https://example.com/docs");
});

test("does not open non-HTTP terminal links", () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);

  openTerminalLink("javascript:alert(1)");

  expect(open).not.toHaveBeenCalled();
});
```

Import `openTerminalLink` from `./TerminalView` with the existing imports.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm test --prefix web -- --run src/components/TerminalView.test.tsx -t "terminal link"
```

Expected: FAIL because `openTerminalLink` is not exported yet. Confirm the
failure is about the missing production behavior rather than a test syntax or
environment error.

- [ ] **Step 3: Implement the minimal link handler**

In `web/src/components/TerminalView.tsx`, add the exported helper:

```ts
export function openTerminalLink(uri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;

  const newWindow = window.open();
  if (!newWindow) {
    console.warn("Opening link blocked as opener could not be cleared");
    return;
  }
  try {
    newWindow.opener = null;
  } catch {
    // Some browser shells may reject changing opener.
  }
  newWindow.location.href = parsed.href;
}
```

Pass the handler into the `Terminal` options in `defaultTerminal`:

```ts
linkHandler: {
  activate: (_event, uri) => openTerminalLink(uri),
},
```

Do not set `allowNonHttpProtocols`; xterm.js must continue filtering
non-HTTP(S) OSC 8 links before activation.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the same focused Vitest command. Expected: both terminal-link tests pass
with no confirmation dialog and no warnings for the valid link.

- [ ] **Step 5: Commit the implementation**

```bash
git add web/src/components/TerminalView.tsx web/src/components/TerminalView.test.tsx
git commit -m "fix: skip terminal link confirmation"
```

### Task 2: Verify the real OSC 8 browser interaction

**Files:**
- Modify: `web/e2e/terminal-reliability.spec.ts`

**Interfaces:**
- Consumes: the real xterm terminal rendered by `TerminalView` and the
  isolated Playwright Euphony server.
- Produces: an end-to-end regression test that proves a rendered OSC 8 link
  opens directly and does not emit a browser dialog.

- [ ] **Step 1: Add the regression scenario**

After the cursor scenario, add a test that clears the isolated sessions,
creates one terminal, opens the page, writes an OSC 8 link through the shell,
and waits for the visible link text:

```ts
test("opens OSC 8 terminal links without a confirmation dialog", async ({ page }) => {
  await clearSessions(page);
  await createSession(page, "Link terminal");
  await page.goto("/?token=test-token");

  const terminal = page.getByLabel("Link terminal terminal", { exact: true });
  await expect(terminal).toBeVisible();
  await terminal.click();
  await page.keyboard.insertText(
    "printf '\\033]8;;https://example.com/docs\\033\\\\Example link\\033]8;;\\033\\\\\\n'",
  );
  await page.keyboard.press("Enter");

  const linkText = terminal.locator(".xterm-rows span", { hasText: "Example link" }).first();
  await expect(linkText).toBeVisible();
  let dialogSeen = false;
  page.on("dialog", async (dialog) => {
    dialogSeen = true;
    await dialog.dismiss();
  });
  const popupPromise = page.waitForEvent("popup");
  await linkText.click();
  const popup = await popupPromise;

  await expect.poll(() => popup.url()).toBe("https://example.com/docs");
  expect(dialogSeen).toBe(false);
});
```

Adjust only the locator or shell escaping if the current xterm renderer uses a
different span boundary; keep the assertion on the popup URL and the absence
of a dialog.

- [ ] **Step 2: Run the focused Playwright test**

Run:

```bash
npx playwright test --config web/playwright.config.ts web/e2e/terminal-reliability.spec.ts -g "OSC 8 terminal links"
```

Expected: PASS with one worker and the configured isolated in-memory database.

- [ ] **Step 3: Commit the end-to-end regression**

```bash
git add web/e2e/terminal-reliability.spec.ts
git commit -m "test(e2e): cover direct terminal links"
```

### Task 3: Run the complete verification suite

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: the committed implementation and regression tests from Tasks 1–2.
- Produces: verified unit, type, build, Go, and Playwright results.

- [ ] **Step 1: Run all frontend unit tests and typecheck**

```bash
npm test --prefix web -- --run
npm run typecheck --prefix web
```

Expected: all Vitest tests pass and TypeScript reports no errors.

- [ ] **Step 2: Run the production build**

```bash
npm run build --prefix web
```

Expected: the frontend builds successfully.

- [ ] **Step 3: Run Go tests with a writable isolated cache**

```bash
GOCACHE=/tmp/euphony-go-build-cache go test ./...
```

Expected: all Go packages pass without relying on the restricted global Go
cache.

- [ ] **Step 4: Run the complete Playwright suite**

```bash
npx playwright test --config web/playwright.config.ts
```

Expected: all browser tests pass with one worker and the configured isolated
in-memory test database.

- [ ] **Step 5: Inspect the final diff and report evidence**

```bash
git status --short
git log --oneline -4
git diff main...HEAD --stat
git diff main...HEAD --check
```

Expected: only the design, implementation, and tests for terminal-link
navigation are present, with no whitespace errors.
