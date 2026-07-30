import { expect, test, type Page } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const port = process.env.EUPHONY_E2E_PORT ?? "18080";
const socketPath = `/tmp/euphony-e2e-${port}.sock`;
const binaryPath = resolve("../bin/euphony");

type CLIEnvelope<T> = {
  ok: true;
  result: T;
};

async function cli<T>(args: string[]): Promise<T> {
  const { stdout, stderr } = await execFileAsync("../bin/euphony", args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      EUPHONY_SOCKET: socketPath,
      EUPHONY_URL: "",
      EUPHONY_TOKEN: "",
    },
  });
  expect(stderr).toBe("");
  const envelope = JSON.parse(stdout) as CLIEnvelope<T>;
  expect(envelope.ok).toBe(true);
  return envelope.result;
}

async function clearTerminals(page: Page) {
  const response = await page.request.get("/api/v1/terminals", {
    headers: { Authorization: "Bearer test-token" },
  });
  const envelope = await response.json() as CLIEnvelope<{
    terminals: Array<{ id: string }>;
  }>;
  for (const terminal of envelope.result.terminals) {
    await page.request.delete(`/api/v1/terminals/${terminal.id}`, {
      headers: { Authorization: "Bearer test-token" },
    });
  }
}

function annotate(
  terminalID: string,
  path: string,
  transport: "unix" | "tcp",
) {
  const args = transport === "unix"
    ? ["annotate", path]
    : [
      "--url",
      `http://127.0.0.1:${port}`,
      "--token",
      "test-token",
      "annotate",
      path,
    ];
  const child = spawn("../bin/euphony", args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      EUPHONY_TERMINAL_ID: terminalID,
      EUPHONY_SOCKET: transport === "unix" ? socketPath : "",
      EUPHONY_URL: "",
      EUPHONY_TOKEN: "",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const completed = new Promise<CLIEnvelope<{
    annotationId: string;
    path: string;
    comments: Array<{
      kind: "selection" | "global";
      body: string;
      quote?: string;
      startOffset?: number;
      endOffset?: number;
    }>;
  }>>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`annotate exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`invalid annotate output: ${stdout}`));
      }
    });
  });
  return { completed };
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

test("automates terminals over Unix and TCP and shares selection with the browser", async ({
  page,
}) => {
  await clearTerminals(page);

  const localStatus = await cli<{ apiVersion: string; status: string }>(["status"]);
  expect(localStatus).toEqual({ apiVersion: "v1", status: "ok" });

  const tcpStatus = await cli<{ apiVersion: string; status: string }>([
    "--url",
    `http://127.0.0.1:${port}`,
    "--token",
    "test-token",
    "status",
  ]);
  expect(tcpStatus.status).toBe("ok");

  const created = await cli<{
    terminal: { id: string };
    selection: { terminalIds: string[] };
  }>([
    "terminal",
    "create",
    "--name",
    "Automated",
    "--cwd",
    "/tmp",
    "--selection",
    "replace",
  ]);
  expect(created.selection.terminalIds).toEqual([created.terminal.id]);

  await cli(["terminal", "run", created.terminal.id, "printf 'CLI_E2E_OK\\n'"]);
  const waited = await cli<{ matchedLine: string }>([
    "terminal",
    "wait-output",
    "--match",
    "CLI_E2E_OK",
    "--timeout",
    "5000",
    created.terminal.id,
  ]);
  expect(waited.matchedLine).toContain("CLI_E2E_OK");

  await page.goto("/?token=test-token");
  await expect(page.getByLabel("Automated terminal", { exact: true })).toBeVisible();

  const second = await cli<{ terminal: { id: string } }>([
    "terminal",
    "create",
    "--name",
    "CLI split",
    "--cwd",
    "/tmp",
    "--selection",
    "add",
  ]);
  await expect(page.getByLabel("CLI split terminal", { exact: true })).toBeVisible({
    timeout: 5_000,
  });

  const selection = await cli<{ terminalIds: string[]; focusedTerminalId: string }>([
    "selection",
    "get",
  ]);
  expect(selection.terminalIds).toEqual([
    created.terminal.id,
    second.terminal.id,
  ]);
  expect(selection.focusedTerminalId).toBe(second.terminal.id);
});

test("reviews annotations from the blocking CLI over Unix and TCP", async ({
  page,
}, testInfo) => {
  await clearTerminals(page);
  const created = await cli<{ terminal: { id: string } }>([
    "terminal",
    "create",
    "--name",
    "Annotation review",
    "--cwd",
    "/tmp",
    "--selection",
    "replace",
  ]);
  const eventStream = page.waitForRequest((request) =>
    request.url().endsWith("/api/v1/events")
  );
  await page.goto("/?token=test-token");
  await eventStream;
  await expect(page.getByLabel("Annotation review terminal", { exact: true }))
    .toBeVisible();

  const markdownPath = `/tmp/euphony-annotation-${port}.md`;
  await writeFile(
    markdownPath,
    "# Release proposal\n\nSelect this passage for feedback.\n",
  );
  await cli([
    "terminal",
    "run",
    created.terminal.id,
    `${shellQuote(binaryPath)} annotate ${shellQuote(markdownPath)}`,
  ]);
  await expect(page.getByRole("tab", { name: "Annotation" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Release proposal" }),
  ).toBeVisible();

  const passage = page.getByText("Select this passage for feedback.");
  await passage.evaluate((element) => {
    const text = element.firstChild;
    if (!text) throw new Error("selection text is missing");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 11);
    const selection = window.getSelection();
    if (!selection) throw new Error("selection is unavailable");
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.getByRole("textbox", { name: "Comment on selection" })
    .fill("Make the rollout criteria concrete.");
  await page.getByRole("button", { name: "Add selection comment" }).click();
  await page.getByRole("textbox", { name: "Global comment" })
    .fill("Ready after that change.");
  await page.getByRole("button", { name: "Add global comment" }).click();
  await page.screenshot({
    path: testInfo.outputPath("annotation-review.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Send comments" }).click();

  const terminalOutput = await cli<{ matchedLine: string }>([
    "terminal",
    "wait-output",
    "--match",
    "Make the rollout criteria concrete.",
    "--timeout",
    "5000",
    created.terminal.id,
  ]);
  expect(terminalOutput.matchedLine).toContain(`"ok":true`);
  expect(terminalOutput.matchedLine).toContain(`"comments"`);
  expect(terminalOutput.matchedLine).toContain(`"quote":"Select this"`);
  await expect(page.getByRole("tab", { name: "Annotation" })).toHaveCount(0);

  const htmlPath = `/tmp/euphony-annotation-${port}.html`;
  await writeFile(
    htmlPath,
    "<h1>HTML review</h1><script>window.hacked = true</script><p>Safe content.</p>",
  );
  const html = annotate(created.terminal.id, htmlPath, "tcp");
  await expect(page.getByRole("tab", { name: "Annotation" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "HTML review" })).toBeVisible();
  await expect(page.locator(".annotation-document script")).toHaveCount(0);
  expect(await page.evaluate(() => "hacked" in window)).toBe(false);
  await page.getByRole("textbox", { name: "Global comment" })
    .fill("HTML looks safe.");
  await page.getByRole("button", { name: "Add global comment" }).click();
  await page.getByRole("button", { name: "Send comments" }).click();

  const htmlOutput = await html.completed;
  expect(htmlOutput.ok).toBe(true);
  expect(htmlOutput.result.comments).toEqual([
    { kind: "global", body: "HTML looks safe." },
  ]);
});
