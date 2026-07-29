import { expect, test, type Page } from "@playwright/test";

async function clearSessions(page: Page) {
  await page.request.patch("/api/settings", {
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    },
    data: { prefix: "Ctrl+B", sidebarWidth: 304, sidebarCollapsed: false },
  });
  const existing = await page.request.get("/api/sessions", {
    headers: { Authorization: "Bearer test-token" },
  });
  const existingSessions = (await existing.json()) as Array<{ id: string }>;
  for (const session of existingSessions) {
    await page.request.delete(`/api/sessions/${session.id}`, {
      headers: { Authorization: "Bearer test-token" },
    });
  }
}

async function reportAgent(
  page: Page,
  terminalID: string,
  agent: "codex" | "claude",
  title: string,
) {
  const response = await page.request.post("/api/hooks/terminal", {
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    },
    data: {
      terminalId: terminalID,
      agent,
      status: "waiting",
      title,
      cwd: "/Users/ryotarai/work/euphony",
    },
  });
  expect(response.ok()).toBe(true);
}

async function createSession(page: Page, name: string): Promise<{ id: string; name: string }> {
  const response = await page.request.post("/api/sessions", {
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    },
    data: { name },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

test("opens from a development token URL and immediately scrubs it", async ({ page }) => {
  await clearSessions(page);
  await page.goto("/?token=test-token");

  await expect(page.getByLabel("Terminal terminal", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Access token")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("token")).toBe(false);
  expect(await page.evaluate(() => sessionStorage.getItem("euphony.token"))).toBe("test-token");
});

test("runs a terminal and adapts the workspace to mobile", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`);
  });

  await clearSessions(page);

  await page.goto("/");
  await page.getByLabel("Access token").fill("test-token");
  await page.getByRole("button", { name: "Open Euphony" }).click();

  const terminal = page.getByLabel("Terminal terminal", { exact: true });
  await expect(terminal).toBeVisible();
  await expect(page.locator(".terminal-view")).toHaveAttribute("data-connection", "connected");
  await terminal.click();
  await page.keyboard.type("printf 'browser-ready\\n'");
  await page.keyboard.press("Enter");

  await expect
    .poll(async () => {
      const response = await page.request.get("/api/sessions", {
        headers: { Authorization: "Bearer test-token" },
      });
      const sessions = (await response.json()) as Array<{ name: string; state: string }>;
      return sessions.some((session) => session.name === "Terminal" && session.state === "running");
    })
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath("desktop-workspace.png") });

  expect(
    await page.evaluate(() => ({
      height: document.documentElement.scrollHeight,
      viewport: window.innerHeight,
    })),
  ).toEqual(expect.objectContaining({ height: 720, viewport: 720 }));

  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.getByRole("button", { name: "Open terminal menu" });
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(page.getByRole("dialog", { name: "Terminal menu" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mobile-drawer.png") });
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();

  const mobileDimensions = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    viewport: window.innerHeight,
  }));
  expect(mobileDimensions.height).toBeLessThanOrEqual(mobileDimensions.viewport);
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test("reloads a running terminal with its previous output", async ({ page }) => {
  await clearSessions(page);
  await page.goto("/");
  await page.getByLabel("Access token").fill("test-token");
  await page.getByRole("button", { name: "Open Euphony" }).click();

  const terminal = page.getByLabel("Terminal terminal", { exact: true });
  await expect(terminal).toBeVisible();
  await expect(page.locator(".terminal-view")).toHaveAttribute("data-connection", "connected");
  await terminal.click();
  await page.keyboard.type("printf 'reload-history-marker\\n'");
  await page.keyboard.press("Enter");

  const sessionsResponse = await page.request.get("/api/sessions", {
    headers: { Authorization: "Bearer test-token" },
  });
  const [session] = (await sessionsResponse.json()) as Array<{ id: string; state: string }>;
  expect(session.state).toBe("running");
  await expect.poll(() => readTerminalHistory(page, session.id)).toContain("reload-history-marker");

  await page.reload();
  await expect(page.getByLabel("Terminal terminal", { exact: true })).toBeVisible();
  await expect(page.locator(".terminal-view")).toHaveAttribute("data-connection", "connected");
  await expect.poll(() => readTerminalHistory(page, session.id)).toContain("reload-history-marker");
});

test("keeps the selected terminal in the URL across navigation and reload", async ({ page }) => {
  await clearSessions(page);
  const first = await createSession(page, "First");
  const second = await createSession(page, "Second");

  await page.goto("/?token=test-token");
  await expect(page.getByLabel("First terminal")).toBeVisible();
  await page.getByRole("button", { name: "Select Second" }).click();
  await expect(page).toHaveURL(new RegExp(`terminal=${second.id}`));
  await expect(page.getByLabel("Second terminal")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Second terminal")).toBeVisible();
  await page.getByRole("button", { name: "Select First" }).click();
  await expect(page).toHaveURL(new RegExp(`terminal=${first.id}`));
  await page.goBack();
  await expect(page.getByLabel("Second terminal")).toBeVisible();
});

test("keeps a selected split checkbox visibly checked", async ({ page }) => {
  await clearSessions(page);
  await createSession(page, "Left");
  await createSession(page, "Right");

  await page.goto("/?token=test-token");
  const checkbox = page.getByRole("checkbox", { name: "Include Right in split" });
  await checkbox.click();

  await expect(checkbox).toBeChecked();
  await expect(checkbox).toHaveCSS("background-color", "rgb(96, 165, 250)");
  await expect(page.getByLabel("Right terminal", { exact: true })).toBeVisible();
});

test("command-selects terminal panes and keeps one active pane on mobile", async ({ page }) => {
  await clearSessions(page);
  const first = await createSession(page, "Left");
  const second = await createSession(page, "Right");

  await page.goto("/?token=test-token");
  await page.getByRole("button", { name: "Select Right" }).click({ modifiers: ["Meta"] });
  await expect(page.locator(".terminal-pane")).toHaveCount(2);
  await expect(page.getByLabel("Left terminal")).toBeVisible();
  await expect(page.getByLabel("Right terminal")).toBeVisible();
  const paneState = await page.evaluate(() => {
    const parameters = new URLSearchParams(window.location.search);
    return {
      terminals: parameters.getAll("terminal"),
      focus: parameters.get("focus"),
    };
  });
  expect(paneState.terminals).toEqual([first.id, second.id]);
  expect(paneState.focus).toBe(second.id);

  await page.getByLabel("Left pane", { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`focus=${first.id}`));

  await page.reload();
  await expect(page.locator(".terminal-pane")).toHaveCount(2);
  await expect(page.getByLabel("Left pane")).toHaveAttribute("data-active", "true");
  const leftPane = page.getByLabel("Left pane");
  const rightPane = page.getByLabel("Right pane");
  await rightPane.locator(".xterm-helper-textarea").click();
  await page.keyboard.press("Control+B");
  await page.keyboard.press("h");
  await expect(leftPane).toHaveAttribute("data-active", "true");
  await expect(leftPane.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.press("Control+B");
  await page.keyboard.press("l");
  await expect(rightPane).toHaveAttribute("data-active", "true");
  await expect(rightPane.locator(".xterm-helper-textarea")).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.terminal-pane[data-active="true"]')).toBeVisible();
  await expect(page.locator('.terminal-pane[data-active="false"]')).toBeHidden();
});

test("persists sidebar controls, settings, and tmux-style commands", async ({ page }, testInfo) => {
  await clearSessions(page);
  const codex = await createSession(page, "Codex");
  const claude = await createSession(page, "Claude");
  await createSession(page, "Shell");
  await reportAgent(page, codex.id, "codex", "Review persistence");
  await reportAgent(page, claude.id, "claude", "Check shortcuts");

  await page.goto("/?token=test-token");
  const codexItem = page.getByRole("button", { name: "Select Codex" });
  const claudeItem = page.getByRole("button", { name: "Select Claude" });
  await expect(codexItem.getByRole("img", { name: "Codex" })).toBeVisible();
  await expect(claudeItem.getByRole("img", { name: "Claude" })).toBeVisible();
  await expect(codexItem).not.toContainText("Codex");
  await expect(codexItem).toContainText("~/work/euphony");
  await page.getByRole("checkbox", { name: "Include Claude in split" }).click();
  await expect(page.locator(".terminal-pane")).toHaveCount(2);
  await page.getByRole("button", { name: "Show only Terminal terminals" }).click();
  await expect(page.getByLabel("Shell terminal", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Codex terminal", { exact: true })).toHaveCount(0);
  await codexItem.click();

  const sidebar = page.locator(".desktop-sidebar");
  const separator = page.getByRole("separator", { name: "Resize sidebar" });
  const box = await separator.boundingBox();
  if (!box) throw new Error("Sidebar separator is not visible.");
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(420, box.y + 20);
  await page.mouse.up();
  await expect(sidebar).toHaveCSS("width", "420px");
  await page.reload();
  await expect(sidebar).toHaveCSS("width", "420px");

  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByLabel("Prefix").fill("Ctrl+A");
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+A");
  await expect(page.getByRole("status", { name: "Prefix commands" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("prefix-command-guide.png") });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("status", { name: "Prefix commands" })).toHaveCount(0);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("n");
  await expect(page.getByLabel("Claude terminal", { exact: true })).toBeVisible();
  const historyBeforeSplit = await readTerminalHistory(page, claude.id);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("v");
  await expect(page.locator(".terminal-pane")).toHaveCount(2);
  const historyAfterSplit = await readTerminalHistory(page, claude.id);
  expect(historyAfterSplit).toContain(historyBeforeSplit);
  expect(historyAfterSplit).not.toContain("1;2c");
  await expect(
    page.locator('.terminal-pane[data-active="true"] .xterm-helper-textarea'),
  ).toBeFocused();

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
});

async function readTerminalHistory(
  page: Page,
  sessionID: string,
): Promise<string> {
  return page.evaluate(async ({ id }) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/tickets`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      },
    });
    const { ticket } = (await response.json()) as { ticket: string };
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/api/sessions/${encodeURIComponent(id)}/terminal?ticket=${encodeURIComponent(ticket)}`,
    );
    return await new Promise<string>((resolve, reject) => {
      const output: number[] = [];
      const timeout = window.setTimeout(() => {
        socket.close();
        resolve(new TextDecoder().decode(Uint8Array.from(output)));
      }, 250);
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as { type: string; data?: string };
        if ((message.type === "output" || message.type === "history") && message.data) {
          const decoded = atob(message.data);
          for (let index = 0; index < decoded.length; index += 1) {
            output.push(decoded.charCodeAt(index));
          }
        }
      });
      socket.addEventListener("error", () => {
        window.clearTimeout(timeout);
        reject(new Error("terminal history WebSocket failed"));
      });
    });
  }, { id: sessionID });
}
