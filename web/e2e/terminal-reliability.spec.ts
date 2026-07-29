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
    data: { prefix: "Ctrl+B", sidebarWidth: 304, sidebarCollapsed: false },
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
  await terminal.click();
  await page.keyboard.type("claude");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);

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

declare global {
  interface Window {
    __euphonyResizeRecords: ResizeRecord[];
  }
}
