import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  fitTerminalIfVisible,
  terminalScrollback,
  TerminalView,
  type TerminalDriver,
  type WebSocketLike,
} from "./TerminalView";
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

  send(data: string) {
    this.sent.push(data);
  }

  close() {}

  receive(message: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
}

test("does not fit xterm while its mounted tab panel is hidden", () => {
  const panel = document.createElement("div");
  const host = document.createElement("div");
  panel.append(host);
  document.body.append(panel);
  const terminal = { fit: vi.fn() };

  panel.hidden = true;
  fitTerminalIfVisible(host, terminal);
  expect(terminal.fit).not.toHaveBeenCalled();

  panel.hidden = false;
  fitTerminalIfVisible(host, terminal);
  expect(terminal.fit).toHaveBeenCalledTimes(1);
});

test("maps finite and unlimited history limits to xterm scrollback rows", () => {
  expect(terminalScrollback(1024 * 1024)).toBe(8192);
  expect(terminalScrollback(4095 * 1024 * 1024)).toBe(100000);
  expect(terminalScrollback(0)).toBe(4294967295);
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

test("creates and recreates xterm with the configured font size", async () => {
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
  const receivedFontSizes: number[] = [];
  const api = {
    createTicket: vi.fn().mockResolvedValue({ ticket: "one-time-ticket" }),
  } as unknown as ApiClient;
  const { rerender } = render(
    <TerminalView
      session={runningSession}
      api={api}
      fontSize={18}
      createTerminal={(fontSize) => {
        receivedFontSizes.push(fontSize);
        return terminal;
      }}
      createSocket={() => socket}
    />,
  );

  expect(receivedFontSizes).toEqual([18]);

  rerender(
    <TerminalView
      session={runningSession}
      api={api}
      fontSize={20}
      createTerminal={(fontSize) => {
        receivedFontSizes.push(fontSize);
        return terminal;
      }}
      createSocket={() => socket}
    />,
  );

  await waitFor(() => expect(receivedFontSizes).toEqual([18, 20]));
});

test("gets a ticket before connecting and relays terminal traffic", async () => {
  const socket = new FakeSocket();
  const writes: Array<string | Uint8Array> = [];
  let onData: ((data: string) => void) | undefined;
  let onResize: ((cols: number, rows: number) => void) | undefined;
  const terminal: TerminalDriver = {
    open: () => undefined,
    write: (data) => writes.push(data),
    focus: () => undefined,
    fit: () => onResize?.(120, 40),
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: (callback) => {
      onData = callback;
      return () => undefined;
    },
    onResize: (callback) => {
      onResize = callback;
      return () => undefined;
    },
    dispose: () => undefined,
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
    onResize?.(100, 32);
  });

  expect(writes.map(terminalText)).toContain("hello terminal");
  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
    { type: "resize", cols: 120, rows: 40 },
    { type: "input", data: "ls\r" },
    { type: "resize", cols: 100, rows: 32 },
  ]);
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

  act(() => socket.receive({ type: "output", data: "44GC" }));

  expect(writes).toEqual([new Uint8Array([0xe3, 0x81, 0x82])]);
});

test("sends a resize observed before the socket opens", async () => {
  const socket = new FakeSocket();
  socket.readyState = 0;
  let onResize: ((cols: number, rows: number) => void) | undefined;
  const terminal: TerminalDriver = {
    cols: 120,
    rows: 40,
    open: () => undefined,
    write: () => undefined,
    focus: () => undefined,
    fit: () => onResize?.(120, 40),
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: (callback) => {
      onResize = callback;
      return () => undefined;
    },
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

  act(() => onResize?.(120, 40));
  expect(socket.sent).toEqual([]);

  act(() => {
    socket.readyState = socket.OPEN;
    socket.dispatchEvent(new Event("open"));
  });

  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
    { type: "resize", cols: 120, rows: 40 },
  ]);
});

test("refits after the pane topology changes", async () => {
  vi.useFakeTimers();
  const terminal: TerminalDriver = {
    open: () => undefined,
    write: () => undefined,
    focus: () => undefined,
    fit: vi.fn(),
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    dispose: () => undefined,
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
  vi.mocked(terminal.fit).mockClear();

  rerender(<TerminalView {...props} layoutVersion={2} />);
  act(() => vi.advanceTimersByTime(49));
  expect(terminal.fit).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(terminal.fit).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});

test("fits the terminal when its pane changes size", async () => {
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
  const terminal: TerminalDriver = {
    open: () => undefined,
    write: () => undefined,
    focus: () => undefined,
    fit: vi.fn(),
    getSelection: () => "",
    clearSelection: () => undefined,
    onSelectionChange: () => () => undefined,
    onData: () => () => undefined,
    onResize: () => () => undefined,
    dispose: () => undefined,
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

  act(() => notifyResize?.());

  expect(observe).toHaveBeenCalledWith(screen.getByLabelText("Codex terminal"));
  expect(terminal.fit).toHaveBeenCalledTimes(1);
  unmount();
  expect(disconnect).toHaveBeenCalledTimes(1);
  vi.unstubAllGlobals();
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
