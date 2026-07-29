import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TerminalView, type TerminalDriver, type WebSocketLike } from "./TerminalView";
import type { ApiClient } from "../api";
import type { Session } from "../types";

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

test("gets a ticket before connecting and relays terminal traffic", async () => {
  const socket = new FakeSocket();
  const writes: string[] = [];
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
    socket.receive({ type: "output", data: "hello terminal" });
    onData?.("ls\r");
    onResize?.(100, 32);
  });

  expect(writes).toContain("hello terminal");
  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
    { type: "resize", cols: 120, rows: 40 },
    { type: "input", data: "ls\r" },
    { type: "resize", cols: 100, rows: 32 },
  ]);
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

test("shows a reconnect action when the socket closes", async () => {
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
  const user = userEvent.setup();

  render(
    <TerminalView
      session={runningSession}
      api={api}
      createTerminal={() => terminal}
      createSocket={createSocket}
    />,
  );
  await waitFor(() => expect(createSocket).toHaveBeenCalledTimes(1));
  act(() => createSocket.mock.results[0].value.dispatchEvent(new CloseEvent("close")));

  await user.click(await screen.findByRole("button", { name: "Reconnect" }));
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

test("does not send terminal query responses generated while replaying history", async () => {
  const socket = new FakeSocket();
  let onData: ((data: string) => void) | undefined;
  const writes: string[] = [];
  const terminal: TerminalDriver = {
    open: () => undefined,
    write: (data) => {
      writes.push(data);
      if (data.includes("query")) onData?.("\u001b[1;2R");
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

  act(() => socket.receive({ type: "history", data: "query" }));
  expect(writes).toEqual(["query"]);
  expect(socket.sent).toEqual([]);

  act(() => socket.receive({ type: "output", data: "query" }));
  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
    { type: "input", data: "\u001b[1;2R" },
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
  expect(screen.getByRole("status")).toHaveTextContent("Copied");

  act(() => {
    vi.advanceTimersByTime(1600);
  });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  vi.useRealTimers();
});
