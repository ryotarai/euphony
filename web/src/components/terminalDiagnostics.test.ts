import { afterEach, expect, test, vi } from "vitest";
import {
  createTerminalDiagnostics,
  terminalDiagnosticsStorageKey,
} from "./terminalDiagnostics";

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.removeItem(terminalDiagnosticsStorageKey);
});

test("keeps terminal diagnostics silent unless explicitly enabled", () => {
  const log = vi.fn();
  const diagnostics = createTerminalDiagnostics({
    sessionID: "session-1",
    host: document.createElement("div"),
    log,
  });

  diagnostics.noteConnection("connected");
  diagnostics.noteOutput(12, false);
  diagnostics.noteWrite(12, "batch");
  diagnostics.dispose();

  expect(log).not.toHaveBeenCalled();
});

test("reports renderer and terminal output counters when enabled", () => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  host.innerHTML = '<div class="xterm"><div class="xterm-rows"></div></div>';
  const log = vi.fn();
  const diagnostics = createTerminalDiagnostics({
    sessionID: "session-1",
    host,
    enabled: true,
    intervalMs: 1_000,
    log,
  });

  diagnostics.noteConnection("connected");
  diagnostics.noteOutput(12, false);
  diagnostics.noteOutput(5, true);
  diagnostics.noteWrite(17, "batch");
  diagnostics.noteFlow(3, true);
  vi.advanceTimersByTime(1_000);

  expect(log).toHaveBeenCalledWith(
    "[euphony:terminal] sample",
    expect.objectContaining({
      sessionID: "session-1",
      connection: "connected",
      hostVisible: true,
      runningAnimations: 0,
      renderer: "dom",
      canvasCount: 0,
      domRows: true,
      outputMessages: 1,
      outputBytes: 12,
      historyMessages: 1,
      historyBytes: 5,
      writeCalls: 1,
      writeBytes: 17,
      flowPendingWrites: 3,
      flowPaused: true,
    }),
  );

  diagnostics.dispose();
  expect(log).toHaveBeenLastCalledWith(
    "[euphony:terminal] final",
    expect.objectContaining({ writeBytes: 17 }),
  );
});

test("enables diagnostics through localStorage", () => {
  const log = vi.fn();
  window.localStorage.setItem(terminalDiagnosticsStorageKey, "1");
  const diagnostics = createTerminalDiagnostics({
    sessionID: "session-1",
    host: document.createElement("div"),
    log,
  });

  diagnostics.dispose();

  expect(log).toHaveBeenCalled();
});
