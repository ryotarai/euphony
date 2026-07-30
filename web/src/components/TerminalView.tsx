import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CheckIcon } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import type { ApiClient } from "../api";
import type { Session } from "../types";

export interface TerminalDriver {
  readonly cols?: number;
  readonly rows?: number;
  open(element: HTMLElement): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  focus(): void;
  fit(): void;
  proposeDimensions?(): { cols: number; rows: number } | undefined;
  resize?(cols: number, rows: number): void;
  setScrollback?(scrollback: number): void;
  getSelection(): string;
  clearSelection(): void;
  attachCustomKeyEventHandler?(handler: (event: KeyboardEvent) => boolean): void;
  onSelectionChange(callback: () => void): () => void;
  onData(callback: (data: string) => void): () => void;
  onResize(callback: (cols: number, rows: number) => void): () => void;
  onTitleChange?(callback: (title: string) => void): () => void;
  dispose(): void;
}

export interface WebSocketLike extends EventTarget {
  readonly OPEN: number;
  readonly readyState: number;
  send(data: string): void;
  close(): void;
}

interface TerminalViewProps {
  session: Session;
  api: ApiClient;
  active?: boolean;
  layoutVersion?: number;
  reconnectSignal?: number;
  terminalHistoryLimit?: number;
  fontSize?: number;
  onConnectionChange?(sessionID: string, state: ConnectionState): void;
  createTerminal?: (fontSize: number, scrollback: number) => TerminalDriver;
  createSocket?: (url: string) => WebSocketLike;
}

export type ConnectionState = "connecting" | "connected" | "disconnected" | "exited";

interface TerminalGridGeometry {
  width: number;
  height: number;
}

const maxTerminalScrollback = 4294967295;
const maxFiniteTerminalScrollback = 100000;
const estimatedBytesPerScrollbackRow = 128;
const terminalViewportGutter = 14;

export function terminalScrollback(historyLimit: number): number {
  if (historyLimit === 0) return maxTerminalScrollback;
  return Math.max(
    1000,
    Math.min(
      maxFiniteTerminalScrollback,
      Math.ceil(historyLimit / estimatedBytesPerScrollbackRow),
    ),
  );
}

function defaultTerminal(fontSize: number, scrollback: number): TerminalDriver {
  const fitAddon = new FitAddon();
  const terminal = new Terminal({
    cursorBlink: false,
    cursorStyle: "bar",
    allowTransparency: true,
    fontFamily: 'Menlo, Monaco, "Hiragino Sans", "Yu Gothic", "Noto Sans Mono CJK JP", monospace',
    fontSize,
    lineHeight: 1.25,
    scrollback,
    scrollSensitivity: 3,
    theme: {
      background: "#050505",
      foreground: "#f5f5f5",
      cursor: "#f5f5f5",
      selectionBackground: "#333333",
      black: "#050505",
      red: "#f87171",
      green: "#a3e635",
      yellow: "#facc15",
      blue: "#93c5fd",
      magenta: "#d8b4fe",
      cyan: "#67e8f9",
      white: "#f5f5f5",
      brightBlack: "#737373",
    },
  });
  terminal.loadAddon(fitAddon);
  return {
    get cols() {
      return terminal.cols;
    },
    get rows() {
      return terminal.rows;
    },
    open: (element) => terminal.open(element),
    write: (data, callback) => terminal.write(data, callback),
    focus: () => terminal.focus(),
    fit: () => fitAddon.fit(),
    proposeDimensions: () => fitAddon.proposeDimensions(),
    resize: (cols, rows) => terminal.resize(cols, rows),
    setScrollback: (next) => {
      terminal.options.scrollback = next;
    },
    getSelection: () => terminal.getSelection(),
    clearSelection: () => terminal.clearSelection(),
    attachCustomKeyEventHandler: (handler) => terminal.attachCustomKeyEventHandler(handler),
    onSelectionChange: (callback) => {
      const disposable = terminal.onSelectionChange(callback);
      return () => disposable.dispose();
    },
    onData: (callback) => {
      const disposable = terminal.onData(callback);
      return () => disposable.dispose();
    },
    onResize: (callback) => {
      const disposable = terminal.onResize(({ cols, rows }) => callback(cols, rows));
      return () => disposable.dispose();
    },
    onTitleChange: (callback) => {
      const disposable = terminal.onTitleChange(callback);
      return () => disposable.dispose();
    },
    dispose: () => terminal.dispose(),
  };
}

function defaultSocket(url: string): WebSocketLike {
  return new WebSocket(url);
}

function decodeTerminalData(data: string): Uint8Array {
  const decoded = atob(data);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function focusTerminal(terminal: TerminalDriver) {
  const modalOpen = document.querySelector('[role="dialog"]');
  if (!modalOpen) terminal.focus();
}

export function fitTerminalIfVisible(
  host: HTMLElement,
  terminal: Pick<TerminalDriver, "fit">,
) {
  if (host.hidden || host.closest("[hidden]")) return;
  terminal.fit();
}

export function TerminalView({
  session,
  api,
  active = true,
  layoutVersion = 1,
  reconnectSignal = 0,
  terminalHistoryLimit = 1024 * 1024,
  fontSize = 14,
  onConnectionChange,
  createTerminal = defaultTerminal,
  createSocket = defaultSocket,
}: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<TerminalDriver | null>(null);
  const capacityReporterRef = useRef<() => void>(() => undefined);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [copied, setCopied] = useState(false);
  const [localSize, setLocalSize] = useState<{ cols: number; rows: number }>();
  const [sharedSize, setSharedSize] = useState<{ cols: number; rows: number }>();
  const [gridGeometry, setGridGeometry] = useState<TerminalGridGeometry>();

  useEffect(() => {
    onConnectionChange?.(session.id, connection);
  }, [connection, onConnectionChange, session.id]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let active = true;
    let replayingHistory = false;
    let acceptedSizeReceived = false;
    let queuedHistory: Uint8Array[] = [];
    let pendingHistoryWrites = 0;
    let historyStreamComplete = false;
    let socket: WebSocketLike | undefined;
    let gridMeasurementFrame: number | undefined;
    let lastSize = "";
    let claimActive = false;
    let lastReportedCWD = session.cwd;
    const terminal = createTerminal(
      fontSize,
      terminalScrollback(terminalHistoryLimit),
    );
    terminalRef.current = terminal;
    terminal.open(host);
    if (activeRef.current) focusTerminal(terminal);
    setConnection("connecting");

    const send = (message: unknown): boolean => {
      const currentSocket = socket;
      if (currentSocket && currentSocket.readyState === currentSocket.OPEN) {
        currentSocket.send(JSON.stringify(message));
        return true;
      }
      return false;
    };
    const sendResize = (cols?: number, rows?: number) => {
      if (!cols || !rows) return;
      const size = `${cols}x${rows}`;
      if (size === lastSize) return;
      if (send({ type: "resize", cols, rows })) {
        lastSize = size;
        claimActive = true;
      }
    };
    const reportCapacity = () => {
      if (host.hidden || host.closest("[hidden]")) {
        if (claimActive && send({ type: "resize_release" })) {
          claimActive = false;
          lastSize = "";
        }
        return;
      }
      const dimensions = terminal.proposeDimensions?.();
      if (!dimensions || dimensions.cols < 1 || dimensions.rows < 1) return;
      setLocalSize(dimensions);
      sendResize(dimensions.cols, dimensions.rows);
    };
    capacityReporterRef.current = reportCapacity;
    const writeHistory = (data: Uint8Array) => {
      replayingHistory = true;
      pendingHistoryWrites++;
      try {
        terminal.write(data, () => {
          pendingHistoryWrites--;
          if (
            acceptedSizeReceived &&
            historyStreamComplete &&
            pendingHistoryWrites === 0 &&
            queuedHistory.length === 0
          ) {
            replayingHistory = false;
          }
        });
      } catch {
        pendingHistoryWrites--;
        if (
          acceptedSizeReceived &&
          historyStreamComplete &&
          pendingHistoryWrites === 0 &&
          queuedHistory.length === 0
        ) {
          replayingHistory = false;
        }
      }
    };
    terminal.attachCustomKeyEventHandler?.((event) => {
      if (event.type !== "keydown" || event.isComposing || event.keyCode === 229) return true;
      if (event.key !== "Enter" || !event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
        return true;
      }
      event.preventDefault();
      send({ type: "input", data: "\n" });
      return false;
    });
    const removeData = terminal.onData((data) => {
      if (!replayingHistory) send({ type: "input", data });
    });
    const removeTitleChange = terminal.onTitleChange?.((title) => {
      const cwd = title.trim();
      const isDirectoryTitle = cwd.startsWith("/") || cwd === "~" || cwd.startsWith("~/");
      if (replayingHistory || !isDirectoryTitle || cwd === lastReportedCWD) return;
      if (send({ type: "cwd", data: cwd })) lastReportedCWD = cwd;
    });
    let selectionTimer: ReturnType<typeof setTimeout> | undefined;
    let copiedTimer: ReturnType<typeof setTimeout> | undefined;
    const removeSelectionChange = terminal.onSelectionChange(() => {
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        const selection = terminal.getSelection();
        if (!selection || !navigator.clipboard?.writeText) return;
        void navigator.clipboard
          .writeText(selection)
          .then(() => {
            if (!active) return;
            terminal.clearSelection();
            setCopied(true);
            clearTimeout(copiedTimer);
            copiedTimer = setTimeout(() => setCopied(false), 1600);
          })
          .catch(() => undefined);
      }, 150);
    });
    window.addEventListener("resize", reportCapacity);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(reportCapacity);
    resizeObserver?.observe(host);

    void api
      .createTicket(session.id)
      .then(({ ticket }) => {
        if (!active) return;
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${protocol}//${window.location.host}/api/sessions/${encodeURIComponent(
          session.id,
        )}/terminal?ticket=${encodeURIComponent(ticket)}`;
        const connectionSocket = createSocket(url);
        socket = connectionSocket;
        connectionSocket.addEventListener("open", () => {
          if (!active) return;
          setConnection("connected");
          reportCapacity();
          if (activeRef.current) focusTerminal(terminal);
        });
        connectionSocket.addEventListener("message", (event) => {
          if (!active || !(event instanceof MessageEvent) || typeof event.data !== "string") return;
          const message = JSON.parse(event.data) as {
            type: string;
            data?: string;
            exitCode?: number;
            message?: string;
            cols?: number;
            rows?: number;
          };
          if (message.type === "history" && message.data) {
            try {
              const data = decodeTerminalData(message.data);
              replayingHistory = true;
              if (acceptedSizeReceived) {
                writeHistory(data);
              } else {
                queuedHistory.push(data);
              }
            } catch {
              // Ignore malformed terminal history.
            }
          } else if (message.type === "history_end") {
            historyStreamComplete = true;
            if (
              acceptedSizeReceived &&
              pendingHistoryWrites === 0 &&
              queuedHistory.length === 0
            ) {
              replayingHistory = false;
            }
          } else if (message.type === "output" && message.data) {
            try {
              terminal.write(decodeTerminalData(message.data));
            } catch {
              // Ignore malformed terminal payloads instead of rendering corrupt bytes.
            }
          } else if (
            message.type === "resize" &&
            Number.isInteger(message.cols) &&
            Number.isInteger(message.rows) &&
            message.cols! >= 1 &&
            message.cols! <= 1000 &&
            message.rows! >= 1 &&
            message.rows! <= 1000
          ) {
            terminal.resize?.(message.cols!, message.rows!);
            const acceptedSize = { cols: message.cols!, rows: message.rows! };
            acceptedSizeReceived = true;
            setSharedSize(acceptedSize);
            if (gridMeasurementFrame !== undefined) {
              window.cancelAnimationFrame(gridMeasurementFrame);
            }
            gridMeasurementFrame = window.requestAnimationFrame(() => {
              const screen = host.querySelector<HTMLElement>(".xterm-screen");
              if (!screen) return;
              const bounds = screen.getBoundingClientRect();
              if (bounds.width <= 0 || bounds.height <= 0) return;
              setGridGeometry({
                width: bounds.width + terminalViewportGutter,
                height: bounds.height,
              });
            });
            const history = queuedHistory;
            queuedHistory = [];
            for (const data of history) {
              writeHistory(data);
            }
            if (
              historyStreamComplete &&
              pendingHistoryWrites === 0 &&
              queuedHistory.length === 0
            ) {
              replayingHistory = false;
            }
          } else if (message.type === "exit") {
            setConnection("exited");
            terminal.write(`\r\n\x1b[90m[process exited with code ${message.exitCode ?? "unknown"}]\x1b[0m\r\n`);
          } else if (message.type === "error" && message.message) {
            terminal.write(`\r\n\x1b[31m[${message.message}]\x1b[0m\r\n`);
          }
        });
        connectionSocket.addEventListener("close", () => {
          if (active) setConnection((current) => (current === "exited" ? current : "disconnected"));
        });
      })
      .catch(() => {
        if (active) setConnection("disconnected");
      });

    return () => {
      active = false;
      window.removeEventListener("resize", reportCapacity);
      resizeObserver?.disconnect();
      removeData();
      removeTitleChange?.();
      removeSelectionChange();
      clearTimeout(selectionTimer);
      clearTimeout(copiedTimer);
      if (gridMeasurementFrame !== undefined) {
        window.cancelAnimationFrame(gridMeasurementFrame);
      }
      socket?.close();
      terminal.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
      if (capacityReporterRef.current === reportCapacity) {
        capacityReporterRef.current = () => undefined;
      }
    };
  }, [api, createSocket, createTerminal, fontSize, reconnectSignal, session.id]);

  useEffect(() => {
    terminalRef.current?.setScrollback?.(terminalScrollback(terminalHistoryLimit));
  }, [terminalHistoryLimit]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (active && terminal) focusTerminal(terminal);
    capacityReporterRef.current();
  }, [active]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      capacityReporterRef.current();
    }, 50);
    return () => window.clearTimeout(timer);
  }, [layoutVersion]);

  const terminalHostStyle = gridGeometry
    ? ({
        "--terminal-grid-width": `${gridGeometry.width}px`,
        "--terminal-grid-height": `${gridGeometry.height}px`,
      } as CSSProperties)
    : undefined;
  const centerSharedGrid = Boolean(
    terminalHostStyle &&
      localSize &&
      sharedSize &&
      (sharedSize.cols < localSize.cols || sharedSize.rows < localSize.rows),
  );

  return (
    <div
      className="terminal-view"
      data-connection={connection}
      data-local-cols={localSize?.cols}
      data-local-rows={localSize?.rows}
      data-shared-cols={sharedSize?.cols}
      data-shared-rows={sharedSize?.rows}
    >
      <div
        className="terminal-host"
        ref={hostRef}
        aria-label={`${session.name} terminal`}
        data-centered={centerSharedGrid ? "true" : undefined}
        style={terminalHostStyle}
      />
      {copied && (
        <div className="copied-toast" data-slot="copied-toast" role="status">
          <CheckIcon data-slot="copied-icon" aria-hidden="true" />
          <span>Copied</span>
        </div>
      )}
    </div>
  );
}
