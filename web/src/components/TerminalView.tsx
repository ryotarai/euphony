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
  createTerminalDiagnostics,
  type TerminalDiagnostics,
} from "./terminalDiagnostics";
import {
  fitTerminalIfVisible,
  openTerminalLink,
  refreshTerminalIfVisible,
  terminalElementIsVisible,
  terminalOptions,
  terminalScrollback,
} from "./terminalUtils";

export interface TerminalDriver {
  readonly cols?: number;
  readonly rows?: number;
  readonly cellHeight?: number;
  readonly activeBufferType?: "normal" | "alternate";
  readonly mouseTrackingMode?: "none" | "x10" | "vt200" | "drag" | "any";
  readonly applicationCursorKeysMode?: boolean;
  readonly fastScrollSensitivity?: number;
  input?(data: string, wasUserInput?: boolean): void;
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
  getScreenText?(): string;
  attachCustomKeyEventHandler?(handler: (event: KeyboardEvent) => boolean): void;
  attachCustomWheelEventHandler?(handler: (event: WheelEvent) => boolean): void;
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
  locked?: boolean;
  onScreenSnapshot?(getter: (() => string) | null): void;
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
// Coalesce PTY bursts without making terminal updates feel less responsive than roughly 25 fps.
const terminalOutputBatchWindowMs = 40;
// Let xterm's own write buffer handle output immediately after interactive input.
const terminalInteractiveOutputWindowMs = 100;

function createTerminalOutputBatcher(write: (data: Uint8Array) => void) {
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let timer: number | undefined;
  let interactive = false;
  let interactiveTimer: number | undefined;

  const cancelFlushTimer = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  };

  const flush = () => {
    cancelFlushTimer();
    if (pendingBytes === 0) return;
    const data = new Uint8Array(pendingBytes);
    let offset = 0;
    for (const chunk of pending) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    pending = [];
    pendingBytes = 0;
    write(data);
  };

  return {
    noteInput() {
      interactive = true;
      if (interactiveTimer !== undefined) window.clearTimeout(interactiveTimer);
      interactiveTimer = window.setTimeout(() => {
        interactive = false;
        interactiveTimer = undefined;
      }, terminalInteractiveOutputWindowMs);
      flush();
    },
    write(data: Uint8Array) {
      if (data.byteLength === 0) return;
      if (interactive) {
        flush();
        write(data);
        return;
      }
      pending.push(data);
      pendingBytes += data.byteLength;
      if (timer === undefined) {
        timer = window.setTimeout(flush, terminalOutputBatchWindowMs);
      }
    },
    flush,
    dispose() {
      cancelFlushTimer();
      if (interactiveTimer !== undefined) window.clearTimeout(interactiveTimer);
      interactiveTimer = undefined;
      interactive = false;
      flush();
    },
  };
}

function alternateBufferWheelInput(
  event: WheelEvent,
  terminal: Pick<
    TerminalDriver,
    | "activeBufferType"
    | "mouseTrackingMode"
    | "applicationCursorKeysMode"
    | "fastScrollSensitivity"
    | "cellHeight"
    | "rows"
  >,
  scrollSensitivity: number,
  partialScroll: { value: number },
): string | undefined {
  if (
    terminal.activeBufferType !== "alternate" ||
    terminal.mouseTrackingMode !== "none"
  ) {
    partialScroll.value = 0;
    return;
  }
  if (event.deltaY === 0) return;
  if (event.shiftKey) return "";

  const modifier = event.altKey || event.ctrlKey
    ? terminal.fastScrollSensitivity ?? 5
    : 1;
  let amount = event.deltaY * scrollSensitivity * modifier;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
    const cellHeight = terminal.cellHeight ?? 16;
    amount /= cellHeight;
    if (Math.abs(event.deltaY) < 50) amount *= 0.3;
    partialScroll.value += amount;
    amount = Math.floor(Math.abs(partialScroll.value)) *
      (partialScroll.value > 0 ? 1 : -1);
    partialScroll.value %= 1;
  } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    amount *= terminal.rows ?? 1;
  }

  const lines = Math.ceil(Math.abs(amount)) * (amount > 0 ? 1 : -1);
  if (lines === 0) return "";
  const cursorPrefix = terminal.applicationCursorKeysMode ? "\u001bO" : "\u001b[";
  const cursor = `${cursorPrefix}${event.deltaY < 0 ? "A" : "B"}`;
  return cursor.repeat(Math.abs(lines));
}

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
    get cellHeight() {
      const height = terminal.element?.getBoundingClientRect().height;
      return terminal.rows > 0 && height ? height / terminal.rows : undefined;
    },
    get activeBufferType() {
      return terminal.buffer.active.type;
    },
    get mouseTrackingMode() {
      return terminal.modes.mouseTrackingMode;
    },
    get applicationCursorKeysMode() {
      return terminal.modes.applicationCursorKeysMode;
    },
    get fastScrollSensitivity() {
      return terminal.options.fastScrollSensitivity;
    },
    input: (data, wasUserInput = true) => terminal.input(data, wasUserInput),
    open: (element) => {
      terminal.open(element);
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
    getScreenText: () => {
      const buffer = terminal.buffer.active;
      const lines: string[] = [];
      for (let row = 0; row < terminal.rows; row++) {
        lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
      }
      return lines.join("\n");
    },
    attachCustomKeyEventHandler: (handler) => terminal.attachCustomKeyEventHandler(handler),
    attachCustomWheelEventHandler: (handler) => terminal.attachCustomWheelEventHandler(handler),
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
  locked: boolean;
  onScreenSnapshot?: (getter: (() => string) | null) => void;
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
  locked,
  onScreenSnapshot,
  onConnectionChange,
  createTerminal,
  createSocket,
}: TerminalViewHookProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<TerminalDriver | null>(null);
  const capacityReporterRef = useRef<() => void>(() => undefined);
  const activeRef = useRef(active);
  const lockedRef = useRef(locked);
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
    lockedRef.current = locked;
    sourceVisibleRef.current = sourceVisible;
    sessionCwdRef.current = session.cwd;
    terminalHistoryLimitRef.current = terminalHistoryLimit;
  }, [active, locked, session.cwd, sourceVisible, terminalHistoryLimit]);

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
    let diagnostics: TerminalDiagnostics | undefined;
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
      diagnostics?.noteConnection(next);
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
    const partialWheelScroll = { value: 0 };
    terminalRef.current = terminal;
    terminal.open(host);
    diagnostics = createTerminalDiagnostics({ sessionID: session.id, host });
    const noteTerminalWrite = (
      data: string | Uint8Array,
      kind: "batch" | "history" | "direct",
    ) => {
      const bytes = typeof data === "string"
        ? new TextEncoder().encode(data).byteLength
        : data.byteLength;
      diagnostics?.noteWrite(bytes, kind);
    };
    const outputBatcher = createTerminalOutputBatcher((data) => {
      noteTerminalWrite(data, "batch");
      terminal.write(data);
    });
    onScreenSnapshot?.(() => terminal.getScreenText?.() ?? "");
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
    terminal.attachCustomWheelEventHandler?.((event) => {
      if (lockedRef.current) {
        event.preventDefault();
        partialWheelScroll.value = 0;
        return false;
      }
      const data = alternateBufferWheelInput(
        event,
        terminal,
        scrollSensitivity,
        partialWheelScroll,
      );
      if (data === undefined) return true;
      event.preventDefault();
      if (!data) return false;
      if (terminal.input) {
        terminal.input(data, true);
      } else {
        outputBatcher.noteInput();
        send({ type: "input", data });
      }
      return false;
    });
    const releaseCapacity = () => {
      if (claimActive && send({ type: "resize_release" })) {
        claimActive = false;
        lastSize = "";
      }
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
      if (host.closest('[aria-hidden="true"]')) {
        releaseCapacity();
        return;
      }
      if (!sourceVisibleRef.current) return;
      if (!terminalElementIsVisible(host)) {
        releaseCapacity();
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
        noteTerminalWrite(data, "history");
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
      if (lockedRef.current) {
        event.preventDefault();
        return false;
      }
      if (event.type !== "keydown" || event.isComposing || event.keyCode === 229) return true;
      if (event.key !== "Enter" || !event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
        return true;
      }
      event.preventDefault();
      send({ type: "input", data: "\n" });
      return false;
    });
    const removeData = terminal.onData((data) => {
      if (replayingHistory || lockedRef.current) return;
      outputBatcher.noteInput();
      send({ type: "input", data });
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
              diagnostics?.noteOutput(data.byteLength, true);
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
              diagnostics?.noteOutput(data.byteLength, false);
              if (acceptedSizeReceived) {
                outputBatcher.write(data);
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
            outputBatcher.flush();
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
                outputBatcher.write(entry.data);
              }
            }
            outputBatcher.flush();
            if (
              historyStreamComplete &&
              pendingHistoryWrites === 0 &&
              queuedInitialData.length === 0
            ) {
              replayingHistory = false;
            }
          } else if (message.type === "exit") {
            outputBatcher.flush();
            setConnectionState("exited");
            const data = `\r\n\x1b[90m[process exited with code ${message.exitCode ?? "unknown"}]\x1b[0m\r\n`;
            noteTerminalWrite(data, "direct");
            terminal.write(data);
          } else if (message.type === "error" && message.message) {
            outputBatcher.flush();
            const data = `\r\n\x1b[31m[${message.message}]\x1b[0m\r\n`;
            noteTerminalWrite(data, "direct");
            terminal.write(data);
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
      outputBatcher.dispose();
      diagnostics?.dispose();
      removeSocketListeners?.();
      removeSocketListeners = undefined;
      socket?.close();
      socket = undefined;
      terminal.dispose();
      onScreenSnapshot?.(null);
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
    onScreenSnapshot,
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
  locked = false,
  onScreenSnapshot,
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
      locked,
      onScreenSnapshot,
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
      data-locked={locked ? "true" : "false"}
    >
      {locked && (
        <div className="terminal-automation-lock" role="status">
          Inbox is controlling this terminal
        </div>
      )}
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
