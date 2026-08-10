export const terminalDiagnosticsStorageKey = "euphony:terminal-debug";

// Set localStorage[euphony:terminal-debug] to "1" before reloading to collect
// opt-in terminal renderer and output counters without adding normal-path logs.

type TerminalDiagnosticsLog = (...args: unknown[]) => void;
type TerminalDiagnosticsConnection =
  | "connecting"
  | "connected"
  | "disconnected"
  | "exited";
type TerminalWriteKind = "batch" | "history" | "direct";

export interface TerminalDiagnostics {
  noteConnection(state: TerminalDiagnosticsConnection): void;
  noteOutput(bytes: number, history: boolean): void;
  noteWrite(bytes: number, kind: TerminalWriteKind): void;
  dispose(): void;
}

interface TerminalDiagnosticsOptions {
  sessionID: string;
  host: HTMLElement;
  enabled?: boolean;
  intervalMs?: number;
  log?: TerminalDiagnosticsLog;
}

interface TerminalDiagnosticsSnapshot {
  sessionID: string;
  elapsedMs: number;
  connection: TerminalDiagnosticsConnection | "unknown";
  visibility: string;
  hostVisible: boolean;
  runningAnimations: number;
  renderer: "dom" | "canvas-or-webgl";
  canvasCount: number;
  domRows: boolean;
  width: number;
  height: number;
  outputMessages: number;
  outputBytes: number;
  historyMessages: number;
  historyBytes: number;
  writeCalls: number;
  writeBytes: number;
  batchWriteCalls: number;
  historyWriteCalls: number;
  directWriteCalls: number;
}

const noopDiagnostics: TerminalDiagnostics = {
  noteConnection: () => undefined,
  noteOutput: () => undefined,
  noteWrite: () => undefined,
  dispose: () => undefined,
};

export function terminalDiagnosticsEnabled(): boolean {
  try {
    return window.localStorage.getItem(terminalDiagnosticsStorageKey) === "1";
  } catch {
    return false;
  }
}

function terminalSurfaceSnapshot(host: HTMLElement): Pick<
  TerminalDiagnosticsSnapshot,
  | "visibility"
  | "hostVisible"
  | "runningAnimations"
  | "renderer"
  | "canvasCount"
  | "domRows"
  | "width"
  | "height"
> {
  const canvasCount = host.querySelectorAll("canvas").length;
  const bounds = host.getBoundingClientRect();
  return {
    visibility: document.visibilityState,
    hostVisible: !host.hidden &&
      !host.closest("[hidden]") &&
      !host.closest('[aria-hidden="true"]'),
    runningAnimations: typeof document.getAnimations === "function"
      ? document.getAnimations().filter((animation) => animation.playState === "running").length
      : 0,
    renderer: canvasCount === 0 ? "dom" : "canvas-or-webgl",
    canvasCount,
    domRows: host.querySelector(".xterm-rows") !== null,
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
}

export function createTerminalDiagnostics(
  options: TerminalDiagnosticsOptions,
): TerminalDiagnostics {
  const enabled = options.enabled ?? terminalDiagnosticsEnabled();
  if (!enabled) return noopDiagnostics;

  const now = () => Date.now();
  const startedAt = now();
  const log = options.log ?? ((...args: unknown[]) => console.log(...args));
  let connection: TerminalDiagnosticsSnapshot["connection"] = "unknown";
  let outputMessages = 0;
  let outputBytes = 0;
  let historyMessages = 0;
  let historyBytes = 0;
  let writeCalls = 0;
  let writeBytes = 0;
  let batchWriteCalls = 0;
  let historyWriteCalls = 0;
  let directWriteCalls = 0;
  let disposed = false;

  const snapshot = (): TerminalDiagnosticsSnapshot => ({
    sessionID: options.sessionID,
    elapsedMs: Math.max(0, now() - startedAt),
    connection,
    ...terminalSurfaceSnapshot(options.host),
    outputMessages,
    outputBytes,
    historyMessages,
    historyBytes,
    writeCalls,
    writeBytes,
    batchWriteCalls,
    historyWriteCalls,
    directWriteCalls,
  });
  const emit = (event: "open" | "state" | "sample" | "final") => {
    log(`[euphony:terminal] ${event}`, snapshot());
  };

  emit("open");
  const interval = window.setInterval(
    () => emit("sample"),
    Math.max(1_000, options.intervalMs ?? 5_000),
  );

  return {
    noteConnection(state) {
      if (disposed || connection === state) return;
      connection = state;
      emit("state");
    },
    noteOutput(bytes, history) {
      if (disposed || bytes <= 0) return;
      if (history) {
        historyMessages++;
        historyBytes += bytes;
      } else {
        outputMessages++;
        outputBytes += bytes;
      }
    },
    noteWrite(bytes, kind) {
      if (disposed || bytes <= 0) return;
      writeCalls++;
      writeBytes += bytes;
      if (kind === "batch") batchWriteCalls++;
      if (kind === "history") historyWriteCalls++;
      if (kind === "direct") directWriteCalls++;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      window.clearInterval(interval);
      emit("final");
    },
  };
}
