import { expect, test, type Page } from "@playwright/test";

type ResizeRecord = {
  sessionID: string;
  cols: number;
  rows: number;
  hostWidth: number;
  screenWidth: number;
};

type ClientSizeMessage = {
  type: "resize" | "resize_release";
  cols?: number;
  rows?: number;
};

async function clearSessions(
  page: Page,
  options: { autoDeselectRunning?: boolean } = {},
) {
  const settingsResponse = await page.request.patch("/api/settings", {
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    },
    data: {
      prefix: "Ctrl+B",
      paneTabShortcut: "Meta+L",
      sidebarWidth: 304,
      sidebarCollapsed: false,
      interfaceFontSize: 16,
      terminalFontSize: 14,
      terminalFontFamily:
        'Menlo, Monaco, "Hiragino Sans", "Yu Gothic", "Noto Sans Mono CJK JP", monospace',
      agentLogFontSize: 14,
      terminalHistoryLimit: 1024 * 1024,
      autoSelectAttention: true,
      autoDeselectRunning: options.autoDeselectRunning ?? true,
      terminalLineHeight: 1.25,
      terminalCursorStyle: "bar",
      terminalCursorBlink: false,
      terminalScrollSensitivity: 3,
      terminalOptionAsAlt: true,
    },
  });
  expect(settingsResponse.ok()).toBe(true);
  const existing = await page.request.get("/api/sessions", {
    headers: { Authorization: "Bearer test-token" },
  });
  for (const session of (await existing.json()) as Array<{ id: string }>) {
    await page.request.delete(`/api/sessions/${session.id}`, {
      headers: { Authorization: "Bearer test-token" },
    });
  }
}

async function createSession(page: Page, name: string): Promise<{ id: string }> {
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

async function replaceSharedSelection(
  page: Page,
  terminalID: string,
) {
  const currentResponse = await page.request.get("/api/v1/selection", {
    headers: { Authorization: "Bearer test-token" },
  });
  expect(currentResponse.ok()).toBe(true);
  const current = await currentResponse.json() as {
    result: { revision: number };
  };
  const response = await page.request.put("/api/v1/selection", {
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    },
    data: {
      manualTerminalIds: [terminalID],
      pinnedTerminalIds: [],
      focusedTerminalId: terminalID,
      filters: { statuses: [], cwds: [] },
      pinnedFilters: { statuses: [], cwds: [] },
      expectedRevision: current.result.revision,
    },
  });
  expect(response.ok()).toBe(true);
}

async function readTerminalHistory(page: Page, sessionID: string): Promise<string> {
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

function visibleTerminalText(history: string): string {
  return history
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

async function terminalGrid(page: Page) {
  return page.locator(".terminal-view").evaluate((view) => ({
    localCols: Number(view.getAttribute("data-local-cols")),
    localRows: Number(view.getAttribute("data-local-rows")),
    sharedCols: Number(view.getAttribute("data-shared-cols")),
    sharedRows: Number(view.getAttribute("data-shared-rows")),
  }));
}

async function disableWebgl(page: Page) {
  await page.addInitScript(() => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: function (this: HTMLCanvasElement, contextID: string, ...args: unknown[]) {
        if (contextID === "webgl2") return null;
        return Reflect.apply(originalGetContext, this, [contextID, ...args]);
      },
    });
  });
}

test("renders a visible terminal cursor without an idle animation", async ({ page }) => {
  await clearSessions(page);
  await createSession(page, "Static cursor");
  await disableWebgl(page);
  await page.goto("/?token=test-token");

  const pane = page.getByLabel("Static cursor pane", { exact: true });
  const terminal = pane.getByLabel("Static cursor terminal", { exact: true });
  await expect(terminal).toBeVisible();
  await expect(pane.locator(".terminal-view")).toHaveAttribute("data-connection", "connected");
  await terminal.click();

  const cursor = page.locator(".xterm-cursor");
  await expect(cursor).toHaveCount(1);
  await expect(cursor).toBeVisible();
  await expect(cursor).toHaveClass(/xterm-cursor-bar/);
  await expect(cursor).not.toHaveClass(/xterm-cursor-blink/);
});

test("opens OSC 8 terminal links without a confirmation dialog", async ({ page }) => {
  await clearSessions(page);
  await createSession(page, "Link terminal");
  await disableWebgl(page);
  await page.goto("/?token=test-token");

  const terminal = page.getByLabel("Link terminal terminal", { exact: true });
  await expect(terminal).toBeVisible();
  await expect(page.locator(".terminal-view")).toHaveAttribute("data-connection", "connected");
  await terminal.click();
  await terminal.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(
    "printf '\\033]8;;https://example.com/docs\\033\\\\Example link\\033]8;;\\033\\\\\\n'",
  );
  await page.keyboard.press("Enter");

  const linkText = terminal
    .locator(".xterm-rows span")
    .filter({ hasText: "Example link" })
    .last();
  await expect(linkText).toBeVisible();
  let dialogSeen = false;
  const popups: Page[] = [];
  page.on("popup", (popup) => popups.push(popup));
  page.on("dialog", async (dialog) => {
    dialogSeen = true;
    await dialog.dismiss();
  });
  const popupPromise = page.waitForEvent("popup");
  await linkText.click({ force: true });
  const popup = await popupPromise;

  await expect.poll(() => popup.url()).toBe("https://example.com/docs");
  await expect.poll(() => popups.length).toBe(1);
  expect(dialogSeen).toBe(false);
});

test("keeps an opened terminal connection alive while switching sessions", async ({
  page,
}) => {
  await clearSessions(page);
  const first = await createSession(page, "First");
  await createSession(page, "Second");
  await replaceSharedSelection(page, first.id);

  let firstSocketCount = 0;
  page.on("websocket", (socket) => {
    if (socket.url().includes(`/api/sessions/${first.id}/terminal`)) {
      firstSocketCount += 1;
    }
  });

  await page.goto("/?token=test-token");
  const firstTerminal = page.getByLabel("First terminal", { exact: true });
  await expect(firstTerminal).toBeVisible();
  await expect(page.locator(".terminal-view")).toHaveAttribute(
    "data-connection",
    "connected",
  );
  await expect.poll(() => firstSocketCount).toBe(1);

  await page.getByRole("button", { name: "Select Second" }).click();
  await expect(page.getByLabel("Second terminal", { exact: true })).toBeVisible();
  await expect(firstTerminal).toBeHidden();
  const firstPane = page.getByLabel("First pane", { exact: true });
  await expect(firstPane).toHaveAttribute("data-cached", "true");
  await expect(firstPane).not.toHaveAttribute("hidden");
  await expect(firstPane).toHaveAttribute("inert");
  await expect(firstPane).toHaveCSS("display", "block");
  await expect(firstPane).toHaveCSS("visibility", "hidden");
  expect(await firstTerminal.evaluate((host) => host.getBoundingClientRect().width))
    .toBeGreaterThan(0);

  await page.getByRole("button", { name: "Select First" }).click();
  await expect(firstTerminal).toBeVisible();
  expect(firstSocketCount).toBe(1);
});
test("shares the smallest terminal size across differently sized browsers", async ({
  browser,
  page,
}) => {
  await clearSessions(page);
  const sharedTerminal = await createSession(page, "Shared terminal");
  await replaceSharedSelection(page, sharedTerminal.id);

  const smallContext = await browser.newContext({
    viewport: { width: 900, height: 600 },
  });
  const largeContext = await browser.newContext({
    viewport: { width: 1400, height: 900 },
  });
  const smallPage = await smallContext.newPage();
  const largePage = await largeContext.newPage();
  try {
    await Promise.all([
      smallPage.goto("/?token=test-token"),
      largePage.goto("/?token=test-token"),
    ]);
    for (const attachedPage of [smallPage, largePage]) {
      await expect(attachedPage.locator(".terminal-view")).toHaveAttribute(
        "data-connection",
        "connected",
      );
      await expect(attachedPage.locator(".terminal-view")).toHaveAttribute(
        "data-shared-cols",
        /^\d+$/,
      );
      await expect(attachedPage.locator(".terminal-view")).toHaveAttribute(
        "data-shared-rows",
        /^\d+$/,
      );
    }

    await expect.poll(async () => {
      const [small, large] = await Promise.all([
        terminalGrid(smallPage),
        terminalGrid(largePage),
      ]);
      const expectedCols = Math.min(small.localCols, large.localCols);
      const expectedRows = Math.min(small.localRows, large.localRows);
      return (
        small.sharedCols === expectedCols &&
        large.sharedCols === expectedCols &&
        small.sharedRows === expectedRows &&
        large.sharedRows === expectedRows
      );
    }).toBe(true);

    const [smallGrid, largeGrid] = await Promise.all([
      terminalGrid(smallPage),
      terminalGrid(largePage),
    ]);
    expect(largeGrid.localCols).toBeGreaterThan(smallGrid.localCols);
    expect(largeGrid.localRows).toBeGreaterThan(smallGrid.localRows);
    const largeHost = largePage.getByLabel("Shared terminal terminal", {
      exact: true,
    });
    await expect(largeHost).toHaveAttribute("data-centered", "true");
    const centeredBounds = await largeHost.evaluate((host) => {
      const terminal = host.querySelector<HTMLElement>(".xterm");
      const hostBounds = host.getBoundingClientRect();
      const terminalBounds = terminal?.getBoundingClientRect();
      return terminalBounds
        ? {
            horizontal:
              Math.abs(
                terminalBounds.left -
                  hostBounds.left -
                  (hostBounds.width - terminalBounds.width) / 2,
              ),
            vertical:
              Math.abs(
                terminalBounds.top -
                  hostBounds.top -
                  (hostBounds.height - terminalBounds.height) / 2,
              ),
          }
        : null;
    });
    expect(centeredBounds).not.toBeNull();
    expect(centeredBounds!.horizontal).toBeLessThanOrEqual(1);
    expect(centeredBounds!.vertical).toBeLessThanOrEqual(1);

    await smallContext.close();
    await expect.poll(async () => {
      const grid = await terminalGrid(largePage);
      return (
        grid.sharedCols === grid.localCols &&
        grid.sharedRows === grid.localRows
      );
    }).toBe(true);
    await expect(largeHost).not.toHaveAttribute("data-centered");
  } finally {
    await smallContext.close().catch(() => undefined);
    await largeContext.close();
  }
});

test("keeps the shared terminal size stable while a browser views agent logs", async ({
  browser,
  page,
}) => {
  await clearSessions(page);
  const sharedTerminal = await createSession(page, "Shared source");
  await replaceSharedSelection(page, sharedTerminal.id);

  const narrowContext = await browser.newContext({
    viewport: { width: 900, height: 900 },
  });
  const shortContext = await browser.newContext({
    viewport: { width: 1400, height: 600 },
  });
  const narrowPage = await narrowContext.newPage();
  const shortPage = await shortContext.newPage();
  await shortPage.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const messages: ClientSizeMessage[] = [];
    Object.defineProperty(window, "__euphonyClientSizeMessages", {
      value: messages,
    });

    class RecordingWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const nativeSend = this.send.bind(this);
        this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
          if (typeof data === "string") {
            const message = JSON.parse(data) as ClientSizeMessage;
            if (message.type === "resize" || message.type === "resize_release") {
              messages.push(message);
            }
          }
          nativeSend(data);
        };
      }
    }

    Object.defineProperty(window, "WebSocket", { value: RecordingWebSocket });
  });
  try {
    await Promise.all([
      narrowPage.goto("/?token=test-token"),
      shortPage.goto("/?token=test-token"),
    ]);
    for (const attachedPage of [narrowPage, shortPage]) {
      await expect(attachedPage.locator(".terminal-view")).toHaveAttribute(
        "data-connection",
        "connected",
      );
    }

    await expect.poll(async () => {
      const [narrow, short] = await Promise.all([
        terminalGrid(narrowPage),
        terminalGrid(shortPage),
      ]);
      const expectedCols = Math.min(narrow.localCols, short.localCols);
      const expectedRows = Math.min(narrow.localRows, short.localRows);
      return (
        expectedCols > 0 &&
        expectedRows > 0 &&
        narrow.sharedCols === expectedCols &&
        short.sharedCols === expectedCols &&
        narrow.sharedRows === expectedRows &&
        short.sharedRows === expectedRows
      );
    }).toBe(true);

    const [narrowBefore, shortBefore] = await Promise.all([
      terminalGrid(narrowPage),
      terminalGrid(shortPage),
    ]);
    expect(narrowBefore.localCols).toBeLessThan(shortBefore.localCols);
    expect(narrowBefore.localRows).toBeGreaterThan(shortBefore.localRows);
    expect(narrowBefore.sharedCols).toBe(narrowBefore.localCols);
    expect(narrowBefore.sharedRows).toBe(shortBefore.localRows);
    await shortPage.evaluate(() => {
      window.__euphonyClientSizeMessages.length = 0;
    });

    await shortPage.getByRole("tab", { name: "Agent log" }).click();
    await expect(shortPage.getByRole("tab", { name: "Agent log" })).toHaveAttribute(
      "data-active",
    );
    await expect.poll(() => terminalGrid(narrowPage)).toEqual(narrowBefore);

    await shortPage.getByRole("tab", { name: "Terminal" }).click();
    await expect(shortPage.getByRole("tab", { name: "Terminal" })).toHaveAttribute(
      "data-active",
    );
    await expect.poll(() => terminalGrid(shortPage)).toEqual(shortBefore);
    // TerminalView remeasures 50ms after the source layout changes. Wait past
    // that boundary so a delayed resize cannot escape the message assertion.
    await shortPage.waitForTimeout(100);
    expect(
      await shortPage.evaluate(() => window.__euphonyClientSizeMessages),
    ).toEqual([]);
  } finally {
    await narrowContext.close();
    await shortContext.close();
  }
});

test("keeps a running Claude terminal fitted across repeated pane changes", async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const records: ResizeRecord[] = [];
    Object.defineProperty(window, "__euphonyResizeRecords", { value: records });

    class RecordingWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const match = String(url).match(/\/api\/sessions\/([^/]+)\/terminal/);
        const sessionID = match ? decodeURIComponent(match[1]) : "";
        const nativeSend = this.send.bind(this);
        this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
          if (typeof data === "string") {
            const message = JSON.parse(data) as { type?: string; cols?: number; rows?: number };
            if (message.type === "resize" && message.cols && message.rows) {
              const host = document.querySelector('[aria-label="Claude terminal"]');
              records.push({
                sessionID,
                cols: message.cols,
                rows: message.rows,
                hostWidth: host?.getBoundingClientRect().width ?? 0,
                screenWidth:
                  host?.querySelector(".xterm-screen")?.getBoundingClientRect().width ?? 0,
              });
            }
          }
          nativeSend(data);
        };
      }
    }

    Object.defineProperty(window, "WebSocket", { value: RecordingWebSocket });
  });

  await clearSessions(page, { autoDeselectRunning: false });
  await createSession(page, "Left");
  const claude = await createSession(page, "Claude");
  await page.goto("/?token=test-token");
  await page.getByRole("button", { name: "Select Claude" }).click();
  const pane = page.getByLabel("Claude pane", { exact: true });
  const terminal = pane.getByLabel("Claude terminal", { exact: true });
  await expect(terminal).toBeVisible();
  await expect(pane.locator(".terminal-view")).toHaveAttribute("data-connection", "connected");
  await terminal.click();
  await page.keyboard.type("claude");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => visibleTerminalText(await readTerminalHistory(page, claude.id)), {
      timeout: 15_000,
    })
    .toMatch(/Claude\s*Code|Not\s*logged\s*in|Welcome\s*back/i);

  const leftCheckbox = page.getByRole("checkbox", { name: "Include Left in split" });
  for (let iteration = 0; iteration < 30; iteration += 1) {
    await leftCheckbox.click();
    await expect(page.locator('.terminal-pane[data-visible="true"]')).toHaveCount(2);
    await leftCheckbox.click();
    await expect(page.locator('.terminal-pane[data-visible="true"]')).toHaveCount(1);
  }

  const result = await page.evaluate((sessionID) => {
    const records = (
      window as typeof window & { __euphonyResizeRecords: ResizeRecord[] }
    ).__euphonyResizeRecords.filter((record) => record.sessionID === sessionID);
    const host = document.querySelector('[aria-label="Claude terminal"]');
    const screen = host?.querySelector(".xterm-screen");
    return {
      records,
      hostWidth: host?.getBoundingClientRect().width ?? 0,
      screenWidth: screen?.getBoundingClientRect().width ?? 0,
      text: screen?.textContent ?? "",
    };
  }, claude.id);

  expect(result.records.length).toBeGreaterThan(30);
  expect(Math.min(...result.records.map((record) => record.cols))).toBeGreaterThan(20);
  expect(result.screenWidth).toBeLessThanOrEqual(result.hostWidth);
});

test("keeps table columns aligned for full-width Japanese punctuation", async ({ page }) => {
  await clearSessions(page);
  await createSession(page, "Table");
  await disableWebgl(page);
  await page.goto("/?token=test-token");
  await page.getByRole("button", { name: "Select Table" }).click();

  const pane = page.getByLabel("Table pane", { exact: true });
  const terminal = pane.getByLabel("Table terminal", { exact: true });
  await expect(pane.locator(".terminal-view")).toHaveAttribute("data-connection", "connected");
  await terminal.click();
  await page.keyboard.insertText(
    'printf "%s\\n" "│ 漢字 │ aa │" "│ （） │ aa │" "│ 、。 │ aa │" "│ ＡＢ │ aa │"',
  );
  await page.keyboard.press("Enter");

  const expectedRows = [
    "│ 漢字 │ aa │",
    "│ （） │ aa │",
    "│ 、。 │ aa │",
    "│ ＡＢ │ aa │",
  ];
  const readFollowingColumnPositions = () =>
    terminal.evaluate((host, rows) => {
      const renderedRows = [...host.querySelectorAll<HTMLElement>(".xterm-rows > div")];
      return rows.map((expectedRow) => {
        const renderedRow = renderedRows.find((row) => row.textContent === expectedRow);
        const followingColumns = renderedRow
          ? [...renderedRow.querySelectorAll<HTMLElement>("span")].find((span) =>
              span.textContent?.startsWith(" │ aa │")
            )
          : undefined;
        return followingColumns?.getBoundingClientRect().left ?? null;
      });
    }, expectedRows);
  await expect
    .poll(readFollowingColumnPositions)
    .toEqual(expectedRows.map(() => expect.any(Number)));

  const positions = await readFollowingColumnPositions() as number[];
  expect(Math.max(...positions) - Math.min(...positions)).toBeLessThanOrEqual(0.1);
});

declare global {
  interface Window {
    __euphonyResizeRecords: ResizeRecord[];
    __euphonyClientSizeMessages: ClientSizeMessage[];
  }
}
