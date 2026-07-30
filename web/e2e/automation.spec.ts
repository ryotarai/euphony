import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const port = process.env.EUPHONY_E2E_PORT ?? "18080";
const socketPath = `/tmp/euphony-e2e-${port}.sock`;

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
