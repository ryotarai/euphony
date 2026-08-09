import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const requestedPort = process.env.EUPHONY_E2E_PORT;
const e2ePort = requestedPort && /^\d+$/.test(requestedPort) ? requestedPort : "18080";
const claudeConfigDir = `/tmp/euphony-e2e-${e2ePort}-claude`;
const execFileAsync = promisify(execFile);

async function runGit(repo: string, ...args: string[]) {
  await execFileAsync("git", ["-C", repo, ...args]);
}

async function clearSessions(page: Page) {
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
  const existingSessions = (await existing.json()) as Array<{ id: string }>;
  for (const session of existingSessions) {
    await page.request.delete(`/api/sessions/${session.id}`, {
      headers: { Authorization: "Bearer test-token" },
    });
  }
  await replaceSharedSelection(page, []);
}

async function clearTasks(page: Page) {
  const response = await page.request.get("/api/tasks", {
    headers: { Authorization: "Bearer test-token" },
  });
  expect(response.ok()).toBe(true);
  const existing = (await response.json() as Array<{ id: string }> | null) ?? [];
  for (const task of existing) {
    await page.request.delete(`/api/tasks/${task.id}`, {
      headers: { Authorization: "Bearer test-token" },
    });
  }
}

async function replaceSharedSelection(
  page: Page,
  terminalIDs: string[],
  focusedTerminalID?: string,
  statusFilters: string[] = [],
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
      manualTerminalIds: terminalIDs,
      pinnedTerminalIds: [],
      ...(focusedTerminalID ? { focusedTerminalId: focusedTerminalID } : {}),
      filters: { statuses: statusFilters, cwds: [] },
      pinnedFilters: { statuses: [], cwds: [] },
      expectedRevision: current.result.revision,
    },
  });
  expect(response.ok()).toBe(true);
}

async function reportAgent(
  page: Page,
  terminalID: string,
  agent: "codex" | "claude",
  title: string,
  status = "waiting",
) {
  const response = await page.request.post("/api/hooks/terminal", {
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    },
    data: {
      terminalId: terminalID,
      agent,
      status,
      title,
      cwd: "/Users/ryotarai/work/euphony",
    },
  });
  if (!response.ok()) {
    throw new Error(
      `Agent report failed (${response.status()}): ${await response.text()}`,
    );
  }
}

async function createSession(
  page: Page,
  name: string,
  cwd?: string,
): Promise<{ id: string; name: string; processName?: string }> {
  const response = await page.request.post("/api/sessions", {
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    },
    data: { name, ...(cwd ? { cwd } : {}) },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

function claudeTranscriptLine(index: number) {
  const label = `Agent log entry ${String(index).padStart(2, "0")}`;
  const table = index === 40
    ? "\n\n| Command | State | Artifact |\n| --- | --- | --- |\n| go test ./... | Passed | `very-wide-unbroken-table-value-that-stays-readable-with-horizontal-scrolling-0123456789` |"
    : "";
  const diagram = index === 40
    ? "\n\n```mermaid\nflowchart LR\n  Plan[Plan] --> Build[Build]\n  Build --> Verify[Verify]\n```"
    : "";
  return JSON.stringify({
    type: "assistant",
    timestamp: `2026-07-30T01:${String(index).padStart(2, "0")}:00Z`,
    message: {
      role: "assistant",
      content: [{
        type: "text",
        text: `## ${label}\n\n${"Readable transcript content. ".repeat(12)}${table}${diagram}`,
      }],
    },
  }) + "\n";
}

function claudeToolTranscriptLines() {
  return Array.from({ length: 3 }, (_, index) => {
    const callID = `tool-${index + 1}`;
    return [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-30T03:00:00Z",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: callID,
            name: "exec_command",
            input: { command: `secret command ${index + 1}` },
          }],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-30T03:00:01Z",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: callID,
            content: `secret result ${index + 1}`,
          }],
        },
      }),
    ].join("\n") + "\n";
  }).join("");
}

test("opens from a development token URL and immediately scrubs it", async ({ page }) => {
  await clearSessions(page);
  await page.goto("/?token=test-token");

  await expect(page.getByLabel("Terminal terminal", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Access token")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("token")).toBe(false);
  expect(await page.evaluate(() => sessionStorage.getItem("euphony.token"))).toBe("test-token");
});

test("renames the focused terminal from Quick Actions and updates the sidebar", async ({
  page,
}) => {
  await clearSessions(page);
  const terminal = await createSession(page, "Terminal", "/tmp");
  await replaceSharedSelection(page, [terminal.id], terminal.id);
  await page.goto("/?token=test-token");

  await expect(page.getByRole("button", { name: "Select Terminal" })).toBeVisible();
  await page.keyboard.press("Meta+k");
  await page.getByRole("option", { name: /^Rename terminal/ }).click();

  const renameDialog = page.getByRole("dialog", { name: "Rename terminal" });
  await expect(renameDialog).toBeVisible();
  const nameInput = renameDialog.getByLabel("Terminal name");
  await expect(nameInput).toHaveValue("Terminal");
  await expect(nameInput).toBeFocused();
  await nameInput.fill("Build shell");
  await renameDialog.getByRole("button", { name: "Rename terminal" }).click();

  await expect(page.getByRole("button", { name: "Select Build shell" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Select Terminal" })).toHaveCount(0);
});

test("follows the previous terminal when the focused shell exits", async ({ page }) => {
  await clearSessions(page);
  await createSession(page, "First", "/tmp");
  const second = await createSession(page, "Second", "/tmp");
  const last = await createSession(page, "Last", "/tmp");
  await replaceSharedSelection(page, [last.id], last.id);
  await page.goto("/?token=test-token");

  await expect(page.getByLabel("Last terminal", { exact: true })).toBeVisible();
  const runResponse = await page.request.post(
    `/api/v1/terminals/${last.id}/run`,
    {
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      },
      data: { command: "exit" },
    },
  );
  expect(runResponse.ok()).toBe(true);

  await expect(page.getByLabel("Second terminal", { exact: true })).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.getByLabel("Last terminal", { exact: true })).toHaveCount(0);
  await expect(page.getByText("No signal yet.", { exact: true })).toHaveCount(0);
  const selectionResponse = await page.request.get("/api/v1/selection", {
    headers: { Authorization: "Bearer test-token" },
  });
  expect(selectionResponse.ok()).toBe(true);
  const selectionEnvelope = await selectionResponse.json() as {
    result: { focusedTerminalId: string };
  };
  expect(selectionEnvelope.result.focusedTerminalId).toBe(second.id);
});

test("renders a cwd-first tree and creates a terminal from its cwd", async ({
  page,
}, testInfo) => {
  await clearSessions(page);
  const shell = await createSession(page, "Shell", "/tmp");
  await createSession(page, "Project", "/Users/ryotarai/work/euphony");
  await page.goto("/?token=test-token");

  await expect(page.getByRole("heading", { name: "/tmp" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "~/work/euphony" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Terminal" })).toHaveCount(2);
  expect(shell.processName).toBeTruthy();
  await expect(
    page
      .getByRole("button", { name: "Select Shell" })
      .getByText(shell.processName!, { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("img", { name: "Codex" })).toHaveCount(0);
  await expect(page.getByRole("img", { name: "Claude" })).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", { name: /Show all .* terminals/ }),
  ).toHaveCount(0);
  await expect(page.getByText("No terminal", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("cwd-sidebar-tree.png") });

  await page.getByRole("button", { name: "Create terminal in /tmp" }).click();
  const createdTerminal = page.getByRole("button", { name: "Select Terminal" });
  await expect(createdTerminal).toBeVisible();
  await expect(createdTerminal).toHaveAttribute("title", "/tmp");
  await expect.poll(async () => {
    const response = await page.request.get("/api/sessions", {
      headers: { Authorization: "Bearer test-token" },
    });
    const sessions = (await response.json()) as Array<{
      name: string;
      cwd: string;
    }>;
    return sessions.find((session) => session.name === "Terminal")?.cwd;
  }).toBe("/tmp");
});

test("opens the Inbox and follows a summarized agent", async ({ page }) => {
  await clearSessions(page);
  const agent = await createSession(page, "Needs approval", "/tmp");
  await replaceSharedSelection(page, [agent.id], agent.id);
  await reportAgent(page, agent.id, "claude", "Needs approval", "waiting");
  await page.route("**/api/v1/events", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: "",
    });
  });
  await page.route("**/api/agent-summaries", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{
        terminalId: agent.id,
        provider: "claude",
        status: "waiting",
        summary: "The agent is waiting for approval.",
        action: "Approve the requested change.",
        priority: "high",
        generatedAt: "2026-08-05T00:00:00Z",
        unread: true,
        done: false,
      }]),
    });
  });
  await page.route(`**/api/agent-summaries/${agent.id}/read`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        terminalId: agent.id,
        provider: "claude",
        status: "waiting",
        summary: "The agent is waiting for approval.",
        action: "Approve the requested change.",
        priority: "high",
        generatedAt: "2026-08-05T00:00:00Z",
        unread: false,
        done: false,
      }),
    });
  });
  await page.route(`**/api/agent-summaries/${agent.id}/done`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        terminalId: agent.id,
        provider: "claude",
        status: "waiting",
        summary: "The agent is waiting for approval.",
        action: "Approve the requested change.",
        priority: "high",
        generatedAt: "2026-08-05T00:00:00Z",
        unread: false,
        done: true,
      }),
    });
  });
  await page.goto("/?token=test-token");

  await expect(page.getByLabel("Needs approval terminal", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Inbox" }).click();
  await expect(page.getByRole("heading", { name: "Needs your action" })).toBeVisible();
  await expect(page.getByText("The agent is waiting for approval.", { exact: true })).toBeVisible();
  await expect(page.getByText("Approve the requested change.", { exact: true })).toBeVisible();
  await expect(page.getByTestId("agent-summary-priority")).toHaveAttribute("data-priority", "high");
  await expect(page).toHaveURL(/\/inbox\/[^/?#]+/);

  await page.getByRole("button", { name: "Open Needs approval" }).click();
  await expect(page.getByRole("region", { name: "Selected Inbox item" })).toBeVisible();
  await page.getByRole("button", { name: "Open terminal" }).click();
  await expect(page.getByLabel("Needs approval terminal", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Action required" })).toHaveCount(0);

  await page.getByRole("button", { name: "Inbox" }).click();
  await page.getByRole("button", { name: "Mark Needs approval as done" }).click();
  await expect(page.getByRole("tab", { name: "Done 1" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("The agent is waiting for approval.", { exact: true })).toBeVisible();
});

test("locks the terminal while an Inbox choice is resolved", async ({ page }) => {
  await clearSessions(page);
  const agent = await createSession(page, "Needs approval", "/tmp");
  await replaceSharedSelection(page, [agent.id], agent.id);
  await reportAgent(page, agent.id, "claude", "Needs approval", "waiting");
  await page.route("**/api/v1/events", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: "",
    });
  });
  await page.route("**/api/agent-summaries", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{
        terminalId: agent.id,
        provider: "claude",
        status: "waiting",
        summary: "The agent is waiting for approval.",
        action: "Approve the requested change.",
        priority: "high",
        options: [{ id: "option-1", label: "Allow access" }],
        generatedAt: "2026-08-05T00:00:00Z",
        unread: true,
        done: false,
      }]),
    });
  });
  let releaseExecute: (() => void) | undefined;
  const executePending = new Promise<void>((resolve) => {
    releaseExecute = resolve;
  });
  await page.route(`**/api/agent-summaries/${agent.id}/options/option-1/execute`, async (route) => {
    await executePending;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        terminalId: agent.id,
        provider: "claude",
        status: "waiting",
        summary: "The agent is waiting for approval.",
        action: "Approve the requested change.",
        priority: "high",
        options: [{ id: "option-1", label: "Allow access" }],
        generatedAt: "2026-08-05T00:00:00Z",
        unread: false,
        done: true,
      }),
    });
  });
  await page.goto("/?token=test-token");

  await expect(page.getByLabel("Needs approval terminal", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Inbox" }).click();
  await page.getByRole("button", { name: "Allow access" }).click();
  await expect(page.locator('.terminal-view[data-locked="true"]')).toHaveCount(1);
  await expect(page.locator('.terminal-view[data-locked="true"] .terminal-automation-lock')).toHaveCount(1);

  releaseExecute?.();
  await expect(page.getByRole("tab", { name: "Done 1" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('.terminal-view[data-locked="true"]')).toHaveCount(0);
});

test("treats dashboard panes like terminals and supports split checkboxes", async ({ page }) => {
  await clearSessions(page);
  await createSession(page, "Terminal", "/tmp");
  await page.goto("/?token=test-token");

  await expect(page.getByLabel("Terminal terminal", { exact: true })).toBeVisible();
  const tasksCheckbox = page.getByRole("checkbox", { name: "Include Tasks in split" });
  await page.getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
  await expect(tasksCheckbox).toBeChecked();

  await page.getByRole("button", { name: "Select Terminal" }).click();
  await expect(page.getByRole("heading", { name: "Tasks" })).toHaveCount(0);
  await expect(page.getByLabel("Terminal terminal", { exact: true })).toBeVisible();

  await tasksCheckbox.click();
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
  await expect(page.getByLabel("Terminal terminal", { exact: true })).toBeVisible();
  await expect(tasksCheckbox).toBeChecked();
});

test("creates, refines, starts, and communicates through a task", async ({ page }) => {
  await clearSessions(page);
  await clearTasks(page);
  const terminal = await createSession(page, "Task agent", "/tmp");
  await replaceSharedSelection(page, [terminal.id], terminal.id);
  await page.goto("/?token=test-token");

  await page.getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("Title").fill("Document the task workflow");
  await dialog.getByLabel("Description").fill("Capture the create, refine, start, and communicate flow.");
  await dialog.getByLabel("Priority").selectOption("high");
  await dialog.getByRole("button", { name: "Create task" }).click();

  await expect(page.getByText("Document the task workflow", { exact: true })).toBeVisible();
  const taskResponse = await page.request.get("/api/tasks", {
    headers: { Authorization: "Bearer test-token" },
  });
  expect(taskResponse.ok()).toBe(true);
  const [createdTask] = await taskResponse.json() as Array<{
    id: string;
    title: string;
    description: string;
    priority: "low" | "medium" | "high";
    status: "todo" | "in_progress" | "blocked" | "done";
    updates: Array<unknown>;
  }>;
  expect(createdTask.title).toBe("Document the task workflow");
  await expect(page).toHaveURL(new RegExp(`/tasks/${createdTask.id}`));

  await page.route("**/api/tasks/*/refine", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: "Document the complete task workflow",
        description: "Explain how a user creates, refines, starts, and communicates with an agent.",
        priority: "high",
        status: "todo",
        rationale: "The outcome and workflow are now explicit.",
      }),
    });
  });
  await page.getByRole("button", { name: "Refine with AI" }).click();
  await expect(page.getByRole("region", { name: "AI refinement proposal" })).toContainText(
    "Document the complete task workflow",
  );
  await page.getByRole("button", { name: "Apply refinement" }).click();
  await expect(page.getByLabel("Title")).toHaveValue("Document the complete task workflow");

  const startedTask = {
    ...createdTask,
    title: "Document the complete task workflow",
    description: "Explain how a user creates, refines, starts, and communicates with an agent.",
    terminalId: terminal.id,
    agent: "codex",
    status: "in_progress" as const,
    updates: [{
      id: "task-started",
      taskId: createdTask.id,
      terminalId: terminal.id,
      kind: "system",
      body: "Started codex agent.",
      createdAt: "2026-08-05T00:01:00Z",
    }],
  };
  await page.route(`**/api/tasks/${createdTask.id}/start`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(startedTask),
    });
  });
  await page.getByRole("button", { name: "Start agent" }).click();
  await expect(page.getByText("Started codex agent.", { exact: true })).toBeVisible();

  const communicatedTask = {
    ...startedTask,
    updates: [...startedTask.updates, {
      id: "task-instruction",
      taskId: createdTask.id,
      terminalId: terminal.id,
      kind: "user_instruction",
      body: "Run the task tests and report the result.",
      createdAt: "2026-08-05T00:02:00Z",
    }],
  };
  await page.route(`**/api/tasks/${createdTask.id}/prompt`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(communicatedTask),
    });
  });
  await page.getByLabel("Instruction for agent").fill("Run the task tests and report the result.");
  await page.getByRole("button", { name: "Send instruction" }).click();
  await expect(page.getByText("Run the task tests and report the result.", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Open terminal" }).click();
  await expect(page.getByLabel("Task agent terminal", { exact: true })).toBeVisible();
});

test("keeps sidebar actions visible while the terminal tree scrolls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await clearSessions(page);
  for (let index = 0; index < 30; index += 1) {
    await createSession(page, `Overflow terminal ${index + 1}`, "/tmp");
  }
  await page.goto("/?token=test-token");

  const tree = page.locator('[data-slot="sidebar-content"]');
  const footer = page.locator('[data-slot="sidebar-footer"]');
  const layout = await tree.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  const footerBox = await footer.boundingBox();

  expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
  expect(footerBox).not.toBeNull();
  expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(720);
  await expect(tree).toHaveAttribute("data-overflow-bottom", "true");

  await tree.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect(tree).not.toHaveAttribute("data-overflow-bottom");
});

test("shows the overflow fade when the mobile terminal drawer opens", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await clearSessions(page);
  for (let index = 0; index < 30; index += 1) {
    await createSession(page, `Mobile overflow terminal ${index + 1}`, "/tmp");
  }
  await page.goto("/?token=test-token");

  await page.getByRole("button", { name: "Open terminal menu" }).click();
  const drawer = page.getByRole("dialog", { name: "Terminal menu" });
  const tree = drawer.locator('[data-slot="sidebar-content"]');
  const footerBox = await drawer
    .locator('[data-slot="sidebar-footer"]')
    .boundingBox();

  await expect(tree).toHaveAttribute("data-overflow-bottom", "true");
  expect(footerBox).not.toBeNull();
  expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(720);

  await tree.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect(tree).not.toHaveAttribute("data-overflow-bottom");

  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await page.getByRole("button", { name: "Open terminal menu" }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Terminal menu" })
      .locator('[data-slot="sidebar-content"]'),
  ).toHaveAttribute("data-overflow-bottom", "true");
});

test("marks a blocked terminal with a blue attention dot", async ({ page }) => {
  await clearSessions(page);
  await createSession(page, "Focused");
  const blocked = await createSession(page, "Permission request");
  await reportAgent(page, blocked.id, "codex", "Review changes", "running");
  await page.goto("/?token=test-token");
  await expect(page.getByText("Review changes", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Select Permission request" })
    .click({ modifiers: ["Meta"] });
  await page.getByLabel("Focused pane", { exact: true }).click();

  await reportAgent(page, blocked.id, "codex", "Review changes", "blocked");

  const blockedButton = page.getByRole("button", {
    name: "Select Permission request",
  });
  await expect(blockedButton.getByRole("img", { name: "Blocked" })).toBeVisible();
  const attentionDot = blockedButton.locator(".attention-dot");
  await expect(blockedButton).toHaveAccessibleDescription("Needs attention");
  await expect(attentionDot).toBeVisible();
  await expect(attentionDot).toHaveAttribute("aria-hidden", "true");
  await expect(attentionDot).toHaveCSS("width", "6px");
  await expect(attentionDot).toHaveCSS("height", "6px");
  await expect(attentionDot).toHaveCSS("border-radius", "50%");
  await expect(attentionDot).toHaveCSS("background-color", "rgb(56, 189, 248)");
  const paneAttentionDot = page.locator(
    ".pane-attention-indicator .attention-dot",
  );
  await expect(paneAttentionDot).toHaveCSS("width", "6px");
  await expect(paneAttentionDot).toHaveCSS("height", "6px");
  await expect(paneAttentionDot).toHaveCSS("border-radius", "50%");
  await expect(paneAttentionDot).toHaveCSS(
    "background-color",
    "rgb(56, 189, 248)",
  );
});

test("confirms before deleting a terminal", async ({ page }) => {
  await clearSessions(page);
  const terminal = await createSession(page, "Disposable");
  await page.goto("/?token=test-token");

  await page.getByRole("button", { name: "Delete Disposable" }).click();

  const dialog = page.getByRole("dialog", { name: "Delete terminal?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("“Disposable” will be stopped");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();

  await dialog.getByRole("button", { name: "Cancel" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete Disposable" })).toBeVisible();

  await page.getByRole("button", { name: "Delete Disposable" }).click();
  await page
    .getByRole("dialog", { name: "Delete terminal?" })
    .getByRole("button", { name: "Delete terminal" })
    .click();

  await expect(page.getByRole("button", { name: "Delete Disposable" })).toHaveCount(0);
  await expect.poll(async () => {
    const response = await page.request.get("/api/sessions", {
      headers: { Authorization: "Bearer test-token" },
    });
    const sessions = (await response.json()) as Array<{ id: string }>;
    return sessions.some((session) => session.id === terminal.id);
  }).toBe(false);
});

test("centers the delete action within its terminal row", async ({ page }) => {
  await clearSessions(page);
  await createSession(page, "Alignment check", "/tmp");
  await page.goto("/?token=test-token");

  const row = page.locator(".session-channel").filter({
    has: page.getByRole("button", { name: "Select Alignment check" }),
  });
  const deleteButton = row.getByRole("button", { name: "Delete Alignment check" });
  const rowBox = await row.boundingBox();
  const deleteBox = await deleteButton.boundingBox();

  expect(rowBox).not.toBeNull();
  expect(deleteBox).not.toBeNull();
  const rowCenter = rowBox!.y + rowBox!.height / 2;
  const deleteCenter = deleteBox!.y + deleteBox!.height / 2;
  expect(Math.abs(deleteCenter - rowCenter)).toBeLessThanOrEqual(1);
});

test("shows a live agent transcript and releases follow when the reader scrolls away", async ({
  page,
}, testInfo) => {
  await clearSessions(page);
  const terminal = await createSession(page, "Log stream", "/tmp");
  const sessionID = `e2e-${terminal.id}`;
  const transcriptPath = `${claudeConfigDir}/projects/euphony/${sessionID}.jsonl`;
  await mkdir(`${claudeConfigDir}/projects/euphony`, { recursive: true });
  await writeFile(
    transcriptPath,
    Array.from({ length: 105 }, (_, index) => claudeTranscriptLine(index + 1)).join("") +
      claudeToolTranscriptLines(),
  );
  const hook = await page.request.post("/api/hooks/terminal", {
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    },
    data: {
      terminalId: terminal.id,
      agent: "claude",
      agentSessionId: sessionID,
      agentTranscriptPath: transcriptPath,
      status: "waiting",
      title: "Live transcript",
      cwd: "/tmp",
    },
  });
  expect(hook.ok()).toBe(true);

  await page.goto("/?token=test-token");
  await page.getByRole("tab", { name: "Agent log" }).click();
  const viewport = page.locator('[data-slot="message-scroller-viewport"]');
  await expect(page.getByRole("heading", { name: "Agent log entry 105" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent log entry 01" })).toHaveCount(0);
  await expect(page.getByText("3 tool calls")).toBeVisible();
  await expect(page.getByText("secret command 1")).toBeHidden();
  await expect(page.getByText("secret result 1")).toBeHidden();
  const table = page.getByRole("table");
  const tableCell = table.getByRole("cell", { name: "go test ./..." });
  await expect(table.getByRole("columnheader", { name: "Command" })).toBeVisible();
  await expect(tableCell).toHaveCSS("border-top-width", "1px");
  await expect(tableCell).toHaveCSS("border-top-style", "solid");
  await expect(tableCell).toHaveCSS("padding-top", "8px");
  await expect(tableCell).toHaveCSS("padding-left", "10.4px");
  const tableScroll = page.locator(".agent-log-table-scroll");
  await expect(tableScroll).toHaveCSS("overflow-x", "auto");
  expect(await tableScroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  const diagram = page.getByRole("figure", { name: "Mermaid diagram" });
  await expect(diagram.locator("svg")).toBeVisible();
  await expect(diagram).toHaveCSS("overflow-x", "auto");
  await page.screenshot({ path: testInfo.outputPath("agent-log-mermaid.png") });
  await expect.poll(() => viewport.evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight < 4,
  )).toBe(true);

  await viewport.hover();
  await page.mouse.wheel(0, -20_000);
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeLessThan(20);
  const firstNewestHeading = page.getByRole("heading", { name: "Agent log entry 12" });
  const topBeforeLoad = (await firstNewestHeading.boundingBox())?.y;
  expect(topBeforeLoad).toBeDefined();

  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByRole("heading", { name: "Agent log entry 01" })).toBeAttached();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  await expect.poll(async () => {
    const currentTop = (await firstNewestHeading.boundingBox())?.y;
    return currentTop === undefined ? Number.POSITIVE_INFINITY : Math.abs(currentTop - topBeforeLoad!);
  }).toBeLessThan(2);

  await page.getByRole("button", { name: "Scroll to end" }).click();
  await appendFile(transcriptPath, claudeTranscriptLine(106));
  await expect(page.getByRole("heading", { name: "Agent log entry 106" })).toBeVisible();
  await expect.poll(() => viewport.evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight < 4,
  )).toBe(true);

  await viewport.hover();
  await page.mouse.wheel(0, -20_000);
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeLessThan(20);
  const readingPosition = await viewport.evaluate((element) => element.scrollTop);

  await appendFile(transcriptPath, claudeTranscriptLine(107));
  await expect(page.getByRole("heading", { name: "Agent log entry 107" })).toBeAttached();
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(
    readingPosition + 2,
  );

  await page.getByRole("button", { name: "Scroll to end" }).click();
  await expect.poll(() => viewport.evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight < 4,
  )).toBe(true);

  await appendFile(transcriptPath, claudeTranscriptLine(108));
  await expect(page.getByRole("heading", { name: "Agent log entry 108" })).toBeVisible();
  await expect.poll(() => viewport.evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight < 4,
  )).toBe(true);
  await page.getByText("3 tool calls").click();
  const firstExecution = page
    .getByRole("article", { name: "exec_command" })
    .filter({ hasText: "secret command 1" });
  await expect(firstExecution.getByText("secret command 1")).toBeVisible();
  await expect(firstExecution.getByText("secret result 1")).toBeVisible();
  await firstExecution.scrollIntoViewIfNeeded();
  await expect(firstExecution).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("agent-log-tool-trace.png") });
  await page.screenshot({ path: testInfo.outputPath("agent-log-tab.png") });
});

test("keeps the agent log open when a filtered running agent starts waiting", async ({
  page,
}) => {
  await clearSessions(page);
  const first = await createSession(page, "First", "/tmp");
  const second = await createSession(page, "Second", "/tmp");
  await reportAgent(page, first.id, "codex", "Running task", "running");
  await reportAgent(page, second.id, "claude", "Waiting task");

  await page.goto("/?token=test-token&status=running&status=waiting");
  const firstPane = page.getByLabel("First pane", { exact: true });
  await firstPane.getByRole("tab", { name: "Agent log" }).click();

  await reportAgent(page, first.id, "codex", "Waiting for input");
  await expect.poll(async () => {
    const response = await page.request.get("/api/sessions", {
      headers: { Authorization: "Bearer test-token" },
    });
    const sessions = (await response.json()) as Array<{
      id: string;
      agentStatus?: string;
      needsAttention?: boolean;
    }>;
    const updated = sessions.find((session) => session.id === first.id);
    return {
      agentStatus: updated?.agentStatus,
      needsAttention: Boolean(updated?.needsAttention),
    };
  }).toEqual({ agentStatus: "waiting", needsAttention: false });

  await expect(firstPane).toHaveAttribute("data-active", "true");
  await expect(firstPane.getByRole("tab", { name: "Agent log" })).toHaveAttribute(
    "data-active",
  );
});

test("delays removing a running-filtered terminal while its status settles", async ({
  page,
}) => {
  await clearSessions(page);
  const first = await createSession(page, "First", "/tmp");
  const second = await createSession(page, "Second", "/tmp");
  await reportAgent(page, first.id, "codex", "Running task", "running");
  await reportAgent(page, second.id, "claude", "Waiting task");
  await replaceSharedSelection(page, [], first.id, ["running"]);

  await page.goto("/?token=test-token");
  await expect(page.getByLabel("First terminal", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Second terminal", { exact: true })).toBeHidden();

  await reportAgent(page, first.id, "codex", "Waiting for input");
  await expect.poll(async () => {
    const response = await page.request.get("/api/sessions", {
      headers: { Authorization: "Bearer test-token" },
    });
    const sessions = (await response.json()) as Array<{
      id: string;
      agentStatus?: string;
    }>;
    return sessions.find((session) => session.id === first.id)?.agentStatus;
  }).toBe("waiting");

  await expect(page.getByLabel("First terminal", { exact: true })).toBeVisible();
  await expect(page.getByLabel("First terminal", { exact: true })).toBeHidden({
    timeout: 12_000,
  });
  await expect(page.getByText("No signal yet.", { exact: true })).toBeVisible();
});

test("browses Git changes inside a terminal pane", async ({ page }, testInfo) => {
  await clearSessions(page);
  const repo = await mkdtemp(`/tmp/euphony-e2e-${e2ePort}-git-`);
  try {
    await runGit(repo, "init", "-b", "main");
    await runGit(repo, "config", "user.name", "Euphony Test");
    await runGit(repo, "config", "user.email", "euphony@example.test");
    await runGit(repo, "config", "commit.gpgsign", "false");
    await mkdir(`${repo}/src`, { recursive: true });
    await writeFile(`${repo}/src/app.ts`, "export const state = 'before';\n");
    await runGit(repo, "add", "src/app.ts");
    await runGit(repo, "commit", "-m", "baseline");
    await writeFile(`${repo}/src/app.ts`, "export const state = 'after';\n");
    await writeFile(`${repo}/draft file.md`, "# Draft\n");

    await createSession(page, "Git review", repo);
    await page.goto("/?token=test-token");
    const pane = page.getByLabel("Git review pane", { exact: true });
    await pane.getByRole("tab", { name: "Changes" }).click();

    await expect(
      pane.getByRole("region", { name: "Git changes" }).getByText("main", {
        exact: true,
      }),
    ).toBeVisible();
    const appFile = pane.getByRole("button", { name: /src\/app\.ts, modified/ });
    await appFile.click();
    await expect(pane.getByText("export const state = 'before';")).toBeVisible();
    await expect(pane.getByText("export const state = 'after';")).toBeVisible();

    const draftFile = pane.getByRole("button", { name: /draft file\.md, untracked/ });
    await draftFile.click();
    await expect(pane.getByText("# Draft")).toBeVisible();
    await expect(draftFile).toHaveAttribute("aria-current", "true");
    await page.screenshot({ path: testInfo.outputPath("git-changes-tab.png") });
  } finally {
    await clearSessions(page);
    await rm(repo, { recursive: true, force: true });
  }
});

test("browses workspace files inside a terminal pane", async ({ page }, testInfo) => {
  await clearSessions(page);
  const repo = await mkdtemp(`/tmp/euphony-e2e-${e2ePort}-files-`);
  try {
    await runGit(repo, "init", "-b", "main");
    await mkdir(`${repo}/docs`, { recursive: true });
    await writeFile(`${repo}/README.md`, "# Workspace\n");
    await writeFile(`${repo}/docs/User Guide.md`, "first\nsecond\n");

    await createSession(page, "File browser", repo);
    await page.goto("/?token=test-token");
    const pane = page.getByLabel("File browser pane", { exact: true });
    await pane.getByRole("tab", { name: "Files" }).click();

    await expect(pane.getByRole("navigation", {
      name: "Workspace files",
    })).toBeVisible();
    await pane.getByRole("button", { name: "Expand docs" }).click();
    await pane.getByRole("button", { name: "Open docs/User Guide.md" }).click();
    await expect(pane.getByRole("heading", { name: "User Guide.md" })).toBeVisible();
    await expect(pane.getByRole("table", {
      name: "Contents of docs/User Guide.md",
    })).toContainText("second");

    await pane.getByRole("searchbox", { name: "Filter workspace files" })
      .fill("readme");
    await pane.getByRole("button", {
      name: "Open search result README.md",
    }).click();
    await expect(pane.getByRole("heading", { name: "README.md" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("workspace-files-tab.png") });

    await page.setViewportSize({ width: 640, height: 720 });
    const navigator = await pane.locator(".workspace-file-navigator").boundingBox();
    const viewer = await pane.locator(".workspace-file-viewer").boundingBox();
    expect(navigator?.y).toBeLessThan(viewer?.y ?? 0);
  } finally {
    await clearSessions(page);
    await rm(repo, { recursive: true, force: true });
  }
});

test("splits pane sources with Command-click and drags the divider", async ({
  page,
}, testInfo) => {
  await clearSessions(page);
  const repo = await mkdtemp(`/tmp/euphony-e2e-${e2ePort}-split-`);
  try {
    await writeFile(`${repo}/README.md`, "# Split view\n");
    await createSession(page, "Split source", repo);
    await page.goto("/?token=test-token");

    const pane = page.getByLabel("Split source pane", { exact: true });
    const terminalTab = pane.getByRole("tab", { name: "Terminal" });
    const filesTab = pane.getByRole("tab", { name: "Files" });
    const terminalView = pane.locator(".terminal-view");
    const terminalHost = pane.getByLabel("Split source terminal", {
      exact: true,
    });
    await expect(terminalView).toHaveAttribute("data-connection", "connected");
    await expect.poll(async () => {
      return Number(await terminalView.getAttribute("data-local-cols"));
    }).toBeGreaterThan(0);
    const fullCols = Number(
      await terminalView.getAttribute("data-local-cols"),
    );

    await filesTab.click({ modifiers: ["Meta"] });

    await expect(terminalTab).toHaveAttribute("data-active");
    await expect(filesTab).toHaveAttribute("data-split-active", "true");
    await expect(filesTab).toBeFocused();
    await expect(filesTab).toHaveAttribute(
      "aria-description",
      "Visible in split",
    );
    await expect(
      terminalHost,
    ).toBeVisible();
    await expect(
      pane.getByRole("navigation", { name: "Workspace files" }),
    ).toBeVisible();
    await expect.poll(async () => {
      return Number(await terminalView.getAttribute("data-local-cols"));
    }).toBeLessThan(fullCols);
    const splitCols = Number(
      await terminalView.getAttribute("data-local-cols"),
    );

    const stage = pane.locator(".terminal-source-stage");
    const separator = pane.getByRole("separator", {
      name: "Resize source split",
    });
    const stageBounds = await stage.boundingBox();
    const separatorBounds = await separator.boundingBox();
    expect(stageBounds).not.toBeNull();
    expect(separatorBounds).not.toBeNull();
    await page.mouse.move(
      separatorBounds!.x + separatorBounds!.width / 2,
      separatorBounds!.y + separatorBounds!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      stageBounds!.x + stageBounds!.width * 0.65,
      stageBounds!.y + stageBounds!.height / 2,
    );
    await page.mouse.up();

    await expect(separator).toHaveAttribute("aria-valuenow", "65");
    const terminalPanelBounds = await pane.getByRole("tabpanel", {
      name: "Terminal",
    }).boundingBox();
    expect(terminalPanelBounds).not.toBeNull();
    expect(terminalPanelBounds!.width / stageBounds!.width).toBeCloseTo(0.65, 1);
    await expect.poll(async () => {
      return Number(await terminalView.getAttribute("data-local-cols"));
    }).toBeGreaterThan(splitCols);
    const draggedCols = Number(
      await terminalView.getAttribute("data-local-cols"),
    );
    expect(draggedCols).toBeLessThan(fullCols);
    await expect.poll(async () => terminalHost.evaluate((host) => {
      const screen = host.querySelector(".xterm-screen");
      if (!screen) return false;
      return screen.getBoundingClientRect().width <=
        host.getBoundingClientRect().width + 1;
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("pane-source-split.png") });

    await filesTab.click({ modifiers: ["Meta"] });
    await expect(separator).toHaveCount(0);
    await expect(terminalTab).toHaveAttribute("data-active");
    await expect(filesTab).toBeFocused();
    await expect.poll(async () => {
      return Number(await terminalView.getAttribute("data-local-cols"));
    }).toBe(fullCols);

    await filesTab.click();
    await expect(filesTab).toHaveAttribute("data-active");
    await expect(
      terminalHost,
    ).not.toBeVisible();
  } finally {
    await clearSessions(page);
    await rm(repo, { recursive: true, force: true });
  }
});

test("does not select a terminal when it needs attention", async ({ page }) => {
  await clearSessions(page);
  const first = await createSession(page, "First", "/tmp");
  const second = await createSession(page, "Second", "/tmp");

  await page.goto("/?token=test-token");
  await expect(page.getByLabel("First terminal", { exact: true })).toBeVisible();
  await expect(page.getByLabel("First pane", { exact: true })).toHaveAttribute(
    "data-active",
    "true",
  );

  await reportAgent(page, second.id, "claude", "Reviewing changes", "running");
  await reportAgent(page, second.id, "claude", "Waiting for review");

  await expect(page.getByLabel("Second terminal", { exact: true })).toBeHidden();
  await expect(page.getByLabel("First pane", { exact: true })).toHaveAttribute(
    "data-active",
    "true",
  );
  await expect.poll(async () => {
    const response = await page.request.get("/api/sessions", {
      headers: { Authorization: "Bearer test-token" },
    });
    const sessions = (await response.json()) as Array<{
      id: string;
      needsAttention?: boolean;
    }>;
    return sessions.find((session) => session.id === second.id)?.needsAttention;
  }).toBe(true);
  expect(new URL(page.url()).searchParams.get("focus")).toBe(first.id);
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
  await page.getByRole("button", { name: "Open settings" }).click();
  const mobileSettings = page.getByRole("dialog", { name: "Settings" });
  await expect(mobileSettings).toBeVisible();
  const settingsBox = await mobileSettings.boundingBox();
  expect(settingsBox).not.toBeNull();
  expect(settingsBox!.y).toBeGreaterThanOrEqual(0);
  expect(settingsBox!.y + settingsBox!.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: testInfo.outputPath("mobile-font-size-settings.png") });
  await page.keyboard.press("Escape");
  await expect(menu).toBeVisible();

  const mobileDimensions = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    viewport: window.innerHeight,
  }));
  expect(mobileDimensions.height).toBeLessThanOrEqual(mobileDimensions.viewport);
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test("updates the sidebar after the shell changes directory", async ({ page }) => {
  await clearSessions(page);
  await page.goto("/?token=test-token");

  const terminal = page.getByLabel("Terminal terminal", { exact: true });
  await expect(terminal).toBeVisible();
  await expect(page.locator(".terminal-view")).toHaveAttribute("data-connection", "connected");
  await terminal.click();
  await page.keyboard.type("cd /etc");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { name: "/etc" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Select Terminal" })).toHaveAttribute(
    "title",
    /^\/(?:private\/)?etc$/,
  );
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

test("keeps the server selection authoritative across navigation and reload", async ({ page }) => {
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
  await expect(page.getByLabel("First terminal")).toBeVisible();
  await expect(page.getByLabel("Second terminal")).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`terminal=${first.id}`));
});

test("keeps a selected split checkbox visibly checked", async ({ page }) => {
  await clearSessions(page);
  await createSession(page, "Left");
  await createSession(page, "Right");

  await page.goto("/?token=test-token");
  const checkbox = page.getByRole("checkbox", { name: "Include Right in split" });
  await checkbox.click();

  await expect(checkbox).toBeChecked();
  await expect(checkbox).toHaveCSS("background-color", "rgb(245, 245, 245)");
  await expect(page.getByLabel("Right terminal", { exact: true })).toBeVisible();
});

test("pins a terminal checkbox until that checkbox is clicked", async ({ page }) => {
  await clearSessions(page);
  const left = await createSession(page, "Left");
  const right = await createSession(page, "Right");

  await page.goto("/?token=test-token");
  const leftCheckbox = page.getByRole("checkbox", {
    name: "Include Left in split",
  });
  await leftCheckbox.click({ modifiers: ["Alt"] });
  await expect(leftCheckbox).toHaveAttribute("data-pinned", "true");
  await expect(leftCheckbox).toHaveCSS("background-color", "rgb(245, 158, 11)");
  await expect(page.locator(".pane-checkbox-pin")).toHaveCount(0);

  await page.getByRole("button", { name: "Select Right" }).click();

  await expect(page.getByLabel("Left terminal", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Right terminal", { exact: true })).toBeVisible();
  let parameters = new URL(page.url()).searchParams;
  expect(parameters.getAll("terminal")).toEqual([left.id, right.id]);
  expect(parameters.getAll("pin")).toEqual([left.id]);

  await page.reload();
  await expect(page.getByLabel("Left terminal", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Right terminal", { exact: true })).toBeVisible();
  await page
    .getByRole("checkbox", { name: "Include Left in split" })
    .click();

  await expect(page.getByLabel("Left terminal", { exact: true })).toBeHidden();
  await expect(page.getByLabel("Right terminal", { exact: true })).toBeVisible();
  parameters = new URL(page.url()).searchParams;
  expect(parameters.getAll("terminal")).toEqual([right.id]);
  expect(parameters.getAll("pin")).toEqual([]);
});

test("deselects a terminal from its pane rail", async ({ page }, testInfo) => {
  await clearSessions(page);
  const left = await createSession(page, "Left", "/private/tmp");
  const right = await createSession(page, "Right", "/private/var");

  await page.goto("/?token=test-token");
  await page.getByRole("checkbox", { name: "Include Right in split" }).click();
  await expect(page.locator(".terminal-pane")).toHaveCount(2);

  const leftSelection = page.getByRole("checkbox", { name: "Deselect Left" });
  await expect(leftSelection).toBeChecked();
  await expect(leftSelection).toHaveCSS("width", "14px");
  await expect(leftSelection).toHaveCSS("height", "14px");
  await page.screenshot({
    path: testInfo.outputPath("pane-selection-checkbox.png"),
  });
  await leftSelection.click();

  await expect(page.getByLabel("Left terminal", { exact: true })).toBeHidden();
  await expect(page.getByLabel("Right terminal", { exact: true })).toBeVisible();
  await page.waitForTimeout(1_800);
  await expect(page.getByLabel("Left terminal", { exact: true })).toBeHidden();
  expect(new URL(page.url()).searchParams.getAll("terminal")).toEqual([right.id]);
  expect(new URL(page.url()).searchParams.getAll("status")).toEqual([]);

  await page.getByRole("checkbox", { name: "Deselect Right" }).click();

  await expect(page.getByText("No signal yet.")).toBeVisible();
  const parameters = new URL(page.url()).searchParams;
  expect(parameters.getAll("terminal")).toEqual([]);
  expect(parameters.has("focus")).toBe(false);
  expect(parameters.getAll("terminal")).not.toContain(left.id);
});

test("follows a focused terminal when polling identifies it as a Claude agent", async ({ page }) => {
  await clearSessions(page);
  const first = await createSession(page, "First", "/tmp");
  await createSession(page, "Second", "/tmp");

  await page.goto("/?token=test-token");
  await page.getByLabel("First pane", { exact: true }).click();

  await reportAgent(page, first.id, "claude", "Waiting for review");

  await expect(page.getByLabel("First terminal", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Second terminal", { exact: true })).toBeHidden();
  expect(new URL(page.url()).searchParams.getAll("terminal")).toEqual([first.id]);
  expect(new URL(page.url()).searchParams.getAll("status")).toEqual([]);
  expect(new URL(page.url()).searchParams.getAll("cwd")).toEqual([]);
});

test("keeps a terminal selected when its agent starts running", async ({ page }) => {
  await clearSessions(page);
  const first = await createSession(page, "First", "/tmp");
  await createSession(page, "Second", "/tmp");

  await page.goto("/?token=test-token");
  await expect(page.getByLabel("First terminal", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Deselect First" })).toBeChecked();
  await page.getByLabel("First pane", { exact: true }).click();

  await reportAgent(page, first.id, "claude", "Working", "running");

  await expect(page.getByLabel("First terminal", { exact: true })).toBeVisible();
  await page.waitForTimeout(10_500);
  await expect(page.getByLabel("First terminal", { exact: true })).toBeVisible();
  const parameters = new URL(page.url()).searchParams;
  expect(parameters.getAll("terminal")).toEqual([first.id]);
  expect(parameters.get("focus")).toBe(first.id);
});

test("keeps cwd and terminal navigation rows compact", async ({ page }) => {
  await clearSessions(page);
  await createSession(page, "Compact terminal", "/tmp");

  await page.goto("/?token=test-token");
  const cwd = page.locator(".cwd-heading").filter({ hasText: "/tmp" });
  const terminal = page.getByRole("button", {
    name: "Select Compact terminal",
  });

  const [cwdBox, terminalBox] = await Promise.all([
    cwd.boundingBox(),
    terminal.boundingBox(),
  ]);
  expect(cwdBox).not.toBeNull();
  expect(terminalBox).not.toBeNull();
  expect(cwdBox!.height).toBeLessThanOrEqual(26);
  expect(terminalBox!.height).toBeLessThanOrEqual(32);
});

test("indents terminal rows beneath cwd headings", async ({ page }) => {
  await clearSessions(page);
  await createSession(page, "Indented terminal", "/tmp");

  await page.goto("/?token=test-token");
  const cwdX = (await page.locator(".cwd-heading").filter({ hasText: "/tmp" }).boundingBox())?.x;
  const terminalX = (
    await page.getByRole("checkbox", {
      name: "Include Indented terminal in split",
    }).boundingBox()
  )?.x;

  expect(cwdX).toBeDefined();
  expect(terminalX).toBeDefined();
  expect(terminalX!).toBeGreaterThan(cwdX!);
});

test("uses a flush black workspace with only a divider between panes", async ({ page }) => {
  await clearSessions(page);
  await createSession(page, "Left");
  await createSession(page, "Right");

  await page.goto("/?token=test-token");
  await page.getByRole("checkbox", { name: "Include Right in split" }).click();
  await expect(page.locator(".terminal-pane")).toHaveCount(2);

  await expect(page.locator('[data-slot="sidebar"]').first()).toBeVisible();
  await expect(page.getByText("EU", { exact: true })).toHaveCount(0);
  await expect(page.locator(".signal-status")).toHaveCount(0);

  const layout = await page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>(".terminal-stage");
    const panes = [...document.querySelectorAll<HTMLElement>(".terminal-pane")];
    const terminalViewport = document.querySelector<HTMLElement>(".xterm-viewport");
    if (!stage || panes.length !== 2 || !terminalViewport) {
      throw new Error("Expected a split terminal workspace.");
    }
    const stageStyle = getComputedStyle(stage);
    const paneStyles = panes.map((pane) => {
      const style = getComputedStyle(pane);
      return {
        background: style.backgroundColor,
        borderTop: style.borderTopWidth,
        borderRight: style.borderRightWidth,
        borderBottom: style.borderBottomWidth,
        borderLeft: style.borderLeftWidth,
        radius: style.borderRadius,
        shadow: style.boxShadow,
      };
    });
    const boxes = panes.map((pane) => pane.getBoundingClientRect());
    return {
      stage: {
        background: stageStyle.backgroundColor,
        padding: stageStyle.padding,
        gap: stageStyle.gap,
      },
      terminalBackground: getComputedStyle(terminalViewport).backgroundColor,
      panes: paneStyles,
      dividerDelta: Math.abs(boxes[0].right - boxes[1].left),
    };
  });

  expect(layout.stage).toEqual({
    background: "rgb(5, 5, 5)",
    padding: "0px",
    gap: "0px",
  });
  expect(layout.terminalBackground).toBe("rgb(0, 0, 0)");
  expect(layout.panes[0]).toEqual({
    background: "rgb(5, 5, 5)",
    borderTop: "0px",
    borderRight: "0px",
    borderBottom: "0px",
    borderLeft: "0px",
    radius: "0px",
    shadow: "none",
  });
  expect(layout.panes[1]).toEqual({
    ...layout.panes[0],
    borderLeft: "1px",
  });
  expect(layout.dividerDelta).toBeLessThanOrEqual(0.5);
});

test("opens Quick Actions with Command-K but not Control-K", async ({ page }) => {
  await clearSessions(page);
  await createSession(page, "Terminal");

  await page.goto("/?token=test-token");
  await page.keyboard.press("Control+K");
  await expect(page.getByRole("dialog", { name: "Quick Actions" })).toHaveCount(0);

  await page.keyboard.press("Meta+K");
  await expect(page.getByRole("dialog", { name: "Quick Actions" })).toBeVisible();
});

test("navigates Quick Actions with arrows and Ctrl-P/N before confirming", async ({ page }) => {
  await clearSessions(page);
  await createSession(page, "Left");
  await createSession(page, "Right");

  await page.goto("/?token=test-token");
  await page.keyboard.press("Meta+K");
  const command = page.getByPlaceholder("Terminal or status");
  await expect(command).toBeFocused();
  const inputGroup = page.locator(
    '[data-slot="command-input-wrapper"] [data-slot="input-group"]',
  );
  const inputWrapper = page.locator('[data-slot="command-input-wrapper"]');
  await expect(inputGroup).toHaveCSS("border-top-width", "0px");
  await expect(inputGroup).toHaveCSS("border-right-width", "0px");
  await expect(inputGroup).toHaveCSS("border-bottom-width", "0px");
  await expect(inputGroup).toHaveCSS("border-left-width", "0px");
  await expect(inputGroup).toHaveCSS("box-shadow", "none");
  await expect(inputWrapper).toHaveCSS("border-bottom-width", "1px");

  await page.keyboard.press("Control+N");
  await expect(page.getByRole("option", { name: /^Enable attention alerts/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Control+P");
  await expect(
    page.getByRole("option", { name: /^New terminal in directory…/ }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("option", { name: /^Show only Terminal terminals/ }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("dialog", { name: "Quick Actions" })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.getAll("status")).toEqual(["terminal"]);
});

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

test("shows recent Quick Actions first in a taller dialog", async ({ page }) => {
  await clearSessions(page);
  await createSession(page, "Left");
  const right = await createSession(page, "Right");

  await page.goto("/?token=test-token");
  await page.keyboard.press("Meta+K");
  const dialog = page.getByRole("dialog", { name: "Quick Actions" });
  await expect(dialog).toBeVisible();
  const initialBounds = await dialog.boundingBox();
  expect(initialBounds?.height).toBeGreaterThan(500);

  await page.getByRole("option", { name: /^Right/ }).click();
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press("Meta+K");

  const groups = page.locator("[cmdk-group]");
  await expect(groups.first().locator("[cmdk-group-heading]")).toHaveText("Recent");
  const recentRight = groups.first().getByRole("option", { name: /^Right/ });
  await expect(recentRight).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("option", { name: /^Right/ })).toHaveCount(1);
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("euphony.recentQuickActions:v1") ?? "null"),
    ),
  ).toEqual([`session:${right.id}`]);
});

test("keeps the Quick Actions keyboard selection in the scroll viewport", async ({ page }) => {
  await clearSessions(page);
  for (let index = 1; index <= 12; index += 1) {
    await createSession(page, `Terminal ${index}`);
  }

  await page.goto("/?token=test-token");
  await page.keyboard.press("Meta+K");
  const commandList = page.locator('[data-slot="command-list"]');
  await expect.poll(() =>
    commandList.evaluate((element) => element.scrollHeight > element.clientHeight),
  ).toBe(true);

  for (let index = 0; index < 14; index += 1) {
    await page.keyboard.press("ArrowDown");
  }

  const lastTerminal = page.getByRole("option", { name: /^Terminal 12/ });
  await expect(lastTerminal).toHaveAttribute("aria-selected", "true");
  await expect.poll(() =>
    lastTerminal.evaluate((element) => {
      const list = element.closest('[data-slot="command-list"]');
      if (!list) return false;
      const itemBounds = element.getBoundingClientRect();
      const listBounds = list.getBoundingClientRect();
      return itemBounds.top >= listBounds.top && itemBounds.bottom <= listBounds.bottom;
    }),
  ).toBe(true);
  const scrolledDown = await commandList.evaluate((element) => element.scrollTop);
  expect(scrolledDown).toBeGreaterThan(0);

  for (let index = 0; index < 14; index += 1) {
    await page.keyboard.press("ArrowUp");
  }

  const firstAction = page.getByRole("option", {
    name: /^New terminal in directory…/,
  });
  await expect(firstAction).toHaveAttribute("aria-selected", "true");
  await expect.poll(() =>
    firstAction.evaluate((element) => {
      const list = element.closest('[data-slot="command-list"]');
      if (!list) return false;
      const itemBounds = element.getBoundingClientRect();
      const listBounds = list.getBoundingClientRect();
      return itemBounds.top >= listBounds.top && itemBounds.bottom <= listBounds.bottom;
    }),
  ).toBe(true);
  await expect.poll(() => commandList.evaluate((element) => element.scrollTop))
    .toBeLessThan(scrolledDown);
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

test("navigates overflowing terminal panes one pane at a time", async ({ page }) => {
  await clearSessions(page);
  const one = await createSession(page, "One");
  const two = await createSession(page, "Two");
  const three = await createSession(page, "Three");
  const four = await createSession(page, "Four");
  await page.setViewportSize({ width: 1100, height: 800 });

  const parameters = new URLSearchParams({ token: "test-token", focus: one.id });
  [one, two, three, four].forEach((session) =>
    parameters.append("terminal", session.id),
  );
  await replaceSharedSelection(page, [one.id, two.id, three.id, four.id], one.id);
  await page.goto(`/?${parameters.toString()}`);

  const panes = page.locator(".terminal-pane");
  const nextControl = page.getByRole("button", { name: "Show next pane" });
  await expect(panes).toHaveCount(4);
  await expect(nextControl).toBeVisible();
  await expect(nextControl).toHaveCSS("background-color", "rgb(245, 245, 245)");
  await expect(nextControl.locator("svg")).toHaveCSS("color", "rgb(5, 5, 5)");
  const visibleWidths = await panes.evaluateAll((items) =>
    items
      .filter((item) => item.getAttribute("data-visible") === "true")
      .map((item) => item.getBoundingClientRect().width),
  );
  expect(visibleWidths).toHaveLength(2);
  expect(visibleWidths.every((width) => width >= 360)).toBe(true);

  await nextControl.click();

  await expect(page.getByLabel("One pane")).toHaveAttribute("data-visible", "false");
  await expect(page.getByLabel("Two pane")).toHaveAttribute("data-visible", "true");
  await expect(page.getByLabel("Three pane")).toHaveAttribute("data-visible", "true");
  await expect(page.getByRole("button", { name: "Show previous pane" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show next pane" })).toBeVisible();
});

test("shows the next terminal pane on mobile", async ({ page }) => {
  await clearSessions(page);
  const one = await createSession(page, "One");
  const two = await createSession(page, "Two");
  await page.setViewportSize({ width: 390, height: 844 });

  const parameters = new URLSearchParams({ token: "test-token", focus: one.id });
  [one, two].forEach((session) => parameters.append("terminal", session.id));
  await replaceSharedSelection(page, [one.id, two.id], one.id);
  await page.goto(`/?${parameters.toString()}`);

  await expect(page.getByLabel("One terminal", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show next pane" }).click();

  await expect(page.getByLabel("One pane")).toHaveAttribute("data-visible", "false");
  await expect(page.getByLabel("Two pane")).toHaveAttribute("data-visible", "true");
  await expect(page.getByLabel("Two terminal", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show previous pane" })).toBeVisible();
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
  await expect(codexItem.getByText("Review persistence", { exact: true })).toBeVisible();
  await expect(claudeItem.getByText("Check shortcuts", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Codex" })).toHaveCount(0);
  await expect(page.getByRole("img", { name: "Claude" })).toHaveCount(0);
  await expect(codexItem).not.toContainText("Codex");
  await expect(codexItem).not.toContainText("~/work/euphony");
  await expect(page.getByRole("heading", { name: "~/work/euphony" }).first()).toBeVisible();
  await page.getByRole("checkbox", { name: "Include Claude in split" }).click();
  await expect(page.locator(".terminal-pane")).toHaveCount(2);
  await codexItem.click();
  const codexPane = page.getByLabel("Codex pane", { exact: true });
  await codexPane.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Meta+L");
  await expect(page.getByRole("tab", { name: "Agent log" })).toHaveAttribute("data-active");
  await page.keyboard.press("Meta+L");
  await expect(page.getByRole("tab", { name: "Changes" })).toHaveAttribute("data-active");
  await page.keyboard.press("Meta+L");
  await expect(page.getByRole("tab", { name: "Files" })).toHaveAttribute("data-active");
  await page.keyboard.press("Meta+L");
  await expect(page.getByRole("tab", { name: "Terminal" })).toHaveAttribute("data-active");

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
  const reloadedCodexPane = page.getByLabel("Codex pane", { exact: true });
  await reloadedCodexPane.getByRole("tab", { name: "Terminal" }).click();

  await page.getByRole("button", { name: "Open settings" }).click();
  const settingsDialog = page.getByRole("dialog", { name: "Settings" });
  await settingsDialog.getByLabel("Prefix").fill("Ctrl+A");
  await settingsDialog.getByLabel("Pane tab toggle").fill("Ctrl+J");
  await settingsDialog.getByLabel("History buffer").fill("8");
  await settingsDialog.getByLabel("Interface").fill("18");
  await settingsDialog.getByLabel("Terminal", { exact: true }).fill("17");
  await settingsDialog.getByLabel("Terminal font").fill('"Courier New", monospace');
  await settingsDialog.getByLabel("Agent log").fill("16");
  const terminalRows = page.locator(".xterm-rows").first();
  const hasDomTerminalRows = await terminalRows.count() > 0;
  let fontOnlyRowHeight = 0;
  if (hasDomTerminalRows) {
    await expect(terminalRows).toHaveCSS("font-size", "17px");
    fontOnlyRowHeight = await terminalRows.evaluate(
      (rows) => rows.firstElementChild?.getBoundingClientRect().height ?? 0,
    );
  }
  await settingsDialog.getByLabel("Terminal line height").fill("1.5");
  await settingsDialog.getByLabel("Cursor style").selectOption("underline");
  await settingsDialog.getByRole("checkbox", { name: "Cursor blink" }).check();
  await settingsDialog.getByLabel("Scroll sensitivity").fill("5");
  const optionAsAlt = settingsDialog.getByRole("checkbox", { name: "Option as Alt" });
  await expect(settingsDialog.getByRole("checkbox", {
    name: "Auto-select attention terminals",
  })).toHaveCount(0);
  await expect(settingsDialog.getByRole("checkbox", {
    name: "Auto-deselect running agent terminals",
  })).toHaveCount(0);
  await expect(optionAsAlt).toBeChecked();
  await optionAsAlt.uncheck();
  await expect(page.locator("html")).toHaveCSS("font-size", "18px");
  if (hasDomTerminalRows) {
    await expect(terminalRows).toHaveCSS("font-size", "17px");
    await expect(terminalRows).toHaveCSS("font-family", '"Courier New", monospace');
  }
  await expect(page.locator(".agent-log-view").first()).toHaveCSS(
    "--agent-log-font-size",
    "16px",
  );
  if (hasDomTerminalRows) {
    await expect
      .poll(async () => terminalRows.evaluate(
        (rows) => rows.firstElementChild?.getBoundingClientRect().height ?? 0,
      ))
      .toBeGreaterThan(fontOnlyRowHeight);
  }
  await page.screenshot({ path: testInfo.outputPath("font-size-settings.png") });
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.reload();
  await page.getByRole("button", { name: "Open settings" }).click();
  const savedSettingsDialog = page.getByRole("dialog", { name: "Settings" });
  await expect(savedSettingsDialog.getByLabel("History buffer")).toHaveValue("8");
  await expect(savedSettingsDialog.getByLabel("Interface")).toHaveValue("18");
  await expect(savedSettingsDialog.getByLabel("Terminal", { exact: true })).toHaveValue("17");
  await expect(savedSettingsDialog.getByLabel("Terminal font")).toHaveValue(
    '"Courier New", monospace',
  );
  await expect(savedSettingsDialog.getByLabel("Agent log")).toHaveValue("16");
  await expect(savedSettingsDialog.getByLabel("Terminal line height")).toHaveValue("1.5");
  await expect(savedSettingsDialog.getByLabel("Cursor style")).toHaveValue("underline");
  await expect(savedSettingsDialog.getByRole("checkbox", { name: "Cursor blink" })).toBeChecked();
  await expect(savedSettingsDialog.getByLabel("Scroll sensitivity")).toHaveValue("5");
  await expect(savedSettingsDialog.getByRole("checkbox", {
    name: "Option as Alt",
  })).not.toBeChecked();
  await savedSettingsDialog.getByRole("checkbox", { name: "Unlimited history" }).check();
  await expect(savedSettingsDialog.getByLabel("History buffer")).toBeDisabled();
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.reload();
  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page.getByRole("checkbox", { name: "Unlimited history" })).toBeChecked();
  await expect(page.getByLabel("History buffer")).toBeDisabled();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Select Codex" }).click();
  await codexPane.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+J");
  await expect(page.getByRole("tab", { name: "Agent log" })).toHaveAttribute("data-active");
  await page.keyboard.press("Control+J");
  await expect(page.getByRole("tab", { name: "Changes" })).toHaveAttribute("data-active");
  await page.keyboard.press("Control+J");
  await expect(page.getByRole("tab", { name: "Files" })).toHaveAttribute("data-active");
  await page.keyboard.press("Control+J");
  await expect(page.getByRole("tab", { name: "Terminal" })).toHaveAttribute("data-active");
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
  const expandSidebar = page.getByRole("button", { name: "Expand sidebar" });
  await expect(expandSidebar).toBeVisible();
  await expect.poll(async () =>
    page.locator(".terminal-stage").evaluate((stage) =>
      stage.getBoundingClientRect().left
    )
  ).toBe(0);
  const collapsedLayout = await page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>(".terminal-stage")
      ?.getBoundingClientRect();
    const expand = document.querySelector<HTMLElement>(
      '[aria-label="Expand sidebar"]',
    )?.getBoundingClientRect();
    if (!stage || !expand) throw new Error("Collapsed sidebar layout is missing.");
    return {
      stageLeft: stage.left,
      stageRight: stage.right,
      viewportWidth: window.innerWidth,
      expandLeft: expand.left,
      expandRight: expand.right,
    };
  });
  expect(collapsedLayout.stageLeft).toBe(0);
  expect(collapsedLayout.stageRight).toBe(collapsedLayout.viewportWidth);
  expect(collapsedLayout.expandLeft).toBeGreaterThanOrEqual(0);
  expect(collapsedLayout.expandRight).toBeLessThanOrEqual(
    collapsedLayout.viewportWidth,
  );
  await page.screenshot({ path: testInfo.outputPath("collapsed-sidebar.png") });

  await page.keyboard.press("Control+B");
  await expect(expandSidebar).toBeVisible();
  await page.keyboard.press("Meta+B");
  await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
  await page.keyboard.press("Meta+B");
  await expect(expandSidebar).toBeVisible();
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
