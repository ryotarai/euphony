import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CheckIcon } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import type { ApiClient } from "../api";
import {
  defaultTerminalCursorBlink,
  defaultTerminalCursorStyle,
  defaultTerminalFontFamily,
  defaultTerminalLineHeight,
  defaultTerminalOptionAsAlt,
  defaultTerminalScrollSensitivity,
} from "../settings";
import type { Session, TerminalCursorStyle } from "../types";
import {
  fitTerminalIfVisible,
  loadWebglRenderer,
  openTerminalLink,
  refreshTerminalIfVisible,
  terminalElementIsVisible,
  terminalOptions,
  terminalScrollback,
} from "./terminalUtils";

export interface TerminalDriver {
  readonly cols?: number;
  readonly rows?: number;
  open(element: HTMLElement): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  focus(): void;
  fit(): void;
  refresh?(): void;
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
  sourceVisible?: boolean;
  layoutVersion?: number;
  reconnectSignal?: number;
  terminalHistoryLimit?: number;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  cursorStyle?: TerminalCursorStyle;
  cursorBlink?: boolean;
  scrollSensitivity?: number;
  optionAsAlt?: boolean;
  onConnectionChange?(sessionID: string, state: ConnectionState): void;
  createTerminal?: (
    fontFamily: string,
    fontSize: number,
    scrollback: number,
    lineHeight: number,
    cursorStyle: TerminalCursorStyle,
    cursorBlink: boolean,
    scrollSensitivity: number,
    optionAsAlt: boolean,
  ) => TerminalDriver;
  createSocket?: (url: string) => WebSocketLike;
}

export type ConnectionState = "connecting" | "connected" | "disconnected" | "exited";

interface TerminalGridGeometry {
  width: number;
  height: number;
}

const terminalViewportGutter = 14;
const maxQueuedInitialTerminalBytes = 2 * 1024 * 1024;

function defaultTerminal(
  fontFamily: string,
  fontSize: number,
  scrollback: number,
  lineHeight: number,
  cursorStyle: TerminalCursorStyle,
  cursorBlink: boolean,
  scrollSensitivity: number,
  optionAsAlt: boolean,
): TerminalDriver {
  const fitAddon = new FitAddon();
  const terminal = new Terminal(terminalOptions(
    fontFamily,
    fontSize,
    scrollback,
    lineHeight,
    cursorStyle,
    cursorBlink,
    scrollSensitivity,
    optionAsAlt,
  ));
  terminal.loadAddon(fitAddon);
  return {
    get cols() {
      return terminal.cols;
    },
    get rows() {
      return terminal.rows;
    },
    open: (element) => {
      terminal.open(element);
      loadWebglRenderer(terminal);
    },
    write: (data, callback) => terminal.write(data, callback),
    focus: () => terminal.focus(),
    fit: () => fitAddon.fit(),
    refresh: () => terminal.refresh(0, terminal.rows - 1),
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

interface TerminalViewHookProps {
  session: Session;
  api: ApiClient;
  active: boolean;
  sourceVisible: boolean;
  layoutVersion: number;
  reconnectSignal: number;
  terminalHistoryLimit: number;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  scrollSensitivity: number;
  optionAsAlt: boolean;
  onConnectionChange?: (sessionID: string, state: ConnectionState) => void;
  createTerminal: NonNullable<TerminalViewProps["createTerminal"]>;
  createSocket: NonNullable<TerminalViewProps["createSocket"]>;
}

interface TerminalSocketHandlers {
  onOpen: () => void;
  onMessage: (event: Event) => void;
  onClose: () => void;
}

function subscribeToTerminalSocket(
  socket: WebSocketLike,
  handlers: TerminalSocketHandlers,
): () => void {
  socket.addEventListener("open", handlers.onOpen);
  socket.addEventListener("message", handlers.onMessage);
  socket.addEventListener("close", handlers.onClose);
  return () => {
    socket.removeEventListener("open", handlers.onOpen);
    socket.removeEventListener("message", handlers.onMessage);
    socket.removeEventListener("close", handlers.onClose);
  };
}

function useTerminalView({
  session,
  api,
  active,
  sourceVisible,
  layoutVersion,
  reconnectSignal,
  terminalHistoryLimit,
  fontFamily,
  fontSize,
  lineHeight,
  cursorStyle,
  cursorBlink,
  scrollSensitivity,
  optionAsAlt,
  onConnectionChange,
  createTerminal,
  createSocket,
}: TerminalViewHookProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<TerminalDriver | null>(null);
  const capacityReporterRef = useRef<() => void>(() => undefined);
  const activeRef = useRef(active);
  const sourceVisibleRef = useRef(sourceVisible);
  const sessionCwdRef = useRef(session.cwd);
  const terminalHistoryLimitRef = useRef(terminalHistoryLimit);
  const localSizeRef = useRef<{ cols: number; rows: number } | undefined>(undefined);
  const previousSourceVisibleRef = useRef(sourceVisible);
  const connectionStateRef = useRef<ConnectionState | undefined>(undefined);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [copied, setCopied] = useState(false);
  const [localSize, setLocalSize] = useState<{ cols: number; rows: number }>();
  const [sharedSize, setSharedSize] = useState<{ cols: number; rows: number }>();
  const [gridGeometry, setGridGeometry] = useState<TerminalGridGeometry>();
  const notifyConnectionChange = useEffectEvent((state: ConnectionState) => {
    onConnectionChange?.(session.id, state);
  });

  useLayoutEffect(() => {
    activeRef.current = active;
    sourceVisibleRef.current = sourceVisible;
    sessionCwdRef.current = session.cwd;
    terminalHistoryLimitRef.current = terminalHistoryLimit;
  }, [active, session.cwd, sourceVisible, terminalHistoryLimit]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let active = true;
    let replayingHistory = false;
    let acceptedSizeReceived = false;
    let queuedInitialData: Array<{
      data: Uint8Array;
      history: boolean;
    }> = [];
    let queuedInitialBytes = 0;
    let initialQueueOverflowed = false;
    const initialTerminalQueueLimit = terminalHistoryLimitRef.current > 0
      ? Math.min(
          maxQueuedInitialTerminalBytes,
          Math.max(1024, terminalHistoryLimitRef.current),
        )
      : maxQueuedInitialTerminalBytes;
    let pendingHistoryWrites = 0;
    let historyStreamComplete = false;
    let socket: WebSocketLike | undefined;
    let removeSocketListeners: (() => void) | undefined;
    let gridMeasurementFrame: number | undefined;
    let lastSize = "";
    let claimActive = false;
    let lastReportedCWD = sessionCwdRef.current;
    const closeSocket = () => {
      removeSocketListeners?.();
      removeSocketListeners = undefined;
      socket?.close();
      socket = undefined;
    };
    const setConnectionState = (next: ConnectionState) => {
      if (connectionStateRef.current === next) return;
      connectionStateRef.current = next;
      setConnection(next);
      notifyConnectionChange(next);
    };
    const terminal = createTerminal(
      fontFamily,
      fontSize,
      terminalScrollback(terminalHistoryLimitRef.current),
      lineHeight,
      cursorStyle,
      cursorBlink,
      scrollSensitivity,
      optionAsAlt,
    );
    terminalRef.current = terminal;
    terminal.open(host);
    if (activeRef.current) focusTerminal(terminal);
    setConnectionState("connecting");

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
    const queueInitialData = (data: Uint8Array, history: boolean) => {
      if (initialQueueOverflowed) return;
      if (queuedInitialBytes + data.byteLength > initialTerminalQueueLimit) {
        queuedInitialData = [];
        queuedInitialBytes = 0;
        initialQueueOverflowed = true;
        closeSocket();
        return;
      }
      queuedInitialData.push({ data, history });
      queuedInitialBytes += data.byteLength;
    };
    const reportCapacity = () => {
      if (!sourceVisibleRef.current) return;
      if (!terminalElementIsVisible(host)) {
        if (claimActive && send({ type: "resize_release" })) {
          claimActive = false;
          lastSize = "";
        }
        return;
      }
      refreshTerminalIfVisible(host, terminal);
      const dimensions = terminal.proposeDimensions?.();
      if (!dimensions || dimensions.cols < 1 || dimensions.rows < 1) return;
      const previousDimensions = localSizeRef.current;
      if (
        previousDimensions?.cols !== dimensions.cols ||
        previousDimensions.rows !== dimensions.rows
      ) {
        localSizeRef.current = dimensions;
        setLocalSize(dimensions);
      }
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
            queuedInitialData.length === 0
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
          queuedInitialData.length === 0
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
        if (!active) {
          connectionSocket.close();
          return;
        }
        socket = connectionSocket;
        const handleOpen = () => {
          if (!active) return;
          setConnectionState("connected");
          reportCapacity();
          if (activeRef.current) focusTerminal(terminal);
        };
        const handleMessage = (event: Event) => {
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
                queueInitialData(data, true);
              }
            } catch {
              // Ignore malformed terminal history.
            }
          } else if (message.type === "history_end") {
            historyStreamComplete = true;
            if (
              acceptedSizeReceived &&
              pendingHistoryWrites === 0 &&
              queuedInitialData.length === 0
            ) {
              replayingHistory = false;
            }
          } else if (message.type === "output" && message.data) {
            try {
              const data = decodeTerminalData(message.data);
              if (acceptedSizeReceived) {
                terminal.write(data);
              } else {
                queueInitialData(data, false);
              }
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
            refreshTerminalIfVisible(host, terminal);
            const acceptedSize = { cols: message.cols!, rows: message.rows! };
            acceptedSizeReceived = true;
            setSharedSize(acceptedSize);
            if (gridMeasurementFrame !== undefined) {
              window.cancelAnimationFrame(gridMeasurementFrame);
            }
            gridMeasurementFrame = window.requestAnimationFrame(() => {
              if (!active) return;
              const screen = host.querySelector<HTMLElement>(".xterm-screen");
              if (!screen) return;
              const bounds = screen.getBoundingClientRect();
              if (bounds.width <= 0 || bounds.height <= 0) return;
              setGridGeometry({
                width: bounds.width + terminalViewportGutter,
                height: bounds.height,
              });
            });
            const initialData = queuedInitialData;
            queuedInitialData = [];
            queuedInitialBytes = 0;
            for (const entry of initialData) {
              if (entry.history) {
                writeHistory(entry.data);
              } else {
                terminal.write(entry.data);
              }
            }
            if (
              historyStreamComplete &&
              pendingHistoryWrites === 0 &&
              queuedInitialData.length === 0
            ) {
              replayingHistory = false;
            }
          } else if (message.type === "exit") {
            setConnectionState("exited");
            terminal.write(`\r\n\x1b[90m[process exited with code ${message.exitCode ?? "unknown"}]\x1b[0m\r\n`);
          } else if (message.type === "error" && message.message) {
            terminal.write(`\r\n\x1b[31m[${message.message}]\x1b[0m\r\n`);
          }
        };
        const handleClose = () => {
          if (active && connectionStateRef.current !== "exited") {
            setConnectionState("disconnected");
          }
        };
        removeSocketListeners = subscribeToTerminalSocket(connectionSocket, {
          onOpen: handleOpen,
          onMessage: handleMessage,
          onClose: handleClose,
        });
      })
      .catch(() => {
        if (active) setConnectionState("disconnected");
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
      removeSocketListeners?.();
      removeSocketListeners = undefined;
      socket?.close();
      socket = undefined;
      terminal.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
      if (capacityReporterRef.current === reportCapacity) {
        capacityReporterRef.current = () => undefined;
      }
    };
  }, [
    api,
    createSocket,
    createTerminal,
    fontFamily,
    fontSize,
    lineHeight,
    cursorStyle,
    cursorBlink,
    scrollSensitivity,
    optionAsAlt,
    reconnectSignal,
    session.id,
  ]);

  useEffect(() => {
    terminalRef.current?.setScrollback?.(terminalScrollback(terminalHistoryLimit));
  }, [terminalHistoryLimit]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const host = hostRef.current;
    if (active && terminal) focusTerminal(terminal);
    const sourceVisibilityChanged =
      previousSourceVisibleRef.current !== sourceVisible;
    previousSourceVisibleRef.current = sourceVisible;
    if (sourceVisibilityChanged) {
      if (sourceVisible && host && terminal) {
        refreshTerminalIfVisible(host, terminal);
      }
      return;
    }
    capacityReporterRef.current();
  }, [active, sourceVisible]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    const terminal = terminalRef.current;
    if (host && terminal && gridGeometry) {
      refreshTerminalIfVisible(host, terminal);
    }
  }, [gridGeometry]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      capacityReporterRef.current();
    }, 50);
    return () => window.clearTimeout(timer);
  }, [layoutVersion]);

  return { copied, connection, gridGeometry, hostRef, localSize, sharedSize };
}

export function TerminalView({
  session,
  api,
  active = true,
  sourceVisible = true,
  layoutVersion = 1,
  reconnectSignal = 0,
  terminalHistoryLimit = 1024 * 1024,
  fontFamily = defaultTerminalFontFamily,
  fontSize = 14,
  lineHeight = defaultTerminalLineHeight,
  cursorStyle = defaultTerminalCursorStyle,
  cursorBlink = defaultTerminalCursorBlink,
  scrollSensitivity = defaultTerminalScrollSensitivity,
  optionAsAlt = defaultTerminalOptionAsAlt,
  onConnectionChange,
  createTerminal = defaultTerminal,
  createSocket = defaultSocket,
}: TerminalViewProps) {
  const { copied, connection, gridGeometry, hostRef, localSize, sharedSize } =
    useTerminalView({
      session,
      api,
      active,
      sourceVisible,
      layoutVersion,
      reconnectSignal,
      terminalHistoryLimit,
      fontFamily,
      fontSize,
      lineHeight,
      cursorStyle,
      cursorBlink,
      scrollSensitivity,
      optionAsAlt,
      onConnectionChange,
      createTerminal,
      createSocket,
    });

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
