import { ApiClient } from "./api";
import type { SelectionSnapshot } from "./types";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

test("reads and replaces the shared v1 selection envelope", async () => {
  const selection: SelectionSnapshot = {
    terminalIds: ["terminal-1"],
    manualTerminalIds: ["terminal-1"],
    pinnedTerminalIds: [],
    focusedTerminalId: "terminal-1",
    filters: { statuses: [], cwds: [] },
    revision: 4,
  };
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() => jsonResponse({ ok: true, result: selection }))
    .mockImplementationOnce(() =>
      jsonResponse({ ok: true, result: { ...selection, revision: 5 } }),
    );
  const api = new ApiClient("token");

  expect(await api.getSelection()).toEqual(selection);
  expect(await api.replaceSelection({
    manualTerminalIds: ["terminal-1"],
    pinnedTerminalIds: [],
    focusedTerminalId: "terminal-1",
    filters: { statuses: [], cwds: [] },
    expectedRevision: 4,
  })).toEqual({ ...selection, revision: 5 });
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "/api/v1/selection",
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({
        manualTerminalIds: ["terminal-1"],
        pinnedTerminalIds: [],
        focusedTerminalId: "terminal-1",
        filters: { statuses: [], cwds: [] },
        expectedRevision: 4,
      }),
    }),
  );
});

test("creates and deletes terminals through v1 with returned selection", async () => {
  const selection: SelectionSnapshot = {
    terminalIds: ["terminal-1"],
    manualTerminalIds: ["terminal-1"],
    pinnedTerminalIds: [],
    focusedTerminalId: "terminal-1",
    filters: { statuses: [], cwds: [] },
    revision: 2,
  };
  const terminal = {
    id: "terminal-1",
    name: "Terminal",
    state: "running" as const,
    cwd: "/repo",
    createdAt: "2026-07-30T00:00:00Z",
  };
  vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() =>
      jsonResponse({ ok: true, result: { terminal, selection } }, 201),
    )
    .mockImplementationOnce(() =>
      jsonResponse({ ok: true, result: { id: terminal.id, selection } }),
    );
  const api = new ApiClient("token");

  expect(await api.createTerminal("Terminal", "/repo", "replace")).toEqual({
    terminal,
    selection,
  });
  expect(await api.deleteTerminal(terminal.id)).toEqual({
    id: terminal.id,
    selection,
  });
});

test("parses split NDJSON event chunks without losing records", async () => {
  const encoder = new TextEncoder();
  vi.spyOn(globalThis, "fetch").mockImplementationOnce(() =>
    Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          '{"sequence":1,"occurredAt":"2026-07-30T00:00:00Z","type":"terminal.created",',
        ));
        controller.enqueue(encoder.encode(
          '"data":{"id":"terminal-1"}}\n{"sequence":2,"occurredAt":"2026-07-30T00:00:01Z",',
        ));
        controller.enqueue(encoder.encode(
          '"type":"selection.changed","data":{"revision":2}}\n',
        ));
        controller.close();
      },
    }), {
      headers: { "Content-Type": "application/x-ndjson" },
    })),
  );
  const api = new ApiClient("token");
  const events: string[] = [];

  await api.subscribeEvents(new AbortController().signal, (event) => {
    events.push(event.type);
  });

  expect(events).toEqual(["terminal.created", "selection.changed"]);
});
