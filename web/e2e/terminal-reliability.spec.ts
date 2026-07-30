import { expect, test, type Page } from "@playwright/test";

type ResizeRecord = {
  sessionID: string;
  cols: number;
  rows: number;
  hostWidth: number;
  screenWidth: number;
};

async function clearSessions(page: Page) {
  await page.request.patch("/api/settings", {
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
      agentLogFontSize: 14,
    },
  });
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

  await clearSessions(page);
  await createSession(page, "Left");
  const claude = await createSession(page, "Claude");
  await page.goto("/?token=test-token");
  await page.getByRole("button", { name: "Select Claude" }).click();
  const terminal = page.getByLabel("Claude terminal", { exact: true });
  await expect(terminal).toBeVisible();
  await expect(page.locator(".terminal-view")).toHaveAttribute("data-connection", "connected");
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
    await expect(page.locator(".terminal-pane")).toHaveCount(2);
    await leftCheckbox.click();
    await expect(page.locator(".terminal-pane")).toHaveCount(1);
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
  await page.goto("/?token=test-token");
  await page.getByRole("button", { name: "Select Table" }).click();

  const terminal = page.getByLabel("Table terminal", { exact: true });
  await expect(page.locator(".terminal-view")).toHaveAttribute("data-connection", "connected");
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
  }
}
