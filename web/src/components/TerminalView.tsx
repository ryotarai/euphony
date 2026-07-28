import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { ApiClient } from "../api";
import type { Session } from "../types";

export interface TerminalDriver {
  open(element: HTMLElement): void;
  write(data: string): void;
  focus(): void;
  fit(): void;
  getSelection(): string;
  clearSelection(): void;
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
  createTerminal?: () => TerminalDriver;
  createSocket?: (url: string) => WebSocketLike;
}

function defaultTerminal(): TerminalDriver {
  const fitAddon = new FitAddon();
  const terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: "bar",
    allowTransparency: true,
    fontFamily: '"SFMono-Regular", "Cascadia Code", "Liberation Mono", monospace',
    fontSize: 14,
    lineHeight: 1.25,
    theme: {
      background: "#111417",
      foreground: "#dce5e8",
      cursor: "#b8f34a",
      selectionBackground: "#39442f",
      black: "#111417",
      red: "#ff6b5f",
      green: "#b8f34a",
      yellow: "#e4d36b",
      blue: "#72a7d8",
      magenta: "#b897d8",
      cyan: "#78c7c0",
      white: "#dce5e8",
      brightBlack: "#829099",
    },
  });
  terminal.loadAddon(fitAddon);
  return {
    open: (element) => terminal.open(element),
    write: (data) => terminal.write(data),
    focus: () => terminal.focus(),
    fit: () => fitAddon.fit(),
    getSelection: () => terminal.getSelection(),
    clearSelection: () => terminal.clearSelection(),
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
  createTerminal = defaultTerminal,
  createSocket = defaultSocket,
}: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
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
    const terminal = createTerminal();
    terminal.open(host);
    terminal.focus();
    setConnection("connecting");

    const send = (message: unknown) => {
      const currentSocket = socket;
      if (currentSocket && currentSocket.readyState === currentSocket.OPEN) {
        currentSocket.send(JSON.stringify(message));
      }
    };
    const removeData = terminal.onData((data) => {
      if (!replayingHistory) send({ type: "input", data });
    });
    const removeResize = terminal.onResize((cols, rows) => send({ type: "resize", cols, rows }));
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
          terminal.focus();
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
            try {
              terminal.write(message.data);
            } finally {
              replayingHistory = false;
            }
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
      removeData();
      removeResize();
      removeSelectionChange();
      clearTimeout(selectionTimer);
      clearTimeout(copiedTimer);
      socket?.close();
      terminal.dispose();
    };
  }, [api, attempt, createSocket, createTerminal, session.id]);

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
