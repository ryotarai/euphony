import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, type ComponentProps } from "react";
import { App, agentRunningTransitions, attentionTransitions } from "./App";
import type { SelectionSnapshot, Session, Settings } from "./types";

const defaultSettings: Settings = {
  prefix: "Ctrl+B",
  paneTabShortcut: "Meta+L",
  sidebarWidth: 304,
  sidebarCollapsed: false,
  interfaceFontSize: 16,
  terminalFontSize: 14,
  terminalFontFamily:
    'Menlo, Monaco, "Hiragino Sans", "Yu Gothic", "Noto Sans Mono CJK JP", monospace',
  agentLogFontSize: 14,
  terminalHistoryLimit: 1024 * 1024,
  autoSelectAttention: true,
  autoDeselectRunning: true,
  terminalLineHeight: 1.25,
  terminalCursorStyle: "bar",
  terminalCursorBlink: false,
  terminalScrollSensitivity: 3,
  terminalOptionAsAlt: true,
};

const runningSession: Session = {
  id: "session-1",
  name: "Codex",
  state: "running",
  cwd: "/workspace/euphony",
  agent: "codex",
  agentStatus: "running",
  agentTitle: "Implement v0.2",
  createdAt: "2026-07-28T00:00:00Z",
};

const secondRunningSession: Session = {
  id: "session-2",
  name: "Claude",
  state: "running",
  cwd: "/workspace/website",
  agent: "claude",
  agentStatus: "waiting",
  agentTitle: "Needs approval",
  createdAt: "2026-07-28T00:01:00Z",
};

const thirdRunningSession: Session = {
  id: "session-3",
  name: "Terminal",
  state: "running",
  cwd: "/workspace/api",
  agent: "codex",
  agentStatus: "running",
  agentTitle: "Fix API",
  createdAt: "2026-07-28T00:02:00Z",
};

const plainTerminalSession: Session = {
  id: "session-plain",
  name: "Terminal",
  state: "running",
  cwd: "/workspace/shell",
  createdAt: "2026-07-28T00:03:00Z",
};

function expectTerminalPaneHidden(label: string) {
  const pane = screen.queryByLabelText(label);
  if (pane) {
    const container = pane.closest(".terminal-pane");
    expect(container).toHaveAttribute("data-visible", "false");
    expect(container).toHaveAttribute("inert");
  }
}

test("uses the server selection as authoritative and persists browser changes", async () => {
  history.replaceState(null, "", "/?terminal=session-2");
  const initialSelection = {
    terminalIds: ["session-1"],
    manualTerminalIds: ["session-1"],
    pinnedTerminalIds: [],
    focusedTerminalId: "session-1",
    filters: { statuses: [], cwds: [] },
    revision: 7,
  };
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input, init) => {
      if (input === "/api/sessions") {
        return jsonResponse([runningSession, secondRunningSession]);
      }
      if (input === "/api/v1/selection" && (!init || init.method === undefined)) {
        return jsonResponse({ ok: true, result: initialSelection });
      }
      if (input === "/api/v1/selection" && init?.method === "PUT") {
        const request = JSON.parse(String(init.body)) as {
          manualTerminalIds: string[];
          pinnedTerminalIds: string[];
          focusedTerminalId: string;
          filters: { statuses: string[]; cwds: unknown[] };
          pinnedFilters: { statuses: string[]; cwds: unknown[] };
          expectedRevision: number;
        };
        return jsonResponse({
          ok: true,
          result: {
            terminalIds: request.manualTerminalIds,
            manualTerminalIds: request.manualTerminalIds,
            pinnedTerminalIds: request.pinnedTerminalIds,
            focusedTerminalId: request.focusedTerminalId,
            filters: request.filters,
            pinnedFilters: request.pinnedFilters,
            revision: 8,
          },
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    },
  );
  const user = userEvent.setup();
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncEvents={false}
      renderTerminal={(session) => (
        <div aria-label={`${session.name} terminal pane`} />
      )}
    />,
  );

  expect(await screen.findByLabelText("Codex terminal pane")).toBeVisible();
  expect(screen.queryByLabelText("Claude terminal pane")).not.toBeInTheDocument();
  expect(new URLSearchParams(window.location.search).getAll("terminal")).toEqual([
    "session-1",
  ]);

  await user.click(screen.getByRole("button", { name: "Select Claude" }));
  await waitFor(() => {
    const update = fetchMock.mock.calls.find(
      ([input, init]) =>
        input === "/api/v1/selection" && init?.method === "PUT",
    );
    expect(update).toBeDefined();
    expect(JSON.parse(String(update?.[1]?.body))).toEqual({
      manualTerminalIds: ["session-2"],
      pinnedTerminalIds: [],
      focusedTerminalId: "session-2",
      filters: { statuses: [], cwds: [] },
      pinnedFilters: { statuses: [], cwds: [] },
      expectedRevision: 7,
    });
  });
  expect(await screen.findByLabelText("Claude terminal pane")).toBeVisible();
});

test("keeps terminal views alive across terminal switches", async () => {
  const mounts = new Map<string, number>();
  const unmounts = new Map<string, number>();
  function TerminalLifetimeProbe({ id }: { id: string }) {
    useEffect(() => {
      mounts.set(id, (mounts.get(id) ?? 0) + 1);
      return () => {
        unmounts.set(id, (unmounts.get(id) ?? 0) + 1);
      };
    }, [id]);
    return <div aria-label={`${id} terminal pane`} />;
  }

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (input === "/api/sessions") {
      return jsonResponse([runningSession, secondRunningSession]);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();
  render(
    <App
      syncSelection={false}
      syncEvents={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <TerminalLifetimeProbe id={session.id} />}
    />,
  );

  expect(await screen.findByLabelText("session-1 terminal pane")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Select Claude" }));
  expect(await screen.findByLabelText("session-2 terminal pane")).toBeVisible();

  expect(mounts.get("session-1")).toBe(1);
  expect(unmounts.get("session-1") ?? 0).toBe(0);
  expect(document.querySelector('[aria-label="Codex pane"]'))
    .toHaveAttribute("data-visible", "false");

  await user.click(screen.getByRole("button", { name: "Select Codex" }));
  expect(await screen.findByLabelText("session-1 terminal pane")).toBeVisible();
  expect(mounts.get("session-1")).toBe(1);
  expect(unmounts.get("session-1") ?? 0).toBe(0);
});

test("serializes rapid shared-selection writes and rebases the latest state", async () => {
  let releaseFirstWrite: (() => void) | undefined;
  const firstWriteGate = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  const writes: Array<{
    manualTerminalIds: string[];
    focusedTerminalId: string;
    expectedRevision: number;
  }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions") {
      return jsonResponse([runningSession, secondRunningSession]);
    }
    if (input === "/api/v1/selection" && (!init || init.method === undefined)) {
      return jsonResponse({
        ok: true,
        result: {
          terminalIds: ["session-1"],
          manualTerminalIds: ["session-1"],
          pinnedTerminalIds: [],
          focusedTerminalId: "session-1",
          filters: { statuses: [], cwds: [] },
          revision: 7,
        },
      });
    }
    if (input === "/api/v1/selection" && init?.method === "PUT") {
      const request = JSON.parse(String(init.body)) as {
        manualTerminalIds: string[];
        focusedTerminalId: string;
        expectedRevision: number;
      };
      writes.push(request);
      if (writes.length === 1) await firstWriteGate;
      return jsonResponse({
        ok: true,
        result: {
          terminalIds: request.manualTerminalIds,
          manualTerminalIds: request.manualTerminalIds,
          pinnedTerminalIds: [],
          focusedTerminalId: request.focusedTerminalId,
          filters: { statuses: [], cwds: [] },
          revision: 7 + writes.length,
        },
      });
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncEvents={false}
      renderTerminal={(session) => <div>{session.id}</div>}
    />,
  );
  await screen.findByText("session-1");

  await user.click(screen.getByRole("button", { name: "Select Claude" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  await user.click(screen.getByRole("button", { name: "Select Codex" }));
  expect(writes).toHaveLength(1);
  releaseFirstWrite?.();

  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes.map((request) => ({
    ids: request.manualTerminalIds,
    focus: request.focusedTerminalId,
    revision: request.expectedRevision,
  }))).toEqual([
    { ids: ["session-2"], focus: "session-2", revision: 7 },
    { ids: ["session-1"], focus: "session-1", revision: 8 },
  ]);
});

test("retries a conflicting shared-selection write against the latest revision", async () => {
  let selectionReads = 0;
  const writes: Array<{ manualTerminalIds: string[]; expectedRevision: number }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions") {
      return jsonResponse([runningSession, secondRunningSession]);
    }
    if (input === "/api/v1/selection" && (!init || init.method === undefined)) {
      selectionReads++;
      const revision = selectionReads === 1 ? 7 : 8;
      return jsonResponse({
        ok: true,
        result: {
          terminalIds: ["session-1"],
          manualTerminalIds: ["session-1"],
          pinnedTerminalIds: [],
          focusedTerminalId: "session-1",
          filters: { statuses: [], cwds: [] },
          revision,
        },
      });
    }
    if (input === "/api/v1/selection" && init?.method === "PUT") {
      const request = JSON.parse(String(init.body)) as {
        manualTerminalIds: string[];
        expectedRevision: number;
      };
      writes.push(request);
      if (writes.length === 1) {
        return jsonResponse(
          {
            ok: false,
            error: {
              code: "selection_conflict",
              message: "stale",
              details: {},
            },
          },
          409,
        );
      }
      return jsonResponse({
        ok: true,
        result: {
          terminalIds: request.manualTerminalIds,
          manualTerminalIds: request.manualTerminalIds,
          pinnedTerminalIds: [],
          focusedTerminalId: "session-2",
          filters: { statuses: [], cwds: [] },
          revision: 9,
        },
      });
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncEvents={false}
      renderTerminal={(session) => <div>{session.id}</div>}
    />,
  );
  await screen.findByText("session-1");

  await user.click(screen.getByRole("button", { name: "Select Claude" }));

  await waitFor(() => expect(writes).toHaveLength(2));
  expect(
    writes.map(({ manualTerminalIds, expectedRevision }) => ({
      manualTerminalIds,
      expectedRevision,
    })),
  ).toEqual([
    { manualTerminalIds: ["session-2"], expectedRevision: 7 },
    { manualTerminalIds: ["session-2"], expectedRevision: 8 },
  ]);
  expect(await screen.findByText("session-2")).toBeVisible();
});

test("applies a remote selection event without writing it back", async () => {
  const encoder = new TextEncoder();
  let eventController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input, init) => {
      if (input === "/api/sessions") {
        return jsonResponse([runningSession, secondRunningSession]);
      }
      if (input === "/api/v1/selection" && (!init || init.method === undefined)) {
        return jsonResponse({
          ok: true,
          result: {
            terminalIds: ["session-1"],
            manualTerminalIds: ["session-1"],
            pinnedTerminalIds: [],
            focusedTerminalId: "session-1",
            filters: { statuses: [], cwds: [] },
            revision: 3,
          },
        });
      }
      if (input === "/api/v1/events") {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            eventController = controller;
          },
        }), {
          headers: { "Content-Type": "application/x-ndjson" },
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    },
  );
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => (
        <div aria-label={`${session.name} terminal pane`} />
      )}
    />,
  );
  await screen.findByLabelText("Codex terminal pane");
  await waitFor(() => expect(eventController).toBeDefined());

  eventController?.enqueue(encoder.encode(JSON.stringify({
    sequence: 9,
    occurredAt: "2026-07-30T00:00:00Z",
    type: "selection.changed",
    data: {
      terminalIds: ["session-1", "session-2"],
      manualTerminalIds: ["session-1"],
      pinnedTerminalIds: ["session-2"],
      focusedTerminalId: "session-2",
      filters: { statuses: [], cwds: [] },
      revision: 4,
    },
  }) + "\n"));

  expect(await screen.findByLabelText("Claude terminal pane")).toBeVisible();
  expect(screen.getByLabelText("Claude pane")).toHaveAttribute("data-active", "true");
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  expect(fetchMock.mock.calls.some(
    ([input, init]) =>
      input === "/api/v1/selection" && init?.method === "PUT",
  )).toBe(false);
  eventController?.close();
});

test("rediscovers an annotation created before the event subscription starts", async () => {
  let annotationReads = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions") {
      return jsonResponse([runningSession]);
    }
    if (input === "/api/v1/selection" && (!init || init.method === undefined)) {
      return jsonResponse({
        ok: true,
        result: {
          terminalIds: ["session-1"],
          manualTerminalIds: ["session-1"],
          pinnedTerminalIds: [],
          focusedTerminalId: "session-1",
          filters: { statuses: [], cwds: [] },
          revision: 3,
        },
      });
    }
    if (input === "/api/v1/terminals/session-1/annotation") {
      annotationReads++;
      return jsonResponse({
        ok: true,
        result: {
          annotation: annotationReads === 1
            ? null
            : {
              id: "annotation-1",
              terminalId: "session-1",
              filename: "review.md",
              format: "markdown",
              content: "# Review",
              createdAt: "2026-07-30T00:00:00Z",
            },
        },
      });
    }
    if (input === "/api/v1/events") {
      return new Response(new ReadableStream<Uint8Array>(), {
        headers: { "Content-Type": "application/x-ndjson" },
      });
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });

  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={() => <div>terminal</div>}
    />,
  );

  expect(await screen.findByRole("tab", { name: "Annotation" }))
    .toHaveAttribute("data-active");
  expect(annotationReads).toBeGreaterThanOrEqual(2);
});

test("detects only new transitions into attention", () => {
  const attention = { ...runningSession, needsAttention: true };
  expect(attentionTransitions([runningSession], [attention])).toEqual([attention]);
  expect(attentionTransitions([attention], [attention])).toEqual([]);
});

test("detects agent running transitions", () => {
  const waiting = { ...secondRunningSession, agentStatus: "waiting" };
  const running = { ...waiting, agentStatus: "running" };
  const plain = { ...plainTerminalSession };
  expect(
    agentRunningTransitions(
      [waiting, runningSession, plain],
      [running, runningSession, { ...plain, agentStatus: "running" }],
    ),
  ).toEqual([running]);
});

test("acknowledges a need-attention terminal when it receives focus", async () => {
  const attention = { ...secondRunningSession, needsAttention: true };
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([runningSession, attention]))
    .mockImplementationOnce(() =>
      jsonResponse({ ...attention, needsAttention: false }),
    );
  const user = userEvent.setup();
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => (
        <div aria-label={`${session.name} ${session.agentStatus}`} />
      )}
    />,
  );

  await user.click(await screen.findByRole("button", { name: "Select Claude" }));

  await waitFor(() => {
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/sessions/session-2/acknowledge-attention",
      expect.objectContaining({ method: "POST" }),
    );
  });
  expect(await screen.findByLabelText("Claude waiting")).toBeVisible();
});

test("selects attention transitions without moving focus or acknowledging them", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockImplementationOnce(() =>
        jsonResponse([runningSession, secondRunningSession, thirdRunningSession]),
      )
      .mockImplementation(() =>
        jsonResponse([
          runningSession,
          { ...secondRunningSession, needsAttention: true },
          { ...thirdRunningSession, needsAttention: true },
        ]),
      );
    render(
      <App
        syncSelection={false}
        initialToken="valid-token"
        initialSettings={defaultSettings}
        renderTerminal={(session, _api, active) => (
          <div
            aria-label={`${session.id} terminal pane`}
            data-active={String(active)}
          />
        )}
      />,
    );

    expect(await screen.findByLabelText("session-1 terminal pane")).toHaveAttribute(
      "data-active",
      "true",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(await screen.findByLabelText("session-2 terminal pane")).toHaveAttribute(
      "data-active",
      "false",
    );
    expect(screen.getByLabelText("session-3 terminal pane")).toHaveAttribute(
      "data-active",
      "false",
    );
    expect(screen.getByRole("button", { name: "Select Codex" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByRole("button", { name: "Select Claude" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith("/acknowledge-attention") &&
          init?.method === "POST",
      ),
    ).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("persists auto-selected attention terminals in the shared selection", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    let sessionReads = 0;
    const writes: Array<{
      manualTerminalIds: string[];
      focusedTerminalId: string;
      expectedRevision: number;
    }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (input === "/api/sessions") {
        sessionReads++;
        return jsonResponse(
          sessionReads === 1
            ? [runningSession, secondRunningSession]
            : [
                runningSession,
                { ...secondRunningSession, needsAttention: true },
              ],
        );
      }
      if (input === "/api/v1/selection" && (!init || init.method === undefined)) {
        return jsonResponse({
          ok: true,
          result: {
            terminalIds: ["session-1"],
            manualTerminalIds: ["session-1"],
            pinnedTerminalIds: [],
            focusedTerminalId: "session-1",
            filters: { statuses: [], cwds: [] },
            revision: 7,
          },
        });
      }
      if (input === "/api/v1/selection" && init?.method === "PUT") {
        const request = JSON.parse(String(init.body)) as {
          manualTerminalIds: string[];
          focusedTerminalId: string;
          expectedRevision: number;
          pinnedTerminalIds: string[];
          filters: { statuses: string[]; cwds: unknown[] };
        };
        writes.push(request);
        return jsonResponse({
          ok: true,
          result: {
            terminalIds: request.manualTerminalIds,
            manualTerminalIds: request.manualTerminalIds,
            pinnedTerminalIds: request.pinnedTerminalIds,
            focusedTerminalId: request.focusedTerminalId,
            filters: request.filters,
            revision: 8,
          },
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    render(
      <App
        initialToken="valid-token"
        initialSettings={defaultSettings}
        syncEvents={false}
        renderTerminal={(session, _api, active) => (
          <div
            aria-label={`${session.id} terminal pane`}
            data-active={String(active)}
          />
        )}
      />,
    );
    await screen.findByLabelText("session-1 terminal pane");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual(expect.objectContaining({
      manualTerminalIds: ["session-1", "session-2"],
      focusedTerminalId: "session-1",
      expectedRevision: 7,
    }));
    expect(screen.getByLabelText("session-2 terminal pane")).toHaveAttribute(
      "data-active",
      "false",
    );
  } finally {
    vi.useRealTimers();
  }
});

test("does not select attention transitions when auto-selection is disabled", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockImplementationOnce(() =>
        jsonResponse([runningSession, secondRunningSession]),
      )
      .mockImplementation(() =>
        jsonResponse([
          runningSession,
          { ...secondRunningSession, needsAttention: true },
        ]),
      );
    render(
      <App
        syncSelection={false}
        initialToken="valid-token"
        initialSettings={{
          ...defaultSettings,
          autoSelectAttention: false,
        }}
        renderTerminal={(session) => (
          <div aria-label={`${session.id} terminal pane`} />
        )}
      />,
    );

    await screen.findByLabelText("session-1 terminal pane");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(screen.queryByLabelText("session-2 terminal pane")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select Claude" })).not.toHaveAttribute(
      "aria-current",
    );
  } finally {
    vi.useRealTimers();
  }
});

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

test("stores a valid token and starts one terminal when the session list is empty", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([]))
    .mockImplementationOnce(() => jsonResponse(runningSession, 201));
  const user = userEvent.setup();
  render(
    <App syncSelection={false}
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div>{session.name}</div>}
    />,
  );

  await user.type(screen.getByLabelText("Access token"), "valid-token");
  await user.click(screen.getByRole("button", { name: "Open Euphony" }));

  expect(await screen.findByRole("button", { name: "Select Codex" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/sessions",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ name: "Terminal" }),
    }),
  );
  expect(sessionStorage.getItem("euphony.token")).toBe("valid-token");
});

test("consumes a token from the URL without leaving it in browser history", async () => {
  history.replaceState(null, "", "/?token=development-token");
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([]))
    .mockImplementationOnce(() => jsonResponse(runningSession, 201));

  render(
    <App syncSelection={false}
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div>{session.name}</div>}
    />,
  );

  expect(await screen.findByRole("button", { name: "Select Codex" })).toBeVisible();
  expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
  expect(new URLSearchParams(window.location.search).has("token")).toBe(false);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/sessions",
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer development-token" }),
    }),
  );
});

test("returns to token entry after an invalid token", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse({ code: "unauthorized", message: "A valid access token is required." }, 401),
  );
  const user = userEvent.setup();
  render(<App syncSelection={false} initialSettings={defaultSettings} />);

  await user.type(screen.getByLabelText("Access token"), "invalid-token");
  await user.click(screen.getByRole("button", { name: "Open Euphony" }));

  expect(await screen.findByText("That token was not accepted.")).toBeVisible();
  expect(sessionStorage.getItem("euphony.token")).toBeNull();
});

test("creates a terminal in the cwd chosen from the sidebar", async () => {
  const created = {
    ...plainTerminalSession,
    id: "cwd-created",
    cwd: secondRunningSession.cwd,
    processName: "sh",
  };
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() =>
      jsonResponse([runningSession, secondRunningSession]),
    )
    .mockImplementationOnce(() => jsonResponse(created, 201));

  const user = userEvent.setup();
  render(
    <App
      syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div>{session.id}</div>}
    />,
  );

  await user.click(
    await screen.findByRole("button", {
      name: "Create terminal in /workspace/website",
    }),
  );

  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "/api/sessions",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ name: "Terminal", cwd: "/workspace/website" }),
    }),
  );
  const selectedTerminal = await screen.findByRole("button", {
    name: "Select Terminal",
  });
  expect(selectedTerminal).toHaveAttribute("aria-current", "true");
  expect(within(selectedTerminal).getByText("sh", { exact: true })).toBeInTheDocument();
});

test("creates a terminal in the focused terminal cwd, selects it, and confirms deletion", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([runningSession]))
    .mockImplementationOnce(() => jsonResponse(secondRunningSession, 201))
    .mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 204 })));

  const user = userEvent.setup();
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div>{session.name}</div>}
    />,
  );

  await user.click(await screen.findByRole("button", { name: "New terminal" }));

  expect(screen.queryByLabelText("Terminal name")).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "/api/sessions",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        name: "Terminal",
        cwd: "/workspace/euphony",
      }),
    }),
  );
  expect(await screen.findByRole("button", { name: "Select Claude" })).toHaveAttribute("aria-current", "true");
  await user.click(screen.getByRole("button", { name: "Delete Claude" }));

  expect(screen.getByRole("dialog", { name: "Delete terminal?" })).toBeVisible();
  expect(screen.getByText(/“Claude” will be stopped/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  expect(fetchMock).toHaveBeenCalledTimes(2);

  await user.click(screen.getByRole("button", { name: "Cancel" }));

  expect(screen.queryByRole("dialog", { name: "Delete terminal?" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Delete Claude" })).toBeVisible();
  expect(fetchMock).toHaveBeenCalledTimes(2);

  await user.click(screen.getByRole("button", { name: "Delete Claude" }));
  await user.click(screen.getByRole("button", { name: "Delete terminal" }));

  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Delete Claude" })).not.toBeInTheDocument();
  });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    "/api/sessions/session-2",
    expect.objectContaining({ method: "DELETE" }),
  );
});

test("falls back to home when the focused terminal cwd cannot be inherited", async () => {
  const created = { ...plainTerminalSession, id: "created-home", cwd: "/home/me" };
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([runningSession]))
    .mockImplementationOnce(() =>
      jsonResponse(
        { code: "invalid_cwd", message: "Choose an existing working directory." },
        400,
      ),
    )
    .mockImplementationOnce(() => jsonResponse(created, 201));
  const user = userEvent.setup();
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div>{session.id}</div>}
    />,
  );

  await user.click(await screen.findByRole("button", { name: "New terminal" }));

  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "/api/sessions",
    expect.objectContaining({
      body: JSON.stringify({
        name: "Terminal",
        cwd: "/workspace/euphony",
      }),
    }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    "/api/sessions",
    expect.objectContaining({
      body: JSON.stringify({ name: "Terminal" }),
    }),
  );
  expect(await screen.findByText("created-home")).toBeVisible();
});

test("does not fall back when an explicit terminal cwd is invalid", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([runningSession]))
    .mockImplementationOnce(() =>
      jsonResponse(
        { code: "invalid_cwd", message: "Choose an existing working directory." },
        400,
      ),
    );
  const user = userEvent.setup();
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div>{session.id}</div>}
    />,
  );
  await screen.findByRole("button", { name: "Select Codex" });

  fireEvent.keyDown(window, { key: "k", metaKey: true });
  await user.click(
    screen.getByRole("option", { name: /^New terminal in directory…/ }),
  );
  const cwd = screen.getByLabelText("Working directory");
  await user.clear(cwd);
  await user.type(cwd, "/workspace/missing");
  await user.click(screen.getByRole("button", { name: "Create terminal" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Choose an existing working directory.",
  );
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "/api/sessions",
    expect.objectContaining({
      body: JSON.stringify({
        name: "Terminal",
        cwd: "/workspace/missing",
      }),
    }),
  );
});

test("opens Command-K and creates a terminal in the chosen directory", async () => {
  const created = { ...plainTerminalSession, id: "created", cwd: "/workspace/other" };
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([runningSession]))
    .mockImplementationOnce(() => jsonResponse(created, 201));
  const user = userEvent.setup();
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div>{session.id}</div>}
    />,
  );
  await screen.findByRole("button", { name: "Select Codex" });

  fireEvent.keyDown(window, { key: "k", metaKey: true });
  await user.click(
    screen.getByRole("option", { name: /^New terminal in directory…/ }),
  );
  const cwd = screen.getByLabelText("Working directory");
  expect(cwd).toHaveValue("/workspace/euphony");
  await user.clear(cwd);
  await user.type(cwd, "/workspace/other");
  await user.click(screen.getByRole("button", { name: "Create terminal" }));

  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "/api/sessions",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ name: "Terminal", cwd: "/workspace/other" }),
    }),
  );
});

test("the new terminal dialog owns focus and closes with Escape", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession]),
  );
  const user = userEvent.setup();
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div>{session.id}</div>}
    />,
  );
  await screen.findByRole("button", { name: "Select Codex" });

  fireEvent.keyDown(window, { key: "k", metaKey: true });
  await user.click(
    screen.getByRole("option", { name: /^New terminal in directory…/ }),
  );

  expect(screen.getByRole("dialog", { name: "New terminal" })).toBeVisible();
  expect(screen.getByLabelText("Working directory")).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "New terminal" })).not.toBeInTheDocument();
});

test("opens Quick Actions with Command-K but not Control-K", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession]),
  );
  render(
    <App
      syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div>{session.id}</div>}
    />,
  );
  await screen.findByRole("button", { name: "Select Codex" });

  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  expect(
    screen.queryByRole("dialog", { name: "Quick Actions" }),
  ).not.toBeInTheDocument();

  fireEvent.keyDown(window, { key: "k", metaKey: true });
  expect(
    await screen.findByRole("dialog", { name: "Quick Actions" }),
  ).toBeVisible();
});

test("navigates Quick Actions with arrows and Ctrl-P/N before Enter selects", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession]),
  );
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => (
        <div aria-label={`${session.name} terminal pane`} />
      )}
    />,
  );
  await screen.findByLabelText("Codex terminal pane");

  fireEvent.keyDown(window, { key: "k", metaKey: true });
  const input = await screen.findByPlaceholderText("Terminal or status");
  await waitFor(() => expect(input).toHaveFocus());

  fireEvent.keyDown(input, { key: "n", ctrlKey: true });
  expect(
    screen.getByRole("option", { name: /^Enable attention alerts/ }),
  ).toHaveAttribute("aria-selected", "true");

  fireEvent.keyDown(input, { key: "p", ctrlKey: true });
  expect(
    screen.getByRole("option", { name: /^New terminal in directory…/ }),
  ).toHaveAttribute("aria-selected", "true");

  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(
    screen.getByRole("option", { name: /^Show only Running terminals/ }),
  ).toHaveAttribute("aria-selected", "true");

  fireEvent.keyDown(input, { key: "Enter" });

  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Quick Actions" })).not.toBeInTheDocument();
  });
  expect(new URLSearchParams(window.location.search).getAll("status")).toEqual(["running"]);
  expect(screen.getByLabelText("Codex terminal pane")).toBeVisible();
  expect(screen.queryByLabelText("Claude terminal pane")).not.toBeInTheDocument();
});

test("shows the five most recently executed Quick Actions first without duplicates", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession, thirdRunningSession]),
  );
  const user = userEvent.setup();
  render(
    <App
      syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => (
        <div aria-label={`${session.name} terminal pane`} />
      )}
    />,
  );
  await screen.findByLabelText("Codex terminal pane");

  const runQuickAction = async (name: RegExp) => {
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await user.click(await screen.findByRole("option", { name }));
  };

  await runQuickAction(/^New terminal in directory…/);
  await user.keyboard("{Escape}");
  await runQuickAction(/^Show only Running terminals/);
  await runQuickAction(/^Show only Waiting terminals/);
  await runQuickAction(/^Implement v0\.2/);
  await runQuickAction(/^Needs approval/);
  await runQuickAction(/^Fix API/);

  fireEvent.keyDown(window, { key: "k", metaKey: true });
  const recentHeading = await screen.findByText("Recent");
  const recentGroup = recentHeading.closest("[cmdk-group]");
  expect(recentGroup).not.toBeNull();
  expect(
    within(recentGroup as HTMLElement)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual([
    expect.stringMatching(/^Fix API/),
    expect.stringMatching(/^Needs approval/),
    expect.stringMatching(/^Implement v0\.2/),
    expect.stringMatching(/^Show only Waiting terminals/),
    expect.stringMatching(/^Show only Running terminals/),
  ]);
  expect(
    within(recentGroup as HTMLElement).queryByRole("option", {
      name: /^New terminal in directory…/,
    }),
  ).not.toBeInTheDocument();
  expect(
    screen.getAllByRole("option", { name: /^New terminal in directory…/ }),
  ).toHaveLength(1);
  expect(screen.getAllByRole("option", { name: /^Fix API/ })).toHaveLength(1);
  expect(JSON.parse(localStorage.getItem("euphony.recentQuickActions") ?? "null")).toEqual([
    "session:session-3",
    "session:session-2",
    "session:session-1",
    "status:waiting",
    "status:running",
  ]);
});

test("discards unavailable recent Quick Actions and searches the full catalog", async () => {
  localStorage.setItem(
    "euphony.recentQuickActions",
    JSON.stringify([
      "status:exited",
      "session:missing",
      "session:session-2",
      "session:session-2",
      42,
    ]),
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([
      runningSession,
      secondRunningSession,
      {
        ...plainTerminalSession,
        id: "session-exited",
        state: "exited",
      },
    ]),
  );
  const user = userEvent.setup();
  render(
    <App
      syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => (
        <div aria-label={`${session.name} terminal pane`} />
      )}
    />,
  );
  await screen.findByLabelText("Codex terminal pane");

  fireEvent.keyDown(window, { key: "k", metaKey: true });
  const recentHeading = await screen.findByText("Recent");
  const recentGroup = recentHeading.closest("[cmdk-group]");
  expect(recentGroup).not.toBeNull();
  expect(within(recentGroup as HTMLElement).getAllByRole("option")).toHaveLength(1);
  expect(
    within(recentGroup as HTMLElement).getByRole("option", { name: /^Needs approval/ }),
  ).toBeVisible();
  expect(JSON.parse(localStorage.getItem("euphony.recentQuickActions") ?? "null")).toEqual([
    "session:session-2",
  ]);

  await user.type(screen.getByPlaceholderText("Terminal or status"), "new terminal");
  expect(screen.queryByText("Recent")).not.toBeInTheDocument();
  expect(
    screen.getByRole("option", { name: /^New terminal in directory…/ }),
  ).toBeVisible();
});

test("scrolls the Quick Actions keyboard selection into view", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession]),
  );
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => (
        <div aria-label={`${session.name} terminal pane`} />
      )}
    />,
  );
  await screen.findByLabelText("Codex terminal pane");

  fireEvent.keyDown(window, { key: "k", metaKey: true });
  const input = await screen.findByPlaceholderText("Terminal or status");
  await waitFor(() => expect(input).toHaveFocus());
  const attentionOption = screen.getByRole("option", {
    name: /^Enable attention alerts/,
  });
  const scrollIntoView = vi.spyOn(
    HTMLElement.prototype,
    "scrollIntoView",
  );

  fireEvent.keyDown(input, { key: "ArrowDown" });

  await waitFor(() =>
    expect(attentionOption).toHaveAttribute("aria-selected", "true"),
  );
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  expect(scrollIntoView.mock.contexts).toContain(attentionOption);
});

test("shows one workspace connection status and retries disconnected panes", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession]),
  );
  const user = userEvent.setup();
  const renderTerminal = ((
    session: Session,
    _api: unknown,
    _active: boolean,
    _layoutVersion: number,
    onConnectionChange:
      | ((sessionID: string, state: "connected" | "disconnected" | "exited") => void)
      | undefined,
    reconnectSignal = 0,
  ) => (
    <div>
      <button
        onClick={() => onConnectionChange?.(session.id, "disconnected")}
      >
        Disconnect {session.name}
      </button>
      <button onClick={() => onConnectionChange?.(session.id, "connected")}>
        Connect {session.name}
      </button>
      <button onClick={() => onConnectionChange?.(session.id, "exited")}>
        Exit {session.name}
      </button>
      <span aria-label={`${session.name} reconnect signal`}>
        {reconnectSignal}
      </span>
    </div>
  )) as unknown as ComponentProps<typeof App>["renderTerminal"];

  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={renderTerminal}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Disconnect Codex" }));

  const status = screen.getByRole("status", { name: "Terminal connection" });
  expect(status).toHaveTextContent("Connection interrupted");
  expect(screen.getAllByRole("status", { name: "Terminal connection" })).toHaveLength(1);
  expect(screen.queryByText("connected")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Reconnect" }));
  expect(screen.getByLabelText("Codex reconnect signal")).toHaveTextContent("1");

  await user.click(screen.getByRole("button", { name: "Connect Codex" }));
  expect(
    screen.queryByRole("status", { name: "Terminal connection" }),
  ).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Exit Codex" }));
  expect(
    screen.getByRole("status", { name: "Terminal connection" }),
  ).toHaveTextContent("Terminal exited");
});

test("restores the selected session from the URL and follows browser navigation", async () => {
  history.replaceState(null, "", "/?session=session-2");
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession]),
  );
  const user = userEvent.setup();
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
    />,
  );

  expect(await screen.findByLabelText("Claude terminal pane")).toBeVisible();
  expectTerminalPaneHidden("Codex terminal pane");

  await user.click(screen.getByRole("button", { name: "Select Codex" }));
  expect(new URLSearchParams(window.location.search).get("terminal")).toBe("session-1");
  expect(await screen.findByLabelText("Codex terminal pane")).toBeVisible();

  history.pushState(null, "", "/?terminal=session-2");
  fireEvent(window, new PopStateEvent("popstate"));
  expect(await screen.findByLabelText("Claude terminal pane")).toBeVisible();
});

test("browser navigation clears ownership from previous dynamic filters", async () => {
  history.replaceState(null, "", "/?terminal=session-1&status=running");
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession]),
  );
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  await screen.findByLabelText("session-1 terminal pane");

  history.pushState(null, "", "/?terminal=session-1");
  fireEvent(window, new PopStateEvent("popstate"));

  expect(screen.getByLabelText("session-1 terminal pane")).toBeVisible();
  expectTerminalPaneHidden("session-2 terminal pane");
  expect(new URLSearchParams(window.location.search).getAll("status")).toEqual([]);

  history.pushState(null, "", "/?terminal=session-2&status=waiting");
  fireEvent(window, new PopStateEvent("popstate"));

  expect(await screen.findByLabelText("session-2 terminal pane")).toBeVisible();
  expectTerminalPaneHidden("session-1 terminal pane");
  expect(new URLSearchParams(window.location.search).getAll("status")).toEqual([
    "waiting",
  ]);
});

test("command-click selects multiple terminal panes and stores them in the URL", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession]),
  );
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
    />,
  );

  await screen.findByLabelText("Codex terminal pane");
  fireEvent.click(screen.getByRole("button", { name: "Select Claude" }), { metaKey: true });

  expect(screen.getByLabelText("Codex terminal pane")).toBeVisible();
  expect(await screen.findByLabelText("Claude terminal pane")).toBeVisible();
  const parameters = new URLSearchParams(window.location.search);
  expect(parameters.getAll("terminal")).toEqual(["session-1", "session-2"]);
  expect(parameters.get("focus")).toBe("session-2");

  fireEvent.mouseDown(screen.getByLabelText("Codex pane"));
  expect(screen.getByLabelText("Codex pane")).toHaveAttribute("data-active", "true");
  expect(new URLSearchParams(window.location.search).get("focus")).toBe("session-1");

  history.pushState(null, "", "/?terminal=session-1&terminal=session-2&focus=session-2");
  fireEvent(window, new PopStateEvent("popstate"));
  await waitFor(() => {
    expect(screen.getByLabelText("Claude pane")).toHaveAttribute("data-active", "true");
  });
});

test("keeps an Alt-pinned terminal selected until its checkbox is clicked", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession]),
  );
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
    />,
  );

  await screen.findByLabelText("Codex terminal pane");
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Include Codex in split" }),
    { altKey: true },
  );
  fireEvent.click(screen.getByRole("button", { name: "Select Claude" }));

  expect(screen.getByLabelText("Codex terminal pane")).toBeVisible();
  expect(await screen.findByLabelText("Claude terminal pane")).toBeVisible();
  let parameters = new URLSearchParams(window.location.search);
  expect(parameters.getAll("terminal")).toEqual(["session-1", "session-2"]);
  expect(parameters.getAll("pin")).toEqual(["session-1"]);

  fireEvent.click(
    screen.getByRole("checkbox", { name: "Include Codex in split" }),
  );

  expectTerminalPaneHidden("Codex terminal pane");
  expect(screen.getByLabelText("Claude terminal pane")).toBeVisible();
  parameters = new URLSearchParams(window.location.search);
  expect(parameters.getAll("terminal")).toEqual(["session-2"]);
  expect(parameters.getAll("pin")).toEqual([]);
});

test("does not toggle a pinned terminal off from its row", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession]),
  );
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
    />,
  );

  await screen.findByLabelText("Codex terminal pane");
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Include Codex in split" }),
    { altKey: true },
  );
  fireEvent.click(screen.getByRole("button", { name: "Select Claude" }));
  fireEvent.click(screen.getByRole("button", { name: "Select Codex" }), {
    metaKey: true,
  });

  expect(screen.getByLabelText("Codex terminal pane")).toBeVisible();
  expect(screen.getByLabelText("Claude terminal pane")).toBeVisible();
  const parameters = new URLSearchParams(window.location.search);
  expect(parameters.getAll("terminal")).toEqual(["session-1", "session-2"]);
  expect(parameters.getAll("pin")).toEqual(["session-1"]);
});

test("prefix navigation reads a pin added to the current terminal", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession]),
  );
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
    />,
  );

  await screen.findByLabelText("Codex terminal pane");
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Include Codex in split" }),
    { altKey: true },
  );
  fireEvent.keyDown(window, { key: "b", ctrlKey: true });
  fireEvent.keyDown(window, { key: "n" });

  expect(screen.getByLabelText("Codex terminal pane")).toBeVisible();
  expect(await screen.findByLabelText("Claude terminal pane")).toBeVisible();
  const parameters = new URLSearchParams(window.location.search);
  expect(parameters.getAll("terminal")).toEqual(["session-1", "session-2"]);
  expect(parameters.getAll("pin")).toEqual(["session-1"]);
});

test("restores URL pins into terminal selection", async () => {
  history.replaceState(
    null,
    "",
    "/?terminal=session-2&pin=session-1&focus=session-2",
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession]),
  );
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
    />,
  );

  expect(await screen.findByLabelText("Codex terminal pane")).toBeVisible();
  expect(screen.getByLabelText("Claude terminal pane")).toBeVisible();
  expect(
    screen.getByRole("checkbox", { name: "Include Codex in split" }),
  ).toHaveAttribute("data-pinned", "true");
  expect(new URLSearchParams(window.location.search).getAll("terminal")).toEqual([
    "session-2",
    "session-1",
  ]);
});

test("keeps an Alt-pinned status filter across terminal row replacement", async () => {
  history.replaceState(null, "", "/?terminal=session-1&pin-status=running");
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession, thirdRunningSession]),
  );
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );
  await screen.findByLabelText("session-1 terminal pane");

  expect(await screen.findByLabelText("session-3 terminal pane")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Select Claude" }));

  expect(screen.getByLabelText("session-1 terminal pane")).toBeVisible();
  expect(screen.getByLabelText("session-2 terminal pane")).toBeVisible();
  expect(screen.getByLabelText("session-3 terminal pane")).toBeVisible();
  const parameters = new URLSearchParams(window.location.search);
  expect(parameters.getAll("pin-status")).toEqual(["running"]);
  expect(parameters.getAll("status")).toContain("running");
});

test("keeps an Alt-pinned cwd filter across status label replacement", async () => {
  history.replaceState(
    null,
    "",
    "/?terminal=session-1&pin-cwd=running%00%2Fworkspace%2Feuphony",
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession, thirdRunningSession]),
  );
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );
  await screen.findByLabelText("session-1 terminal pane");

  expect(screen.getByLabelText("session-1 terminal pane")).toBeVisible();
  expectTerminalPaneHidden("session-3 terminal pane");
  fireEvent.click(screen.getByRole("button", { name: "Select Claude" }));

  expect(screen.getByLabelText("session-1 terminal pane")).toBeVisible();
  expect(screen.getByLabelText("session-2 terminal pane")).toBeVisible();
  expect(screen.queryByLabelText("session-3 terminal pane")).not.toBeInTheDocument();
  const parameters = new URLSearchParams(window.location.search);
  expect(parameters.getAll("pin-cwd")).toEqual([
    "running\u0000/workspace/euphony",
  ]);
});

test("restores pinned filters from URL state", async () => {
  history.replaceState(
    null,
    "",
    "/?pin-status=waiting&pin-cwd=running%00%2Fworkspace%2Feuphony",
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession]),
  );
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  expect(await screen.findByLabelText("session-1 terminal pane")).toBeVisible();
  expect(screen.getByLabelText("session-2 terminal pane")).toBeVisible();
  expect(new URLSearchParams(window.location.search).getAll("pin-status")).toEqual([
    "waiting",
  ]);
  expect(new URLSearchParams(window.location.search).getAll("pin-cwd")).toEqual([
    "running\u0000/workspace/euphony",
  ]);
});

test("pane rail checkboxes remove selected terminals and allow an empty workspace", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession]),
  );
  const user = userEvent.setup();
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
    />,
  );

  await screen.findByLabelText("Codex terminal pane");
  fireEvent.click(screen.getByRole("button", { name: "Select Claude" }), {
    metaKey: true,
  });
  await screen.findByLabelText("Claude terminal pane");

  await user.click(screen.getByRole("checkbox", { name: "Deselect Claude" }));

  expectTerminalPaneHidden("Claude terminal pane");
  expect(screen.getByLabelText("Codex terminal pane")).toBeVisible();
  let parameters = new URLSearchParams(window.location.search);
  expect(parameters.getAll("terminal")).toEqual(["session-1"]);
  expect(parameters.get("focus")).toBe("session-1");

  await user.click(screen.getByRole("checkbox", { name: "Deselect Codex" }));

  expectTerminalPaneHidden("Codex terminal pane");
  const emptyStateTitle = screen.getByRole("heading", { name: "No signal yet." });
  expect(emptyStateTitle).toHaveClass("empty-state-title");
  expect(emptyStateTitle.closest(".empty-state-card")).not.toBeNull();
  const startButton = screen.getByRole("button", { name: "Start a terminal" });
  expect(startButton).toHaveClass("empty-state-action");
  expect(startButton).toHaveAttribute("data-slot", "button");
  parameters = new URLSearchParams(window.location.search);
  expect(parameters.getAll("terminal")).toEqual([]);
  expect(parameters.has("focus")).toBe(false);
});

test("deselecting an unfocused pane preserves the current focus", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession, thirdRunningSession]),
  );
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  await screen.findByLabelText("session-1 terminal pane");
  fireEvent.click(screen.getByRole("button", { name: "Select Claude" }), {
    metaKey: true,
  });
  fireEvent.click(screen.getByRole("button", { name: "Select Terminal" }), {
    metaKey: true,
  });
  expect(screen.getByLabelText("Terminal pane")).toHaveAttribute(
    "data-active",
    "true",
  );

  fireEvent.click(screen.getByRole("checkbox", {
    name: "Deselect Claude",
    hidden: true,
  }));

  expectTerminalPaneHidden("session-2 terminal pane");
  expect(screen.getByLabelText("Terminal pane")).toHaveAttribute(
    "data-active",
    "true",
  );
  expect(new URLSearchParams(window.location.search).get("focus")).toBe(
    "session-3",
  );
});

test("deselecting a filter-owned unfocused pane preserves the current focus", async () => {
  history.replaceState(null, "", "/?terminal=session-1&status=running");
  const fourthRunningSession = {
    ...thirdRunningSession,
    id: "session-4",
    name: "Fourth",
    cwd: "/workspace/fourth",
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([
      runningSession,
      thirdRunningSession,
      fourthRunningSession,
    ]),
  );
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  await screen.findByLabelText("session-1 terminal pane");
  await screen.findByLabelText("session-3 terminal pane");
  fireEvent.mouseDown(screen.getByLabelText("Fourth pane"));
  expect(screen.getByLabelText("Fourth pane")).toHaveAttribute(
    "data-active",
    "true",
  );

  fireEvent.click(screen.getByRole("checkbox", {
    name: "Deselect Terminal",
    hidden: true,
  }));

  expectTerminalPaneHidden("session-3 terminal pane");
  expect(screen.getByLabelText("Fourth pane")).toHaveAttribute(
    "data-active",
    "true",
  );
  expect(new URLSearchParams(window.location.search).get("focus")).toBe(
    "session-4",
  );
});

test("passes the pane count to terminals when the topology changes", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession]),
  );
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session, _api, _active, layoutVersion) => (
        <div
          aria-label={`${session.id} terminal layout`}
          data-layout-version={layoutVersion}
        />
      )}
    />,
  );

  expect(await screen.findByLabelText("session-1 terminal layout")).toHaveAttribute(
    "data-layout-version",
    "1",
  );
  fireEvent.click(screen.getByRole("button", { name: "Select Claude" }), { metaKey: true });

  expect(await screen.findByLabelText("session-1 terminal layout")).toHaveAttribute(
    "data-layout-version",
    "2",
  );
  expect(screen.getByLabelText("session-2 terminal layout")).toHaveAttribute(
    "data-layout-version",
    "2",
  );
});

test("a status filter automatically adds newly matching terminal panes", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  history.replaceState(null, "", "/?terminal=session-1&status=running");
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([runningSession, secondRunningSession]))
    .mockImplementation(() =>
      jsonResponse([runningSession, secondRunningSession, thirdRunningSession]),
    );
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  await screen.findByLabelText("session-1 terminal pane");
  await vi.advanceTimersByTimeAsync(1500);

  expect(await screen.findByLabelText("session-3 terminal pane")).toBeVisible();
  expect(new URLSearchParams(window.location.search).getAll("status")).toEqual(["running"]);
  vi.useRealTimers();
});

test("delays removing a status-filtered terminal until its status settles", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  history.replaceState(null, "", "/?terminal=session-1&status=running");
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([runningSession, thirdRunningSession]))
    .mockImplementation(() =>
      jsonResponse([
        runningSession,
        { ...thirdRunningSession, agentStatus: "waiting", needsAttention: true },
      ]),
    );
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  await screen.findByLabelText("session-1 terminal pane");
  expect(await screen.findByLabelText("session-3 terminal pane")).toBeVisible();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });

  expect(new URLSearchParams(window.location.search).getAll("terminal")).toContain(
    "session-3",
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000);
  });
  expect(new URLSearchParams(window.location.search).getAll("terminal")).toContain(
    "session-3",
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(new URLSearchParams(window.location.search).getAll("terminal")).not.toContain(
    "session-3",
  );
  expect(screen.getByLabelText("session-1 terminal pane")).toBeVisible();
  vi.useRealTimers();
});

test("cancels a pending filter removal when the status returns", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    history.replaceState(null, "", "/?terminal=session-1&status=running");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockImplementationOnce(() => jsonResponse([runningSession, thirdRunningSession]))
      .mockImplementationOnce(() =>
        jsonResponse([runningSession, { ...thirdRunningSession, agentStatus: "waiting" }]),
      )
      .mockImplementation(() => jsonResponse([runningSession, thirdRunningSession]));
    render(
      <App
        syncSelection={false}
        initialToken="valid-token"
        initialSettings={defaultSettings}
        renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
      />,
    );

    await screen.findByLabelText("session-3 terminal pane");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(new URLSearchParams(window.location.search).getAll("terminal")).toContain(
      "session-3",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(new URLSearchParams(window.location.search).getAll("terminal")).toContain(
      "session-3",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(new URLSearchParams(window.location.search).getAll("terminal")).toContain(
      "session-3",
    );
  } finally {
    vi.useRealTimers();
  }
});

test("does not render terminal panes again for an unchanged polling response", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      jsonResponse([{ ...runningSession }]),
    );
    let renders = 0;
    function TerminalProbe() {
      renders += 1;
      return <div aria-label="terminal probe" />;
    }

    render(
      <App syncSelection={false}
        initialToken="valid-token"
        initialSettings={defaultSettings}
        renderTerminal={() => <TerminalProbe />}
      />,
    );
    await screen.findByLabelText("terminal probe");
    expect(renders).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(
      fetchMock.mock.calls.filter(([input]) => input === "/api/sessions"),
    ).toHaveLength(2);
    expect(renders).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

test("removes a pin when polling removes its terminal", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockImplementationOnce(() =>
        jsonResponse([runningSession, secondRunningSession]),
      )
      .mockImplementation(() => jsonResponse([secondRunningSession]));
    render(
      <App syncSelection={false}
        initialToken="valid-token"
        initialSettings={defaultSettings}
        renderTerminal={(session) => (
          <div aria-label={`${session.id} terminal pane`} />
        )}
      />,
    );

    await screen.findByLabelText("session-1 terminal pane");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Include Codex in split" }),
      { altKey: true },
    );
    expect(new URLSearchParams(window.location.search).getAll("pin")).toEqual([
      "session-1",
    ]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).getAll("pin")).toEqual(
        [],
      );
    });
  } finally {
    vi.useRealTimers();
  }
});

test("follows the previous terminal when the last terminal exits", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    history.replaceState(null, "", "/?terminal=session-3");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockImplementationOnce(() =>
        jsonResponse([runningSession, secondRunningSession, thirdRunningSession]),
      )
      .mockImplementation(() =>
        jsonResponse([runningSession, secondRunningSession]),
      );
    render(
      <App
        syncSelection={false}
        initialToken="valid-token"
        initialSettings={defaultSettings}
        renderTerminal={(session) => (
          <div aria-label={`${session.id} terminal pane`} />
        )}
      />,
    );

    await screen.findByLabelText("session-3 terminal pane");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    await waitFor(() =>
      expect(screen.getByLabelText("session-2 terminal pane")).toBeVisible(),
    );
    expect(screen.queryByText("No signal yet.")).not.toBeInTheDocument();
    const parameters = new URLSearchParams(window.location.search);
    expect(parameters.getAll("terminal")).toEqual(["session-2"]);
    expect(parameters.get("focus")).toBe("session-2");
  } finally {
    vi.useRealTimers();
  }
});

test("keeps the agent log selected when a focused agent starts waiting", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  history.replaceState(
    null,
    "",
    "/?terminal=session-1&status=running&status=waiting",
  );
  const waitingSession = {
    ...runningSession,
    agentStatus: "waiting",
    needsAttention: true,
  };
  let sessionRequests = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (String(input).endsWith("/agent-log")) {
      return jsonResponse({
        agent: "codex",
        sessionId: "agent-session-1",
        entries: [],
      });
    }
    if (String(input).endsWith("/acknowledge-attention") && init?.method === "POST") {
      return jsonResponse({ ...waitingSession, needsAttention: false });
    }
    sessionRequests += 1;
    return jsonResponse(
      sessionRequests === 1
        ? [runningSession, secondRunningSession]
        : [waitingSession, secondRunningSession],
    );
  });
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  await screen.findByLabelText("session-1 terminal pane");
  fireEvent.click(screen.getAllByRole("tab", { name: "Agent log" })[0]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });

  expect(screen.getAllByRole("tab", { name: "Agent log" })[0]).toHaveAttribute("data-active");
  vi.useRealTimers();
});

test("delays deselecting a selected terminal when its agent starts running", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const otherTerminal = { ...plainTerminalSession, id: "session-other" };
    const runningAgent = {
      ...plainTerminalSession,
      agent: "claude",
      agentStatus: "running",
      agentTitle: "Claude Code",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockImplementationOnce(() => jsonResponse([plainTerminalSession, otherTerminal]))
      .mockImplementation(() => jsonResponse([runningAgent, otherTerminal]));
    render(
      <App
        syncSelection={false}
        initialToken="valid-token"
        initialSettings={defaultSettings}
        renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
      />,
    );

    await screen.findByLabelText("session-plain terminal pane");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(await screen.findByLabelText("session-plain terminal pane")).toBeVisible();
    expect(screen.getByText("Terminal is now running.")).toHaveClass(
      "running-deselect-toast-title",
    );
    expect(screen.getByText("It will be removed in 10 seconds.")).toHaveClass(
      "running-deselect-toast-description",
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass(
      "running-deselect-toast-action",
    );
    expect(screen.getByRole("status", { name: "Automatic deselection" })).toHaveTextContent(
      "Terminal is now running. It will be removed in 10 seconds.",
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(screen.getByLabelText("session-plain terminal pane")).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() => {
      expectTerminalPaneHidden("session-plain terminal pane");
    });
    expect(screen.getByText("No signal yet.")).toBeVisible();
    const parameters = new URLSearchParams(window.location.search);
    expect(parameters.getAll("terminal")).toEqual([]);
    expect(parameters.has("focus")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("keeps a filtered Codex terminal visible during the running deselection delay", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const waitingCodex = {
      ...plainTerminalSession,
      name: "Codex",
      agent: "codex",
      agentStatus: "waiting",
      agentTitle: "Codex",
    };
    const otherTerminal = { ...plainTerminalSession, id: "session-other" };
    let sessionReads = 0;
    let sharedSelection: SelectionSnapshot = {
      terminalIds: [waitingCodex.id],
      manualTerminalIds: [],
      pinnedTerminalIds: [],
      focusedTerminalId: waitingCodex.id,
      filters: { statuses: ["waiting"], cwds: [] },
      pinnedFilters: { statuses: [], cwds: [] },
      revision: 7,
    };
    const writes: Array<{ manualTerminalIds: string[] }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (input === "/api/sessions") {
        sessionReads += 1;
        if (sessionReads >= 2) {
          sharedSelection = {
            ...sharedSelection,
            terminalIds: [],
            focusedTerminalId: "",
            revision: 8,
          };
          return jsonResponse([
            { ...waitingCodex, agentStatus: "running" },
            otherTerminal,
          ]);
        }
        return jsonResponse([waitingCodex, otherTerminal]);
      }
      if (input === "/api/v1/selection" && init?.method === "PUT") {
        const request = JSON.parse(String(init.body)) as {
          manualTerminalIds: string[];
          pinnedTerminalIds: string[];
          focusedTerminalId?: string;
          filters: SelectionSnapshot["filters"];
          pinnedFilters: SelectionSnapshot["filters"];
        };
        writes.push({ manualTerminalIds: request.manualTerminalIds });
        sharedSelection = {
          ...sharedSelection,
          terminalIds: request.manualTerminalIds,
          manualTerminalIds: request.manualTerminalIds,
          pinnedTerminalIds: request.pinnedTerminalIds,
          focusedTerminalId: request.focusedTerminalId ?? "",
          filters: request.filters,
          pinnedFilters: request.pinnedFilters,
          revision: sharedSelection.revision + 1,
        };
        return jsonResponse({ ok: true, result: sharedSelection });
      }
      if (input === "/api/v1/selection") {
        return jsonResponse({ ok: true, result: sharedSelection });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    render(
      <App
        initialToken="valid-token"
        initialSettings={defaultSettings}
        syncEvents={false}
        renderTerminal={(session) => (
          <div aria-label={`${session.id} terminal pane`} />
        )}
      />,
    );

    await screen.findByLabelText("session-plain terminal pane");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    expect(screen.getByLabelText("session-plain terminal pane")).toBeVisible();
    expect(screen.getByRole("status", { name: "Automatic deselection" })).toHaveTextContent(
      "Codex is now running. It will be removed in 10 seconds.",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(screen.getByLabelText("session-plain terminal pane")).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() => {
      expectTerminalPaneHidden("session-plain terminal pane");
    });
    expect(writes.at(-1)?.manualTerminalIds).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

test("keeps a filtered Codex terminal visible during the delay without shared selection", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    history.replaceState(null, "", "/?terminal=session-plain&status=waiting");
    const waitingCodex = {
      ...plainTerminalSession,
      name: "Codex",
      agent: "codex",
      agentStatus: "waiting",
      agentTitle: "Codex",
    };
    const runningCodex = { ...waitingCodex, agentStatus: "running" };
    const otherTerminal = { ...plainTerminalSession, id: "session-other" };
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => jsonResponse([waitingCodex, otherTerminal]))
      .mockImplementation(() => jsonResponse([runningCodex, otherTerminal]));
    render(
      <App
        syncSelection={false}
        initialToken="valid-token"
        initialSettings={defaultSettings}
        renderTerminal={(session) => (
          <div aria-label={`${session.id} terminal pane`} />
        )}
      />,
    );

    await screen.findByLabelText("session-plain terminal pane");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    expect(screen.getByLabelText("session-plain terminal pane")).toBeVisible();
    expect(screen.getByRole("status", { name: "Automatic deselection" })).toHaveTextContent(
      "Codex is now running. It will be removed in 10 seconds.",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(screen.getByLabelText("session-plain terminal pane")).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() => {
      expectTerminalPaneHidden("session-plain terminal pane");
    });
  } finally {
    vi.useRealTimers();
  }
});

test("cancels a pending running-agent deselection", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const otherTerminal = { ...plainTerminalSession, id: "session-other" };
    const runningAgent = {
      ...plainTerminalSession,
      agent: "claude",
      agentStatus: "running",
      agentTitle: "Claude Code",
    };
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => jsonResponse([plainTerminalSession, otherTerminal]))
      .mockImplementation(() => jsonResponse([runningAgent, otherTerminal]));
    render(
      <App
        syncSelection={false}
        initialToken="valid-token"
        initialSettings={defaultSettings}
        renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
      />,
    );

    await screen.findByLabelText("session-plain terminal pane");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(screen.getByLabelText("session-plain terminal pane")).toBeVisible();
    expect(screen.queryByRole("status", { name: "Automatic deselection" })).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).getAll("terminal")).toEqual([
      "session-plain",
    ]);
  } finally {
    vi.useRealTimers();
  }
});

test("keeps a running agent selected when automatic deselection is disabled", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const otherTerminal = { ...plainTerminalSession, id: "session-other" };
    const runningAgent = {
      ...plainTerminalSession,
      agent: "claude",
      agentStatus: "running",
      agentTitle: "Claude Code",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockImplementationOnce(() => jsonResponse([plainTerminalSession, otherTerminal]))
      .mockImplementation(() => jsonResponse([runningAgent, otherTerminal]));
    render(
      <App
        syncSelection={false}
        initialToken="valid-token"
        initialSettings={{ ...defaultSettings, autoDeselectRunning: false }}
        renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
      />,
    );

    await screen.findByLabelText("session-plain terminal pane");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(await screen.findByLabelText("session-plain terminal pane")).toBeVisible();
    expect(screen.queryByLabelText("session-other terminal pane")).not.toBeInTheDocument();
    const parameters = new URLSearchParams(window.location.search);
    expect(parameters.getAll("terminal")).toEqual(["session-plain"]);
    expect(parameters.get("focus")).toBe("session-plain");
  } finally {
    vi.useRealTimers();
  }
});

test("preserves a pinned terminal when its agent starts running", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    history.replaceState(null, "", "/?terminal=session-plain&pin=session-plain");
    const otherTerminal = { ...plainTerminalSession, id: "session-other" };
    const runningAgent = {
      ...plainTerminalSession,
      agent: "claude",
      agentStatus: "running",
      agentTitle: "Claude Code",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockImplementationOnce(() => jsonResponse([plainTerminalSession, otherTerminal]))
      .mockImplementation(() => jsonResponse([runningAgent, otherTerminal]));
    render(
      <App
        syncSelection={false}
        initialToken="valid-token"
        initialSettings={defaultSettings}
        renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
      />,
    );

    await screen.findByLabelText("session-plain terminal pane");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(await screen.findByLabelText("session-plain terminal pane")).toBeVisible();
    expect(new URLSearchParams(window.location.search).getAll("pin")).toEqual([
      "session-plain",
    ]);
    expect(new URLSearchParams(window.location.search).getAll("terminal")).toEqual([
      "session-plain",
    ]);
  } finally {
    vi.useRealTimers();
  }
});

test.each(["claude", "codex"] as const)(
  "a focused terminal stays selected when polling identifies it as the %s agent",
  async (agent) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const otherTerminal = {
      ...plainTerminalSession,
      id: "session-other",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockImplementationOnce(() => jsonResponse([plainTerminalSession, otherTerminal]))
      .mockImplementation(() =>
        jsonResponse([
          {
            ...plainTerminalSession,
            agent,
            agentStatus: "waiting",
            agentTitle: `${agent} Code`,
          },
          otherTerminal,
        ]),
      );
    render(
      <App syncSelection={false}
        initialToken="valid-token"
        initialSettings={defaultSettings}
        renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
      />,
    );

    await screen.findByLabelText("session-plain terminal pane");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(screen.getByLabelText("session-plain terminal pane")).toBeVisible();
    expectTerminalPaneHidden("session-other terminal pane");
    expect(new URLSearchParams(location.search).getAll("terminal")).toEqual(["session-plain"]);
    expect(new URLSearchParams(location.search).getAll("status")).toEqual([]);
    expect(new URLSearchParams(location.search).getAll("cwd")).toEqual([]);
    expect(new URLSearchParams(location.search).get("focus")).toBe("session-plain");
    vi.useRealTimers();
  },
);

test("a checked status and cwd group dynamically follows matching terminals", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  history.replaceState(
    null,
    "",
    "/?terminal=session-1&cwd=running%00%2Fworkspace%2Feuphony",
  );
  const replacement = {
    ...runningSession,
    id: "session-replacement",
    name: "Replacement",
    agentTitle: "Continue implementation",
  };
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([runningSession, secondRunningSession]))
    .mockImplementation(() =>
      jsonResponse([
        { ...runningSession, agentStatus: "waiting" },
        secondRunningSession,
        replacement,
      ]),
    );
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  await screen.findByLabelText("session-1 terminal pane");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });

  expect(new URLSearchParams(window.location.search).getAll("terminal")).toContain(
    "session-1",
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000);
  });
  expect(new URLSearchParams(window.location.search).getAll("terminal")).toContain(
    "session-1",
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  await waitFor(() => {
    expectTerminalPaneHidden("session-1 terminal pane");
  });
  expect(screen.getByLabelText("session-replacement terminal pane")).toBeVisible();
  expect(new URLSearchParams(window.location.search).getAll("cwd")).toEqual([
    "running\u0000/workspace/euphony",
  ]);
  vi.useRealTimers();
});

test("the Terminal activity checkbox selects shells without a coding agent", async () => {
  history.replaceState(null, "", "/?terminal=session-1&status=terminal");
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, plainTerminalSession]),
  );
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  await screen.findByLabelText("session-1 terminal pane");

  expect(await screen.findByLabelText("session-plain terminal pane")).toBeVisible();
});

test("renders cwd headings without status filter controls", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession]),
  );
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  await screen.findByLabelText("session-1 terminal pane");
  expect(screen.getByRole("heading", { name: "/workspace/euphony" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "/workspace/website" })).toBeVisible();
  expect(screen.getByRole("img", { name: "Running" })).toBeVisible();
  expect(screen.getByRole("img", { name: "Waiting" })).toBeVisible();
  expect(
    screen.queryByRole("checkbox", { name: /Show all .* terminals/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Show only .* terminals/ }),
  ).not.toBeInTheDocument();
});

test("unchecking a terminal releases its ancestor status filter", async () => {
  history.replaceState(null, "", "/?terminal=session-1&status=running");
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, thirdRunningSession]),
  );
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );
  await screen.findByLabelText("session-1 terminal pane");

  await screen.findByLabelText("session-3 terminal pane");
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Include Codex in split" }),
  );

  expectTerminalPaneHidden("session-1 terminal pane");
  expect(screen.getByLabelText("session-3 terminal pane")).toBeVisible();
  const parameters = new URLSearchParams(window.location.search);
  expect(parameters.getAll("status")).toEqual([]);
  expect(parameters.getAll("cwd")).toEqual(["running\u0000/workspace/api"]);
});

test("tmux navigation keys switch terminals and focus panes", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession]),
  );
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );
  await screen.findByLabelText("session-1 terminal pane");

  fireEvent.keyDown(window, { key: "b", ctrlKey: true });
  fireEvent.keyDown(window, { key: "n" });
  expect(await screen.findByLabelText("session-2 terminal pane")).toBeVisible();

  fireEvent.keyDown(window, { key: "b", ctrlKey: true });
  fireEvent.keyDown(window, { key: "p" });
  expect(await screen.findByLabelText("session-1 terminal pane")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Select Claude" }), { metaKey: true });
  fireEvent.keyDown(window, { key: "b", ctrlKey: true });
  fireEvent.keyDown(window, { key: "h" });
  expect(screen.getByLabelText("Codex pane")).toHaveAttribute("data-active", "true");
  fireEvent.keyDown(window, { key: "b", ctrlKey: true });
  fireEvent.keyDown(window, { key: "l" });
  expect(screen.getByLabelText("Claude pane")).toHaveAttribute("data-active", "true");
});

test("tmux keys work when the focused terminal stops key event propagation", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession]),
  );
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => (
        <div className="terminal-host">
          <textarea
            aria-label={`${session.id} terminal input`}
            onKeyDown={(event) => event.stopPropagation()}
          />
        </div>
      )}
    />,
  );
  const terminalInput = await screen.findByLabelText("session-1 terminal input");
  terminalInput.focus();

  fireEvent.keyDown(terminalInput, { key: "b", ctrlKey: true });
  fireEvent.keyDown(terminalInput, { key: "n" });

  expect(await screen.findByLabelText("session-2 terminal input")).toBeVisible();
});

test("keeps prefix mode active without a timeout", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession]),
  );
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );
  await screen.findByLabelText("session-1 terminal pane");

  fireEvent.keyDown(window, { key: "b", ctrlKey: true });
  expect(screen.getByRole("status", { name: "Prefix commands" })).toBeVisible();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });

  expect(screen.getByRole("status", { name: "Prefix commands" })).toBeVisible();
  vi.useRealTimers();
});

test("Escape cancels prefix mode without reaching the focused terminal", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession]),
  );
  const terminalKeyDown = vi.fn();
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => (
        <div className="terminal-host">
          <textarea
            aria-label={`${session.id} terminal input`}
            onKeyDown={terminalKeyDown}
          />
        </div>
      )}
    />,
  );
  const terminalInput = await screen.findByLabelText("session-1 terminal input");
  terminalInput.focus();

  fireEvent.keyDown(terminalInput, { key: "b", ctrlKey: true });
  expect(screen.getByRole("status", { name: "Prefix commands" })).toBeVisible();
  fireEvent.keyDown(terminalInput, { key: "Escape" });

  expect(screen.queryByRole("status", { name: "Prefix commands" })).not.toBeInTheDocument();
  expect(terminalKeyDown).not.toHaveBeenCalled();
});

test("tmux split keys are not delivered to the focused terminal", async () => {
  const created = { ...plainTerminalSession, id: "created-v" };
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([runningSession]))
    .mockImplementationOnce(() => jsonResponse(created, 201));
  const terminalKeyDown = vi.fn();
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => (
        <div className="terminal-host">
          <textarea
            aria-label={`${session.id} terminal input`}
            onKeyDown={terminalKeyDown}
          />
        </div>
      )}
    />,
  );
  const terminalInput = await screen.findByLabelText("session-1 terminal input");
  terminalInput.focus();

  fireEvent.keyDown(terminalInput, { key: "b", ctrlKey: true });
  fireEvent.keyDown(terminalInput, { key: "v" });

  expect(await screen.findByLabelText("created-v terminal input")).toBeVisible();
  expect(terminalKeyDown).not.toHaveBeenCalled();
});

test("tmux create and vertical split keys create the expected selection", async () => {
  const createdByC = { ...plainTerminalSession, id: "created-c" };
  const createdByV = { ...plainTerminalSession, id: "created-v" };
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([runningSession]))
    .mockImplementationOnce(() => jsonResponse(createdByC, 201))
    .mockImplementationOnce(() => jsonResponse(createdByV, 201));
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );
  await screen.findByLabelText("session-1 terminal pane");

  fireEvent.keyDown(window, { key: "b", ctrlKey: true });
  fireEvent.keyDown(window, { key: "c" });
  expect(await screen.findByLabelText("created-c terminal pane")).toBeVisible();
  expectTerminalPaneHidden("session-1 terminal pane");
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "/api/sessions",
    expect.objectContaining({
      body: JSON.stringify({
        name: "Terminal",
        cwd: "/workspace/euphony",
      }),
    }),
  );

  fireEvent.keyDown(window, { key: "b", ctrlKey: true });
  fireEvent.keyDown(window, { key: "v" });
  expect(await screen.findByLabelText("created-v terminal pane")).toBeVisible();
  expect(screen.getByLabelText("created-c terminal pane")).toBeVisible();
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    "/api/sessions",
    expect.objectContaining({
      body: JSON.stringify({
        name: "Terminal",
        cwd: "/workspace/shell",
      }),
    }),
  );
  expect(new URLSearchParams(window.location.search).getAll("terminal")).toEqual([
    "created-c",
    "created-v",
  ]);
});

test("loads settings and saves changed workspace shortcuts", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (input === "/api/settings" && init?.method === "PATCH") {
      return jsonResponse(JSON.parse(String(init.body)));
    }
    if (input === "/api/settings") return jsonResponse(defaultSettings);
    return jsonResponse([runningSession]);
  });
  const user = userEvent.setup();
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      renderTerminal={(
        session,
        _api,
        _active,
        _layoutVersion,
        _onConnectionChange,
        _reconnectSignal,
        fontFamily,
        fontSize,
      ) => (
        <div
          aria-label={`${session.id} terminal pane`}
          data-font-family={fontFamily}
          data-font-size={fontSize}
        />
      )}
    />,
  );
  await screen.findByLabelText("session-1 terminal pane");

  await user.click(screen.getByRole("button", { name: "Open settings" }));
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  expect(dialog).toHaveAttribute("data-slot", "dialog-content");
  const prefix = screen.getByLabelText("Prefix");
  expect(prefix).toHaveAttribute("data-slot", "input");
  expect(prefix).toHaveFocus();
  const interfaceFontSize = within(dialog).getByLabelText("Interface");
  const terminalFontSize = within(dialog).getByLabelText("Terminal");
  const agentLogFontSize = within(dialog).getByLabelText("Agent log");
  const terminalFontFamily = within(dialog).getByLabelText("Terminal font");
  fireEvent.change(interfaceFontSize, { target: { value: "18" } });
  fireEvent.change(terminalFontSize, { target: { value: "17" } });
  fireEvent.change(agentLogFontSize, { target: { value: "16" } });
  fireEvent.change(terminalFontFamily, {
    target: { value: '"JetBrains Mono", monospace' },
  });
  expect(document.documentElement).toHaveStyle({ fontSize: "18px" });
  expect(screen.getByLabelText("session-1 terminal pane")).toHaveAttribute(
    "data-font-size",
    "17",
  );
  expect(screen.getByLabelText("session-1 terminal pane")).toHaveAttribute(
    "data-font-family",
    '"JetBrains Mono", monospace',
  );
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
  expect(document.documentElement).toHaveStyle({ fontSize: "16px" });
  expect(screen.getByLabelText("session-1 terminal pane")).toHaveAttribute(
    "data-font-size",
    "14",
  );
  expect(screen.getByLabelText("session-1 terminal pane")).toHaveAttribute(
    "data-font-family",
    defaultSettings.terminalFontFamily,
  );

  await user.click(screen.getByRole("button", { name: "Open settings" }));
  const reopenedDialog = screen.getByRole("dialog", { name: "Settings" });
  const reopenedPrefix = screen.getByLabelText("Prefix");
  const paneTabShortcut = screen.getByLabelText("Pane tab toggle");
  const historyBuffer = screen.getByLabelText("History buffer");
  expect(historyBuffer).toHaveValue(1);
  expect(screen.getByRole("checkbox", { name: "Unlimited history" })).not.toBeChecked();
  expect(within(reopenedDialog).getByLabelText("Interface")).toHaveValue(16);
  expect(within(reopenedDialog).getByLabelText("Terminal")).toHaveValue(14);
  expect(within(reopenedDialog).getByLabelText("Agent log")).toHaveValue(14);
  expect(within(reopenedDialog).getByLabelText("Terminal font")).toHaveValue(
    defaultSettings.terminalFontFamily,
  );
  fireEvent.change(reopenedPrefix, { target: { value: "Ctrl+A" } });
  fireEvent.change(paneTabShortcut, { target: { value: "control+j" } });
  fireEvent.change(historyBuffer, { target: { value: "8" } });
  fireEvent.change(within(reopenedDialog).getByLabelText("Interface"), {
    target: { value: "18" },
  });
  fireEvent.change(within(reopenedDialog).getByLabelText("Terminal"), {
    target: { value: "17" },
  });
  fireEvent.change(within(reopenedDialog).getByLabelText("Agent log"), {
    target: { value: "16" },
  });
  fireEvent.change(within(reopenedDialog).getByLabelText("Terminal font"), {
    target: { value: "  Iosevka, monospace  " },
  });
  await user.click(screen.getByRole("button", { name: "Save settings" }));

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/settings",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({
        ...defaultSettings,
        prefix: "Ctrl+A",
        paneTabShortcut: "Ctrl+J",
        interfaceFontSize: 18,
        terminalFontSize: 17,
        terminalFontFamily: "Iosevka, monospace",
        agentLogFontSize: 16,
        terminalHistoryLimit: 8 * 1024 * 1024,
      }),
    }),
  );
});

test("previews, cancels, and saves terminal appearance settings", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (input === "/api/settings" && init?.method === "PATCH") {
      return jsonResponse(JSON.parse(String(init.body)));
    }
    return jsonResponse([runningSession]);
  });
  const user = userEvent.setup();
  render(
    <App
      syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(
        session,
        _api,
        _active,
        _layoutVersion,
        _onConnectionChange,
        _reconnectSignal,
        _fontFamily,
        _fontSize,
        _terminalHistoryLimit,
        _sourceVisible,
        lineHeight,
        cursorStyle,
        cursorBlink,
        scrollSensitivity,
        optionAsAlt,
      ) => (
        <div
          aria-label={`${session.id} terminal pane`}
          data-line-height={lineHeight}
          data-cursor-style={cursorStyle}
          data-cursor-blink={cursorBlink}
          data-scroll-sensitivity={scrollSensitivity}
          data-option-as-alt={optionAsAlt}
        />
      )}
    />,
  );
  await screen.findByLabelText("session-1 terminal pane");

  await user.click(screen.getByRole("button", { name: "Open settings" }));
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  await user.click(within(dialog).getByRole("checkbox", { name: "Option as Alt" }));
  fireEvent.change(within(dialog).getByLabelText("Terminal line height"), {
    target: { value: "1.5" },
  });
  await user.selectOptions(within(dialog).getByLabelText("Cursor style"), "underline");
  await user.click(within(dialog).getByRole("checkbox", { name: "Cursor blink" }));
  fireEvent.change(within(dialog).getByLabelText("Scroll sensitivity"), {
    target: { value: "5" },
  });
  const terminalPane = screen.getByLabelText("session-1 terminal pane");
  expect(terminalPane).toHaveAttribute("data-line-height", "1.5");
  expect(terminalPane).toHaveAttribute("data-cursor-style", "underline");
  expect(terminalPane).toHaveAttribute("data-cursor-blink", "true");
  expect(terminalPane).toHaveAttribute("data-scroll-sensitivity", "5");
  expect(terminalPane).toHaveAttribute("data-option-as-alt", "false");

  await user.keyboard("{Escape}");
  expect(terminalPane).toHaveAttribute("data-line-height", "1.25");
  expect(terminalPane).toHaveAttribute("data-cursor-style", "bar");
  expect(terminalPane).toHaveAttribute("data-cursor-blink", "false");
  expect(terminalPane).toHaveAttribute("data-scroll-sensitivity", "3");
  expect(terminalPane).toHaveAttribute("data-option-as-alt", "true");

  await user.click(screen.getByRole("button", { name: "Open settings" }));
  const reopenedDialog = screen.getByRole("dialog", { name: "Settings" });
  const optionAsAltCheckbox = within(reopenedDialog).getByRole("checkbox", {
    name: "Option as Alt",
  });
  expect(optionAsAltCheckbox).toBeChecked();
  await user.click(optionAsAltCheckbox);
  fireEvent.change(within(reopenedDialog).getByLabelText("Terminal line height"), {
    target: { value: "1.5" },
  });
  await user.selectOptions(
    within(reopenedDialog).getByLabelText("Cursor style"),
    "underline",
  );
  await user.click(within(reopenedDialog).getByRole("checkbox", { name: "Cursor blink" }));
  fireEvent.change(within(reopenedDialog).getByLabelText("Scroll sensitivity"), {
    target: { value: "5" },
  });
  await user.click(screen.getByRole("button", { name: "Save settings" }));

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/settings",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({
        ...defaultSettings,
        terminalLineHeight: 1.5,
        terminalCursorStyle: "underline",
        terminalCursorBlink: true,
        terminalScrollSensitivity: 5,
        terminalOptionAsAlt: false,
      }),
    }),
  );
});

test("saves attention auto-selection and discards canceled draft changes", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (input === "/api/settings" && init?.method === "PATCH") {
      return jsonResponse(JSON.parse(String(init.body)));
    }
    return jsonResponse([runningSession]);
  });
  const user = userEvent.setup();
  render(
    <App
      syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => (
        <div aria-label={`${session.id} terminal pane`} />
      )}
    />,
  );
  await screen.findByLabelText("session-1 terminal pane");

  await user.click(screen.getByRole("button", { name: "Open settings" }));
  const autoSelect = screen.getByRole("checkbox", {
    name: "Auto-select attention terminals",
  });
  const autoDeselect = screen.getByRole("checkbox", {
    name: "Auto-deselect running agent terminals",
  });
  expect(autoSelect).toBeChecked();
  expect(autoDeselect).toBeChecked();
  await user.click(autoSelect);
  await user.click(autoDeselect);
  await user.keyboard("{Escape}");

  await user.click(screen.getByRole("button", { name: "Open settings" }));
  const reopenedAutoSelect = screen.getByRole("checkbox", {
    name: "Auto-select attention terminals",
  });
  const reopenedAutoDeselect = screen.getByRole("checkbox", {
    name: "Auto-deselect running agent terminals",
  });
  expect(reopenedAutoSelect).toBeChecked();
  expect(reopenedAutoDeselect).toBeChecked();
  await user.click(reopenedAutoSelect);
  await user.click(reopenedAutoDeselect);
  await user.click(screen.getByRole("button", { name: "Save settings" }));

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/settings",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({
        ...defaultSettings,
        autoSelectAttention: false,
        autoDeselectRunning: false,
      }),
    }),
  );
});

test("saves unlimited terminal history and disables the finite size", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (input === "/api/settings" && init?.method === "PATCH") {
      return jsonResponse(JSON.parse(String(init.body)));
    }
    return jsonResponse([runningSession]);
  });
  const user = userEvent.setup();
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );
  await screen.findByLabelText("session-1 terminal pane");

  await user.click(screen.getByRole("button", { name: "Open settings" }));
  const historyBuffer = screen.getByLabelText("History buffer");
  await user.click(screen.getByRole("checkbox", { name: "Unlimited history" }));
  expect(historyBuffer).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Save settings" }));

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/settings",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({
        ...defaultSettings,
        terminalHistoryLimit: 0,
      }),
    }),
  );
});

test("rejects a terminal history size outside the supported MiB range", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession]),
  );
  const user = userEvent.setup();
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );
  await screen.findByLabelText("session-1 terminal pane");

  await user.click(screen.getByRole("button", { name: "Open settings" }));
  const historyBuffer = screen.getByLabelText("History buffer");
  await user.clear(historyBuffer);
  await user.type(historyBuffer, "0");
  await user.click(screen.getByRole("button", { name: "Save settings" }));

  expect(screen.getByRole("alert")).toHaveTextContent(
    "Enter a whole number from 1 to 4095 MiB.",
  );
  expect(
    fetchMock.mock.calls.some(([input, init]) =>
      input === "/api/settings" && init?.method === "PATCH"),
  ).toBe(false);
});

test("forwards the saved history limit to terminal panes", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession]),
  );
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={{
        ...defaultSettings,
        terminalHistoryLimit: 16 * 1024 * 1024,
      }}
      renderTerminal={(
        session,
        _api,
        _active,
        _layoutVersion,
        _onConnectionChange,
        _reconnectSignal,
        _fontFamily,
        _fontSize,
        terminalHistoryLimit,
      ) => (
        <div
          aria-label={`${session.id} terminal pane`}
          data-history-limit={terminalHistoryLimit}
        />
      )}
    />,
  );

  expect(await screen.findByLabelText("session-1 terminal pane")).toHaveAttribute(
    "data-history-limit",
    String(16 * 1024 * 1024),
  );
});

test("rejects a pane tab shortcut that duplicates the prefix", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession]),
  );
  const user = userEvent.setup();
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={{
        ...defaultSettings,
        prefix: "Ctrl+Shift+J",
      }}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );
  await screen.findByLabelText("session-1 terminal pane");

  await user.click(screen.getByRole("button", { name: "Open settings" }));
  const paneTabShortcut = screen.getByLabelText("Pane tab toggle");
  await user.clear(paneTabShortcut);
  await user.type(paneTabShortcut, "Shift+Ctrl+J");
  await user.click(screen.getByRole("button", { name: "Save settings" }));

  expect(screen.getByRole("alert")).toHaveTextContent(
    "Choose a different shortcut from Prefix.",
  );
  expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
  expect(
    fetchMock.mock.calls.some(([input, init]) =>
      input === "/api/settings" && init?.method === "PATCH"),
  ).toBe(false);
});

test("rejects a font size outside the supported range", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession]),
  );
  const user = userEvent.setup();
  render(
    <App syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );
  await screen.findByLabelText("session-1 terminal pane");

  await user.click(screen.getByRole("button", { name: "Open settings" }));
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  const interfaceFontSize = within(dialog).getByLabelText("Interface");
  await user.clear(interfaceFontSize);
  await user.type(interfaceFontSize, "25");
  await user.click(screen.getByRole("button", { name: "Save settings" }));

  expect(screen.getByRole("alert")).toHaveTextContent(
    "Choose a whole number from 10 to 24.",
  );
  expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
  expect(
    fetchMock.mock.calls.some(([input, init]) =>
      input === "/api/settings" && init?.method === "PATCH"),
  ).toBe(false);
});

test("rejects an empty terminal font family", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession]),
  );
  const user = userEvent.setup();
  render(
    <App
      syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => (
        <div aria-label={`${session.id} terminal pane`} />
      )}
    />,
  );
  await screen.findByLabelText("session-1 terminal pane");

  await user.click(screen.getByRole("button", { name: "Open settings" }));
  const terminalFont = screen.getByLabelText("Terminal font");
  fireEvent.change(terminalFont, { target: { value: "   " } });
  await user.click(screen.getByRole("button", { name: "Save settings" }));

  expect(screen.getByRole("alert")).toHaveTextContent(
    "Choose a font family of 1 to 256 characters.",
  );
  expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
  expect(
    fetchMock.mock.calls.some(
      ([input, init]) =>
        input === "/api/settings" && init?.method === "PATCH",
    ),
  ).toBe(false);
});
