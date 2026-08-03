import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler } from "react";
import {
  TerminalView,
  type TerminalDriver,
  type WebSocketLike,
} from "./TerminalView";
import {
  fitTerminalIfVisible as fitTerminalIfVisibleUtil,
  loadWebglRenderer as loadWebglRendererUtil,
  openTerminalLink as openTerminalLinkUtil,
  terminalOptions as terminalOptionsUtil,
  terminalScrollback as terminalScrollbackUtil,
} from "./terminalUtils";
import type { ITerminalAddon } from "@xterm/xterm";
import type { ApiClient } from "../api";
import type { Session } from "../types";

afterEach(() => {
  vi.useRealTimers();
});

function encodeTerminalData(data: string): string {
  const bytes = new TextEncoder().encode(data);
  return btoa(String.fromCharCode(...bytes));
}

function terminalText(data: string | Uint8Array): string {
  return typeof data === "string" ? data : new TextDecoder().decode(data);
}

const runningSession: Session = {
  id: "session-1",
  name: "Codex",
  state: "running",
  cwd: "/workspace/euphony",
  createdAt: "2026-07-28T00:00:00Z",
};

class FakeSocket extends EventTarget implements WebSocketLike {
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  closeCount = 0;

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closeCount++;
  }

  receive(message: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
}

test("does not fit xterm beneath a hidden or aria-hidden panel", () => {
  const panel = document.createElement("div");
  const host = document.createElement("div");
  panel.append(host);
  document.body.append(panel);
  const terminal = { fit: vi.fn() };

  panel.hidden = true;
  fitTerminalIfVisibleUtil(host, terminal);
  expect(terminal.fit).not.toHaveBeenCalled();

  panel.hidden = false;
  fitTerminalIfVisibleUtil(host, terminal);
  expect(terminal.fit).toHaveBeenCalledTimes(1);

  panel.setAttribute("aria-hidden", "true");
  fitTerminalIfVisibleUtil(host, terminal);
  expect(terminal.fit).toHaveBeenCalledTimes(1);

  panel.setAttribute("aria-hidden", "false");
  fitTerminalIfVisibleUtil(host, terminal);
  expect(terminal.fit).toHaveBeenCalledTimes(2);
});

test("maps finite and unlimited history limits to xterm scrollback rows", () => {
  expect(terminalScrollbackUtil(1024 * 1024)).toBe(8192);
  expect(terminalScrollbackUtil(4095 * 1024 * 1024)).toBe(100000);
  expect(terminalScrollbackUtil(0)).toBe(4294967295);
});

test("treats macOS Option input as Alt in xterm", () => {
  expect(terminalOptionsUtil("monospace", 14, 1000, 1, "block", true, 1, true))
    .toMatchObject({ macOptionIsMeta: true });
  expect(terminalOptionsUtil("monospace", 14, 1000, 1, "block", true, 1, false))
    .toMatchObject({ macOptionIsMeta: false });
});

test("loads the WebGL addon into an xterm terminal", () => {
  const addon: ITerminalAddon = {
    activate: () => undefined,
    dispose: () => undefined,
  };
  const loadAddon = vi.fn();

  expect(loadWebglRendererUtil({ loadAddon }, () => addon)).toBe(true);
  expect(loadAddon).toHaveBeenCalledOnce();
  expect(loadAddon).toHaveBeenCalledWith(addon);
});

test("disposes the WebGL addon after a context loss", () => {
  let onContextLoss: (() => void) | undefined;
  const dispose = vi.fn();
  const addon = {
    activate: () => undefined,
    dispose,
    onContextLoss: (listener: () => void) => {
      onContextLoss = listener;
      return { dispose: () => undefined };
    },
  };
  const loadAddon = vi.fn();

  expect(loadWebglRendererUtil({ loadAddon }, () => addon)).toBe(true);
  expect(onContextLoss).toBeDefined();

  onContextLoss?.();

  expect(dispose).toHaveBeenCalledOnce();
});

test("keeps the DOM renderer when WebGL addon loading fails", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const loadAddon = vi.fn(() => {
    throw new Error("WebGL is unavailable");
  });

  expect(
    loadWebglRendererUtil(
      { loadAddon },
      () => ({
        activate: () => undefined,
        dispose: () => undefined,
      }),
    ),
  ).toBe(false);
  expect(warning).toHaveBeenCalledWith(
    "WebGL terminal renderer unavailable; using DOM renderer",
    expect.any(Error),
  );
});

test("opens an HTTP terminal link with one popup navigation", () => {
  const popup = { location: { href: "" }, opener: window } as unknown as Window;
  const open = vi.spyOn(window, "open").mockReturnValue(popup);
  const confirm = vi.spyOn(window, "confirm");

  openTerminalLinkUtil("https://example.com/docs");

  expect(confirm).not.toHaveBeenCalled();
  expect(open).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledWith(
    "https://example.com/docs",
    "_blank",
    "noopener,noreferrer",
  );
  expect(popup.opener).toBeNull();
  expect(popup.location.href).toBe("");
});

test("does not open non-HTTP terminal links", () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);

  openTerminalLinkUtil("javascript:alert(1)");

  expect(open).not.toHaveBeenCalled();
});

test("updates scrollback without reconnecting the terminal", async () => {
  const socket = new FakeSocket();
  const setScrollback = vi.fn();
  const terminal: TerminalDriver = {
    open: () => undefined,
    write: () => undefined,
    focus: () => undefined,
    fit: () => undefined,
    setScrollback,
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    dispose: () => undefined,
  };
  const api = {
    createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }),
  } as unknown as ApiClient;
  const createSocket = vi.fn(() => socket);
  const props = {
    session: runningSession,
    api,
    createTerminal: () => terminal,
    createSocket,
  };

  const { rerender } = render(
    <TerminalView {...props} terminalHistoryLimit={1024 * 1024} />,
  );
  await waitFor(() => expect(createSocket).toHaveBeenCalledTimes(1));
  setScrollback.mockClear();

  rerender(<TerminalView {...props} terminalHistoryLimit={0} />);

  expect(setScrollback).toHaveBeenCalledWith(4294967295);
  expect(createSocket).toHaveBeenCalledTimes(1);
});

test("creates and recreates xterm with configured font and appearance", async () => {
  const socket = new FakeSocket();
  const terminal: TerminalDriver = {
    open: () => undefined,
    write: () => undefined,
    focus: () => undefined,
    fit: () => undefined,
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    dispose: () => undefined,
  };
  const receivedOptions: Array<[
    string,
    number,
    number,
    number,
    string,
    boolean,
    number,
    boolean,
  ]> = [];
  const api = {
    createTicket: vi.fn().mockResolvedValue({ ticket: "one-time-ticket" }),
  } as unknown as ApiClient;
  const { rerender } = render(
    <TerminalView
      session={runningSession}
      api={api}
      fontFamily="JetBrains Mono, monospace"
      fontSize={18}
      lineHeight={1.5}
      cursorStyle="underline"
      cursorBlink
      scrollSensitivity={5}
      optionAsAlt={false}
      createTerminal={(fontFamily, fontSize, scrollback, lineHeight, cursorStyle, cursorBlink, scrollSensitivity, optionAsAlt) => {
        receivedOptions.push([
          fontFamily,
          fontSize,
          scrollback,
          lineHeight,
          cursorStyle,
          cursorBlink,
          scrollSensitivity,
          optionAsAlt,
        ]);
        return terminal;
      }}
      createSocket={() => socket}
    />,
  );

  expect(receivedOptions).toEqual([
    ["JetBrains Mono, monospace", 18, 8192, 1.5, "underline", true, 5, false],
  ]);

  rerender(
    <TerminalView
      session={runningSession}
      api={api}
      fontFamily="Iosevka, monospace"
      fontSize={20}
      lineHeight={1.75}
      cursorStyle="block"
      cursorBlink={false}
      scrollSensitivity={2}
      optionAsAlt
      createTerminal={(fontFamily, fontSize, scrollback, lineHeight, cursorStyle, cursorBlink, scrollSensitivity, optionAsAlt) => {
        receivedOptions.push([
          fontFamily,
          fontSize,
          scrollback,
          lineHeight,
          cursorStyle,
          cursorBlink,
          scrollSensitivity,
          optionAsAlt,
        ]);
        return terminal;
      }}
      createSocket={() => socket}
    />,
  );

  await waitFor(() =>
    expect(receivedOptions).toEqual([
      ["JetBrains Mono, monospace", 18, 8192, 1.5, "underline", true, 5, false],
      ["Iosevka, monospace", 20, 8192, 1.75, "block", false, 2, true],
    ]),
  );
});

test("gets a ticket before connecting and relays terminal traffic", async () => {
  const socket = new FakeSocket();
  const writes: Array<string | Uint8Array> = [];
  let onData: ((data: string) => void) | undefined;
  let capacity = { cols: 120, rows: 40 };
  const resize = vi.fn();
  const terminal = {
    open: () => undefined,
    write: (data) => writes.push(data),
    focus: () => undefined,
    fit: vi.fn(),
    proposeDimensions: () => capacity,
    resize,
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: (callback) => {
      onData = callback;
      return () => undefined;
    },
    onResize: () => () => undefined,
    dispose: () => undefined,
  } as TerminalDriver & {
    proposeDimensions(): { cols: number; rows: number };
    resize(cols: number, rows: number): void;
  };
  const api = {
    createTicket: vi.fn().mockResolvedValue({ ticket: "one-time-ticket" }),
  } as unknown as ApiClient;
  const createSocket = vi.fn((_url: string) => socket);

  render(
    <TerminalView
      session={runningSession}
      api={api}
      createTerminal={() => terminal}
      createSocket={createSocket}
    />,
  );

  await waitFor(() => expect(createSocket).toHaveBeenCalledTimes(1));
  expect(createSocket.mock.calls[0][0]).toContain("ticket=one-time-ticket");

  act(() => {
    socket.dispatchEvent(new Event("open"));
    socket.receive({ type: "output", data: encodeTerminalData("hello terminal") });
    onData?.("ls\r");
    socket.receive({ type: "resize", cols: 100, rows: 32 });
    capacity = { cols: 110, rows: 36 };
    window.dispatchEvent(new Event("resize"));
  });

  expect(writes.map(terminalText)).toContain("hello terminal");
  expect(resize).toHaveBeenCalledWith(100, 32);
  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
    { type: "resize", cols: 120, rows: 40 },
    { type: "input", data: "ls\r" },
    { type: "resize", cols: 110, rows: 36 },
  ]);
});

test("centers the accepted shared grid without scaling it", async () => {
  const socket = new FakeSocket();
  let screenElement: HTMLDivElement | undefined;
  let terminalElement: HTMLDivElement | undefined;
  let screenWidth = 1200;
  let screenHeight = 800;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  const terminal = {
    open: (host: HTMLElement) => {
      terminalElement = document.createElement("div");
      terminalElement.className = "xterm";
      screenElement = document.createElement("div");
      screenElement.className = "xterm-screen";
      screenElement.getBoundingClientRect = () => ({
        x: 0,
        y: 0,
        top: 0,
        right: screenWidth,
        bottom: screenHeight,
        left: 0,
        width: screenWidth,
        height: screenHeight,
        toJSON: () => ({}),
      });
      terminalElement.append(screenElement);
      host.append(terminalElement);
    },
    write: () => undefined,
    focus: () => undefined,
    fit: () => undefined,
    proposeDimensions: () => ({ cols: 120, rows: 40 }),
    resize: (cols: number, rows: number) => {
      screenWidth = cols * 10;
      screenHeight = rows * 20;
    },
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    dispose: () => terminalElement?.remove(),
  } as TerminalDriver & {
    proposeDimensions(): { cols: number; rows: number };
    resize(cols: number, rows: number): void;
  };
  const api = {
    createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }),
  } as unknown as ApiClient;

  render(
    <TerminalView
      session={runningSession}
      api={api}
      createTerminal={() => terminal}
      createSocket={() => socket}
    />,
  );
  await waitFor(() => expect(api.createTicket).toHaveBeenCalled());

  act(() => {
    socket.dispatchEvent(new Event("open"));
    socket.receive({ type: "resize", cols: 80, rows: 24 });
  });

  const view = screen.getByLabelText("Codex terminal").closest(".terminal-view")!;
  expect(view).toHaveAttribute("data-local-cols", "120");
  expect(view).toHaveAttribute("data-local-rows", "40");
  expect(view).toHaveAttribute("data-shared-cols", "80");
  expect(view).toHaveAttribute("data-shared-rows", "24");
  const host = screen.getByLabelText("Codex terminal");
  expect(host).toHaveAttribute("data-centered", "true");
  expect(host.style.getPropertyValue("--terminal-grid-width")).toBe("814px");
  expect(host.style.getPropertyValue("--terminal-grid-height")).toBe("480px");
  expect(view.querySelector(".terminal-size-padding")).not.toBeInTheDocument();

  act(() => socket.receive({ type: "resize", cols: 120, rows: 40 }));

  expect(host).not.toHaveAttribute("data-centered");
});

test("holds history and live output until the first accepted size is applied", async () => {
  const socket = new FakeSocket();
  const operations: string[] = [];
  const terminal = {
    open: () => undefined,
    write: (data: string | Uint8Array, callback?: () => void) => {
      operations.push(`write:${terminalText(data)}`);
      callback?.();
    },
    focus: () => undefined,
    fit: () => undefined,
    proposeDimensions: () => ({ cols: 120, rows: 40 }),
    resize: (cols: number, rows: number) => {
      operations.push(`resize:${cols}x${rows}`);
    },
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    dispose: () => undefined,
  } as TerminalDriver & {
    proposeDimensions(): { cols: number; rows: number };
    resize(cols: number, rows: number): void;
  };
  const api = {
    createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }),
  } as unknown as ApiClient;

  render(
    <TerminalView
      session={runningSession}
      api={api}
      createTerminal={() => terminal}
      createSocket={() => socket}
    />,
  );
  await waitFor(() => expect(api.createTicket).toHaveBeenCalled());

  act(() => {
    socket.receive({ type: "history", data: encodeTerminalData("previous output") });
    socket.receive({ type: "history_end" });
    socket.receive({ type: "output", data: encodeTerminalData("live output") });
  });
  expect(operations).toEqual([]);

  act(() => socket.receive({ type: "resize", cols: 80, rows: 24 }));
  expect(operations).toEqual([
    "resize:80x24",
    "write:previous output",
    "write:live output",
  ]);
});

test("closes instead of buffering unbounded output before the first size", async () => {
  const socket = new FakeSocket();
  const writes: unknown[] = [];
  const terminal = {
    open: () => undefined,
    write: (data: string | Uint8Array) => writes.push(data),
    focus: () => undefined,
    fit: () => undefined,
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    dispose: () => undefined,
  } as TerminalDriver;
  const api = {
    createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }),
  } as unknown as ApiClient;

  render(
    <TerminalView
      session={runningSession}
      api={api}
      terminalHistoryLimit={1024}
      createTerminal={() => terminal}
      createSocket={() => socket}
    />,
  );
  await waitFor(() => expect(api.createTicket).toHaveBeenCalled());

  const chunk = btoa("x".repeat(600));
  act(() => {
    socket.receive({ type: "output", data: chunk });
    socket.receive({ type: "output", data: chunk });
  });

  expect(socket.closeCount).toBe(1);
  expect(writes).toEqual([]);
});

test("reports an absolute terminal title as the current working directory", async () => {
  const socket = new FakeSocket();
  let onTitleChange: ((title: string) => void) | undefined;
  const terminal = {
    open: () => undefined,
    write: () => undefined,
    focus: () => undefined,
    fit: () => undefined,
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    onTitleChange: (callback: (title: string) => void) => {
      onTitleChange = callback;
      return () => undefined;
    },
    dispose: () => undefined,
  } as TerminalDriver & {
    onTitleChange(callback: (title: string) => void): () => void;
  };
  const api = {
    createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }),
  } as unknown as ApiClient;

  render(
    <TerminalView
      session={runningSession}
      api={api}
      createTerminal={() => terminal}
      createSocket={() => socket}
    />,
  );
  await waitFor(() => expect(api.createTicket).toHaveBeenCalled());

  act(() => {
    onTitleChange?.("vim README.md");
    onTitleChange?.("/tmp");
  });

  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
    { type: "cwd", data: "/tmp" },
  ]);
});

test("does not report a stale working directory from replayed history", async () => {
  const socket = new FakeSocket();
  let onTitleChange: ((title: string) => void) | undefined;
  const terminal = {
    open: () => undefined,
    write: (data: string | Uint8Array, callback?: () => void) => {
      const title = terminalText(data).includes("stale") ? "/stale" : "/etc";
      onTitleChange?.(title);
      callback?.();
    },
    focus: () => undefined,
    fit: () => undefined,
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    onTitleChange: (callback: (title: string) => void) => {
      onTitleChange = callback;
      return () => undefined;
    },
    dispose: () => undefined,
  } as TerminalDriver & {
    onTitleChange(callback: (title: string) => void): () => void;
  };
  const api = {
    createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }),
  } as unknown as ApiClient;

  render(
    <TerminalView
      session={runningSession}
      api={api}
      createTerminal={() => terminal}
      createSocket={() => socket}
    />,
  );
  await waitFor(() => expect(api.createTicket).toHaveBeenCalled());

  act(() => {
    socket.receive({ type: "resize", cols: 80, rows: 24 });
    socket.receive({ type: "history", data: encodeTerminalData("stale title") });
    socket.receive({ type: "history_end" });
  });
  expect(socket.sent).toEqual([]);

  act(() => socket.receive({ type: "output", data: encodeTerminalData("current title") }));
  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
    { type: "cwd", data: "/etc" },
  ]);
});

test("decodes terminal output into the original bytes", async () => {
  const socket = new FakeSocket();
  const writes: unknown[] = [];
  const terminal: TerminalDriver = {
    open: () => undefined,
    write: (data) => writes.push(data),
    focus: () => undefined,
    fit: () => undefined,
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    dispose: () => undefined,
  };
  const api = { createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }) } as unknown as ApiClient;

  render(
    <TerminalView
      session={runningSession}
      api={api}
      createTerminal={() => terminal}
      createSocket={() => socket}
    />,
  );
  await waitFor(() => expect(api.createTicket).toHaveBeenCalled());

  act(() => {
    socket.receive({ type: "resize", cols: 80, rows: 24 });
    socket.receive({ type: "output", data: "44GC" });
  });

  expect(writes).toEqual([new Uint8Array([0xe3, 0x81, 0x82])]);
});

test("sends the latest measured capacity when the socket opens", async () => {
  const socket = new FakeSocket();
  socket.readyState = 0;
  let capacity = { cols: 100, rows: 30 };
  const terminal = {
    open: () => undefined,
    write: () => undefined,
    focus: () => undefined,
    fit: () => undefined,
    proposeDimensions: () => capacity,
    resize: () => undefined,
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    dispose: () => undefined,
  } as TerminalDriver & {
    proposeDimensions(): { cols: number; rows: number };
    resize(cols: number, rows: number): void;
  };
  const api = { createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }) } as unknown as ApiClient;

  render(
    <TerminalView
      session={runningSession}
      api={api}
      createTerminal={() => terminal}
      createSocket={() => socket}
    />,
  );
  await waitFor(() => expect(api.createTicket).toHaveBeenCalled());

  capacity = { cols: 120, rows: 40 };
  act(() => window.dispatchEvent(new Event("resize")));
  expect(socket.sent).toEqual([]);

  act(() => {
    socket.readyState = socket.OPEN;
    socket.dispatchEvent(new Event("open"));
  });

  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
    { type: "resize", cols: 120, rows: 40 },
  ]);
});

test("remeasures capacity after the pane topology changes", async () => {
  vi.useFakeTimers();
  const proposeDimensions = vi.fn(() => ({ cols: 120, rows: 40 }));
  const terminal = {
    open: () => undefined,
    write: () => undefined,
    focus: () => undefined,
    fit: () => undefined,
    proposeDimensions,
    resize: () => undefined,
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    dispose: () => undefined,
  } as TerminalDriver & {
    proposeDimensions(): { cols: number; rows: number };
    resize(cols: number, rows: number): void;
  };
  const api = { createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }) } as unknown as ApiClient;
  const props = {
    session: runningSession,
    api,
    createTerminal: () => terminal,
    createSocket: () => new FakeSocket(),
  };
  const { rerender } = render(<TerminalView {...props} layoutVersion={1} />);
  await act(async () => Promise.resolve());
  act(() => vi.advanceTimersByTime(50));
  proposeDimensions.mockClear();

  rerender(<TerminalView {...props} layoutVersion={2} />);
  act(() => vi.advanceTimersByTime(49));
  expect(proposeDimensions).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(proposeDimensions).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});

test("remeasures terminal capacity when its pane changes size", async () => {
  let notifyResize: (() => void) | undefined;
  const observe = vi.fn();
  const disconnect = vi.fn();
  class FakeResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      notifyResize = () => callback([], this as unknown as ResizeObserver);
    }

    observe = observe;
    unobserve = vi.fn();
    disconnect = disconnect;
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  const proposeDimensions = vi.fn(() => ({ cols: 100, rows: 32 }));
  const terminal = {
    open: () => undefined,
    write: () => undefined,
    focus: () => undefined,
    fit: () => undefined,
    proposeDimensions,
    resize: () => undefined,
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    dispose: () => undefined,
  } as TerminalDriver & {
    proposeDimensions(): { cols: number; rows: number };
    resize(cols: number, rows: number): void;
  };
  const api = { createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }) } as unknown as ApiClient;

  const { unmount } = render(
    <TerminalView
      session={runningSession}
      api={api}
      createTerminal={() => terminal}
      createSocket={() => new FakeSocket()}
    />,
  );
  await waitFor(() => expect(api.createTicket).toHaveBeenCalled());
  proposeDimensions.mockClear();

  act(() => notifyResize?.());

  expect(observe).toHaveBeenCalledWith(screen.getByLabelText("Codex terminal"));
  expect(proposeDimensions).toHaveBeenCalledTimes(1);
  unmount();
  expect(disconnect).toHaveBeenCalledTimes(1);
  vi.unstubAllGlobals();
});

test("removes WebSocket listeners before closing on unmount", async () => {
  const socket = new FakeSocket();
  const removeEventListener = vi.spyOn(socket, "removeEventListener");
  const close = vi.spyOn(socket, "close");
  const terminal: TerminalDriver = {
    open: () => undefined,
    write: () => undefined,
    focus: () => undefined,
    fit: () => undefined,
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    dispose: () => undefined,
  };
  const api = {
    createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }),
  } as unknown as ApiClient;
  const createSocket = vi.fn(() => socket);

  const { unmount } = render(
    <TerminalView
      session={runningSession}
      api={api}
      createTerminal={() => terminal}
      createSocket={createSocket}
    />,
  );
  await waitFor(() => expect(createSocket).toHaveBeenCalledTimes(1));

  unmount();

  expect(removeEventListener).toHaveBeenCalledWith("open", expect.any(Function));
  expect(removeEventListener).toHaveBeenCalledWith("message", expect.any(Function));
  expect(removeEventListener).toHaveBeenCalledWith("close", expect.any(Function));
  expect(close).toHaveBeenCalledOnce();
});

test("does not create a WebSocket when a ticket resolves after unmount", async () => {
  let resolveTicket: (value: { ticket: string }) => void = () => undefined;
  const ticket = new Promise<{ ticket: string }>((resolve) => {
    resolveTicket = resolve;
  });
  const api = {
    createTicket: vi.fn(() => ticket),
  } as unknown as ApiClient;
  const createSocket = vi.fn(() => new FakeSocket());
  const terminal: TerminalDriver = {
    open: () => undefined,
    write: () => undefined,
    focus: () => undefined,
    fit: () => undefined,
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    dispose: () => undefined,
  };

  const { unmount } = render(
    <TerminalView
      session={runningSession}
      api={api}
      createTerminal={() => terminal}
      createSocket={createSocket}
    />,
  );
  unmount();

  await act(async () => {
    resolveTicket({ ticket: "late-ticket" });
    await Promise.resolve();
  });

  expect(createSocket).not.toHaveBeenCalled();
});

test("repaints the terminal when its host layout changes without changing capacity", async () => {
  let notifyResize: (() => void) | undefined;
  class FakeResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      notifyResize = () => callback([], this as unknown as ResizeObserver);
    }

    observe = vi.fn();
    disconnect = vi.fn();
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  const refresh = vi.fn();
  const terminal = {
    open: () => undefined,
    write: () => undefined,
    focus: () => undefined,
    fit: () => undefined,
    refresh,
    proposeDimensions: () => ({ cols: 100, rows: 32 }),
    resize: () => undefined,
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    dispose: () => undefined,
  } as TerminalDriver & {
    refresh(): void;
    proposeDimensions(): { cols: number; rows: number };
    resize(cols: number, rows: number): void;
  };
  const api = {
    createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }),
  } as unknown as ApiClient;

  render(
    <TerminalView
      session={runningSession}
      api={api}
      createTerminal={() => terminal}
      createSocket={() => new FakeSocket()}
    />,
  );
  await waitFor(() => expect(api.createTicket).toHaveBeenCalled());
  refresh.mockClear();

  act(() => notifyResize?.());

  expect(refresh).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});

test("does not commit a render when measured capacity is unchanged", async () => {
  const socket = new FakeSocket();
  const terminal = {
    open: () => undefined,
    write: () => undefined,
    focus: () => undefined,
    fit: () => undefined,
    refresh: () => undefined,
    proposeDimensions: () => ({ cols: 100, rows: 32 }),
    resize: () => undefined,
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    dispose: () => undefined,
  } as TerminalDriver & {
    refresh(): void;
    proposeDimensions(): { cols: number; rows: number };
    resize(cols: number, rows: number): void;
  };
  const api = {
    createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }),
  } as unknown as ApiClient;
  let commits = 0;

  render(
    <Profiler id="terminal" onRender={() => commits++}>
      <TerminalView
        session={runningSession}
        api={api}
        createTerminal={() => terminal}
        createSocket={() => socket}
      />
    </Profiler>,
  );
  await waitFor(() => expect(api.createTicket).toHaveBeenCalled());
  act(() => socket.dispatchEvent(new Event("open")));
  await waitFor(() =>
    expect(screen.getByLabelText("Codex terminal").parentElement)
      .toHaveAttribute("data-local-cols", "100")
  );
  const commitsBeforeResize = commits;

  act(() => window.dispatchEvent(new Event("resize")));

  expect(commits).toBe(commitsBeforeResize);
});

test("reports connection changes and retries without rendering pane-local status", async () => {
  const sockets = [new FakeSocket(), new FakeSocket()];
  const api = { createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }) } as unknown as ApiClient;
  const terminal: TerminalDriver = {
    open: () => undefined,
    write: () => undefined,
    focus: () => undefined,
    fit: () => undefined,
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    dispose: () => undefined,
  };
  const createSocket = vi.fn((_url: string) => sockets.shift()!);
  const onConnectionChange = vi.fn();

  const { rerender } = render(
    <TerminalView
      session={runningSession}
      api={api}
      createTerminal={() => terminal}
      createSocket={createSocket}
      reconnectSignal={0}
      onConnectionChange={onConnectionChange}
    />,
  );
  await waitFor(() => expect(createSocket).toHaveBeenCalledTimes(1));
  expect(onConnectionChange).toHaveBeenCalledWith("session-1", "connecting");

  act(() => createSocket.mock.results[0].value.dispatchEvent(new Event("open")));
  expect(onConnectionChange).toHaveBeenCalledWith("session-1", "connected");
  expect(screen.queryByText("connected")).not.toBeInTheDocument();

  act(() => createSocket.mock.results[0].value.dispatchEvent(new CloseEvent("close")));
  expect(onConnectionChange).toHaveBeenCalledWith("session-1", "disconnected");
  expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();

  rerender(
    <TerminalView
      session={runningSession}
      api={api}
      createTerminal={() => terminal}
      createSocket={createSocket}
      reconnectSignal={1}
      onConnectionChange={onConnectionChange}
    />,
  );
  await waitFor(() => expect(createSocket).toHaveBeenCalledTimes(2));
});

test("focuses the terminal only when its pane becomes active", async () => {
  const socket = new FakeSocket();
  const focus = vi.fn();
  const terminal: TerminalDriver = {
    open: () => undefined,
    write: () => undefined,
    focus,
    fit: () => undefined,
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    dispose: () => undefined,
  };
  const api = { createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }) } as unknown as ApiClient;
  const createTerminal = () => terminal;
  const createSocket = () => socket;
  const { rerender } = render(
    <TerminalView
      session={runningSession}
      api={api}
      active={false}
      createTerminal={createTerminal}
      createSocket={createSocket}
    />,
  );
  await waitFor(() => expect(api.createTicket).toHaveBeenCalled());
  expect(focus).not.toHaveBeenCalled();

  rerender(
    <TerminalView
      session={runningSession}
      api={api}
      active
      createTerminal={createTerminal}
      createSocket={createSocket}
    />,
  );

  expect(focus).toHaveBeenCalledTimes(1);
});

test("reports capacity while its visible source is in an inactive pane", async () => {
  const socket = new FakeSocket();
  let capacity = { cols: 100, rows: 30 };
  const terminal = {
    open: () => undefined,
    write: () => undefined,
    focus: () => undefined,
    fit: () => undefined,
    proposeDimensions: () => capacity,
    resize: () => undefined,
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    dispose: () => undefined,
  } as TerminalDriver & {
    proposeDimensions(): { cols: number; rows: number };
    resize(cols: number, rows: number): void;
  };
  const api = {
    createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }),
  } as unknown as ApiClient;

  render(
    <TerminalView
      session={runningSession}
      api={api}
      active={false}
      sourceVisible
      createTerminal={() => terminal}
      createSocket={() => socket}
    />,
  );
  await waitFor(() => expect(api.createTicket).toHaveBeenCalled());
  act(() => socket.dispatchEvent(new Event("open")));
  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
    { type: "resize", cols: 100, rows: 30 },
  ]);

  capacity = { cols: 90, rows: 25 };
  act(() => window.dispatchEvent(new Event("resize")));
  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
    { type: "resize", cols: 100, rows: 30 },
    { type: "resize", cols: 90, rows: 25 },
  ]);
});

test("releases a hidden terminal capacity and reports it again when visible", async () => {
  const socket = new FakeSocket();
  const terminal = {
    open: () => undefined,
    write: () => undefined,
    focus: () => undefined,
    fit: () => undefined,
    proposeDimensions: () => ({ cols: 120, rows: 40 }),
    resize: () => undefined,
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    dispose: () => undefined,
  } as TerminalDriver & {
    proposeDimensions(): { cols: number; rows: number };
    resize(cols: number, rows: number): void;
  };
  const api = {
    createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }),
  } as unknown as ApiClient;
  const createTerminal = () => terminal;
  const createSocket = () => socket;
  const view = (hidden: boolean) => (
    <div hidden={hidden}>
      <TerminalView
        session={runningSession}
        api={api}
        active={!hidden}
        createTerminal={createTerminal}
        createSocket={createSocket}
      />
    </div>
  );

  const { rerender } = render(view(false));
  await waitFor(() => expect(api.createTicket).toHaveBeenCalled());
  act(() => socket.dispatchEvent(new Event("open")));
  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
    { type: "resize", cols: 120, rows: 40 },
  ]);

  rerender(view(true));
  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
    { type: "resize", cols: 120, rows: 40 },
    { type: "resize_release" },
  ]);

  rerender(view(false));
  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
    { type: "resize", cols: 120, rows: 40 },
    { type: "resize_release" },
    { type: "resize", cols: 120, rows: 40 },
  ]);
});

test("releases capacity without measuring or refreshing beneath an aria-hidden pane", async () => {
  const socket = new FakeSocket();
  const refresh = vi.fn();
  const proposeDimensions = vi.fn(() => ({ cols: 120, rows: 40 }));
  const terminal = {
    open: () => undefined,
    write: () => undefined,
    focus: () => undefined,
    fit: () => undefined,
    refresh,
    proposeDimensions,
    resize: () => undefined,
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    dispose: () => undefined,
  } as TerminalDriver & {
    refresh(): void;
    proposeDimensions(): { cols: number; rows: number };
    resize(cols: number, rows: number): void;
  };
  const api = {
    createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }),
  } as unknown as ApiClient;
  const props = {
    session: runningSession,
    api,
    createTerminal: () => terminal,
    createSocket: () => socket,
  };
  const view = (hidden: boolean) => (
    <div aria-hidden={hidden}>
      <TerminalView {...props} active={!hidden} />
    </div>
  );

  const { rerender } = render(view(false));
  await waitFor(() => expect(api.createTicket).toHaveBeenCalled());
  act(() => socket.dispatchEvent(new Event("open")));
  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
    { type: "resize", cols: 120, rows: 40 },
  ]);
  refresh.mockClear();
  proposeDimensions.mockClear();

  rerender(view(true));

  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
    { type: "resize", cols: 120, rows: 40 },
    { type: "resize_release" },
  ]);
  expect(refresh).not.toHaveBeenCalled();
  expect(proposeDimensions).not.toHaveBeenCalled();
});

test("retains terminal capacity while its source tab is hidden", async () => {
  const socket = new FakeSocket();
  let capacity = { cols: 120, rows: 40 };
  const terminal = {
    open: () => undefined,
    write: () => undefined,
    focus: () => undefined,
    fit: () => undefined,
    proposeDimensions: () => capacity,
    resize: () => undefined,
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    dispose: () => undefined,
  } as TerminalDriver & {
    proposeDimensions(): { cols: number; rows: number };
    resize(cols: number, rows: number): void;
  };
  const api = {
    createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }),
  } as unknown as ApiClient;
  const createTerminal = () => terminal;
  const createSocket = () => socket;
  const view = (sourceActive: boolean, hidden = !sourceActive) => (
    <div hidden={hidden}>
      <TerminalView
        session={runningSession}
        api={api}
        active={sourceActive}
        sourceVisible={sourceActive}
        createTerminal={createTerminal}
        createSocket={createSocket}
      />
    </div>
  );

  const { rerender } = render(view(true));
  await waitFor(() => expect(api.createTicket).toHaveBeenCalled());
  act(() => socket.dispatchEvent(new Event("open")));
  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
    { type: "resize", cols: 120, rows: 40 },
  ]);

  capacity = { cols: 60, rows: 10 };
  rerender(view(false, false));
  act(() => window.dispatchEvent(new Event("resize")));
  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
    { type: "resize", cols: 120, rows: 40 },
  ]);

  rerender(view(false));
  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
    { type: "resize", cols: 120, rows: 40 },
  ]);

  capacity = { cols: 120, rows: 40 };
  rerender(view(true));
  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
    { type: "resize", cols: 120, rows: 40 },
  ]);
});

test("does not steal focus from an open modal when the terminal connects", async () => {
  const socket = new FakeSocket();
  const focus = vi.fn();
  const terminal: TerminalDriver = {
    open: () => undefined,
    write: () => undefined,
    focus,
    fit: () => undefined,
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    dispose: () => undefined,
  };
  const api = {
    createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }),
  } as unknown as ApiClient;

  render(
    <>
      <div role="dialog" aria-modal="true">
        <input aria-label="Quick action input" autoFocus />
      </div>
      <TerminalView
        session={runningSession}
        api={api}
        createTerminal={() => terminal}
        createSocket={() => socket}
      />
    </>,
  );
  await waitFor(() => expect(api.createTicket).toHaveBeenCalled());

  act(() => socket.dispatchEvent(new Event("open")));

  expect(screen.getByLabelText("Quick action input")).toHaveFocus();
  expect(focus).not.toHaveBeenCalled();
});

test("does not send terminal query responses generated while replaying history", async () => {
  const socket = new FakeSocket();
  let onData: ((data: string) => void) | undefined;
  const writes: string[] = [];
  const terminal: TerminalDriver = {
    open: () => undefined,
    write: (data, callback) => {
      const text = terminalText(data);
      writes.push(text);
      if (text.includes("query")) onData?.("\u001b[1;2R");
      callback?.();
    },
    focus: () => undefined,
    fit: () => undefined,
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: (callback) => {
      onData = callback;
      return () => undefined;
    },
    onResize: () => () => undefined,
    dispose: () => undefined,
  };
  const api = { createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }) } as unknown as ApiClient;

  render(
    <TerminalView
      session={runningSession}
      api={api}
      createTerminal={() => terminal}
      createSocket={() => socket}
    />,
  );
  await waitFor(() => expect(api.createTicket).toHaveBeenCalled());

  act(() => {
    socket.receive({ type: "resize", cols: 80, rows: 24 });
    socket.receive({ type: "history", data: encodeTerminalData("query") });
    socket.receive({ type: "history_end" });
  });
  expect(writes).toEqual(["query"]);
  expect(socket.sent).toEqual([]);

  act(() => socket.receive({ type: "output", data: encodeTerminalData("query") }));
  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
    { type: "input", data: "\u001b[1;2R" },
  ]);
});

test("keeps replay-generated terminal replies suppressed until the write completes", async () => {
  const socket = new FakeSocket();
  let onData: ((data: string) => void) | undefined;
  const finishWrites: Array<() => void> = [];
  const terminal: TerminalDriver = {
    open: () => undefined,
    write: (_data, callback) => {
      if (callback) finishWrites.push(callback);
    },
    focus: () => undefined,
    fit: () => undefined,
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: (callback) => {
      onData = callback;
      return () => undefined;
    },
    onResize: () => () => undefined,
    dispose: () => undefined,
  };
  const api = { createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }) } as unknown as ApiClient;

  render(
    <TerminalView
      session={runningSession}
      api={api}
      createTerminal={() => terminal}
      createSocket={() => socket}
    />,
  );
  await waitFor(() => expect(api.createTicket).toHaveBeenCalled());

  act(() => {
    socket.receive({ type: "resize", cols: 80, rows: 24 });
    socket.receive({ type: "history", data: encodeTerminalData("first \u001b[c") });
    socket.receive({ type: "history", data: encodeTerminalData("second \u001b[c") });
    socket.receive({ type: "history_end" });
    onData?.("\u001b[?1;2c");
  });
  expect(socket.sent).toEqual([]);

  act(() => {
    finishWrites[0]?.();
    onData?.("\u001b[?1;2c");
  });
  expect(socket.sent).toEqual([]);

  act(() => {
    finishWrites[1]?.();
    onData?.("pwd\r");
  });
  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
    { type: "input", data: "pwd\r" },
  ]);
});

test("sends LF for Shift+Enter without submitting the prompt", async () => {
  const socket = new FakeSocket();
  let keyHandler: ((event: KeyboardEvent) => boolean) | undefined;
  const terminal: TerminalDriver = {
    open: () => undefined,
    write: () => undefined,
    focus: () => undefined,
    fit: () => undefined,
    getSelection: () => "",
    clearSelection: () => undefined,
    attachCustomKeyEventHandler: (handler) => {
      keyHandler = handler;
    },
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    dispose: () => undefined,
  };
  const api = { createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }) } as unknown as ApiClient;

  render(
    <TerminalView
      session={runningSession}
      api={api}
      createTerminal={() => terminal}
      createSocket={() => socket}
    />,
  );
  await waitFor(() => expect(api.createTicket).toHaveBeenCalled());

  const event = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true });
  act(() => {
    expect(keyHandler?.(event)).toBe(false);
  });
  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
    { type: "input", data: "\n" },
  ]);
});

test("copies a completed selection and then clears it", async () => {
  vi.useFakeTimers();
  let onSelectionChange: (() => void) | undefined;
  const clearSelection = vi.fn();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const terminal: TerminalDriver = {
    open: () => undefined,
    write: () => undefined,
    focus: () => undefined,
    fit: () => undefined,
    getSelection: () => "selected output",
    clearSelection,
    onSelectionChange: (callback) => {
      onSelectionChange = callback;
      return () => undefined;
    },
    onData: () => () => undefined,
    onResize: () => () => undefined,
    dispose: () => undefined,
  };
  const api = { createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }) } as unknown as ApiClient;

  render(
    <TerminalView
      session={runningSession}
      api={api}
      createTerminal={() => terminal}
      createSocket={() => new FakeSocket()}
    />,
  );

  act(() => {
    onSelectionChange?.();
    vi.advanceTimersByTime(150);
  });
  await act(async () => {
    await Promise.resolve();
  });

  expect(writeText).toHaveBeenCalledWith("selected output");
  expect(clearSelection).toHaveBeenCalledTimes(1);
  const toast = screen.getByRole("status");
  expect(toast).toHaveTextContent("Copied");
  expect(toast).toHaveAttribute("data-slot", "copied-toast");
  expect(toast.querySelector('[data-slot="copied-icon"]')).toBeInTheDocument();

  act(() => {
    vi.advanceTimersByTime(1600);
  });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  vi.useRealTimers();
});
