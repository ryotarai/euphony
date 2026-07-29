import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { ApiClient } from "../api";
import type { Session } from "../types";

export interface TerminalDriver {
  readonly cols?: number;
  readonly rows?: number;
  open(element: HTMLElement): void;
  write(data: string, callback?: () => void): void;
  focus(): void;
  fit(): void;
  getSelection(): string;
  clearSelection(): void;
  attachCustomKeyEventHandler?(handler: (event: KeyboardEvent) => boolean): void;
  onSelectionChange(callback: () => void): () => void;
  onData(callback: (data: string) => void): () => void;
  onResize(callback: (cols: number, rows: number) => void): () => void;
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
  createTerminal?: () => TerminalDriver;
  createSocket?: (url: string) => WebSocketLike;
}

function defaultTerminal(): TerminalDriver {
  const fitAddon = new FitAddon();
  const terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: "bar",
    allowTransparency: true,
    fontFamily: 'Menlo, Monaco, "Hiragino Sans", "Yu Gothic", "Noto Sans Mono CJK JP", monospace',
    fontSize: 14,
    lineHeight: 1.25,
    scrollSensitivity: 3,
    theme: {
      background: "#18212f",
      foreground: "#e6edf7",
      cursor: "#60a5fa",
      selectionBackground: "#273f65",
      black: "#111827",
      red: "#f87171",
      green: "#4ade80",
      yellow: "#fbbf24",
      blue: "#60a5fa",
      magenta: "#c084fc",
      cyan: "#5eead4",
      white: "#e6edf7",
      brightBlack: "#8fa0b5",
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
    dispose: () => terminal.dispose(),
  };
}

function defaultSocket(url: string): WebSocketLike {
  return new WebSocket(url);
}

export function TerminalView({
  session,
  api,
  active = true,
  createTerminal = defaultTerminal,
  createSocket = defaultSocket,
}: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<TerminalDriver | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [connection, setConnection] = useState<"connecting" | "connected" | "disconnected" | "exited">(
    "connecting",
  );
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let active = true;
    let replayingHistory = false;
    let socket: WebSocketLike | undefined;
    let lastSize = "";
    const terminal = createTerminal();
    terminalRef.current = terminal;
    terminal.open(host);
    if (activeRef.current) terminal.focus();
    setConnection("connecting");

    const send = (message: unknown) => {
      const currentSocket = socket;
      if (currentSocket && currentSocket.readyState === currentSocket.OPEN) {
        currentSocket.send(JSON.stringify(message));
      }
    };
    const sendResize = (cols?: number, rows?: number) => {
      if (!cols || !rows) return;
      const size = `${cols}x${rows}`;
      if (size === lastSize) return;
      lastSize = size;
      send({ type: "resize", cols, rows });
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
    const removeResize = terminal.onResize(sendResize);
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
    const fit = () => terminal.fit();
    window.addEventListener("resize", fit);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(fit);
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
          terminal.fit();
          sendResize(terminal.cols, terminal.rows);
          if (activeRef.current) terminal.focus();
        });
        connectionSocket.addEventListener("message", (event) => {
          if (!active || !(event instanceof MessageEvent) || typeof event.data !== "string") return;
          const message = JSON.parse(event.data) as {
            type: string;
            data?: string;
            exitCode?: number;
            message?: string;
          };
          if (message.type === "history" && message.data) {
            replayingHistory = true;
            terminal.write(message.data, () => {
              replayingHistory = false;
            });
          } else if (message.type === "output" && message.data) {
            terminal.write(message.data);
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
      window.removeEventListener("resize", fit);
      resizeObserver?.disconnect();
      removeData();
      removeResize();
      removeSelectionChange();
      clearTimeout(selectionTimer);
      clearTimeout(copiedTimer);
      socket?.close();
      terminal.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
    };
  }, [api, attempt, createSocket, createTerminal, session.id]);

  useEffect(() => {
    if (active) terminalRef.current?.focus();
  }, [active]);

  return (
    <div className="terminal-view" data-connection={connection}>
      <div className="terminal-host" ref={hostRef} aria-label={`${session.name} terminal`} />
      {copied && (
        <div className="copied-toast" role="status">
          Copied
        </div>
      )}
      <div className="signal-status" aria-live="polite">
        <span>{connection}</span>
        {connection === "disconnected" && (
          <button onClick={() => setAttempt((value) => value + 1)}>Reconnect</button>
        )}
      </div>
    </div>
  );
}
