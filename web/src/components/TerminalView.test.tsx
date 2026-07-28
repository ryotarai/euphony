import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TerminalView, type TerminalDriver, type WebSocketLike } from "./TerminalView";
import type { ApiClient } from "../api";
import type { Session } from "../types";

const runningSession: Session = {
  id: "session-1",
  name: "Codex",
  state: "running",
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

test("shows a reconnect action when the socket closes", async () => {
  const sockets = [new FakeSocket(), new FakeSocket()];
  const api = { createTicket: vi.fn().mockResolvedValue({ ticket: "ticket" }) } as unknown as ApiClient;
  const terminal: TerminalDriver = {
    open: () => undefined,
    write: () => undefined,
    focus: () => undefined,
    fit: () => undefined,
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
