import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useEffect, type ComponentProps } from "react";
import { App } from "./App";
import { attentionTransitions } from "./sessionUtils";
import type {
  AgentSummary,
  AllSession,
  Project,
  SelectionSnapshot,
  Session,
  Settings,
} from "./types";

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100_000);
});

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
  terminalLineHeight: 1.25,
  terminalCursorStyle: "bar",
  terminalCursorBlink: false,
  terminalScrollSensitivity: 3,
  terminalOptionAsAlt: true,
  codingAgent: "codex",
  agentSummaryProvider: "codex",
  agentSummaryOpenAIEffort: "low",
  agentSummaryPrompt: "Focus on risks and next steps.",
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
      if (input === "/api/selection" && (!init || init.method === undefined)) {
        return jsonResponse(initialSelection);
      }
      if (input === "/api/selection" && init?.method === "PUT") {
        const request = JSON.parse(String(init.body)) as {
          manualTerminalIds: string[];
          pinnedTerminalIds: string[];
          focusedTerminalId: string;
          filters: { statuses: string[]; cwds: unknown[] };
          pinnedFilters: { statuses: string[]; cwds: unknown[] };
          expectedRevision: number;
        };
        return jsonResponse({
            terminalIds: request.manualTerminalIds,
            manualTerminalIds: request.manualTerminalIds,
            pinnedTerminalIds: request.pinnedTerminalIds,
            focusedTerminalId: request.focusedTerminalId,
            filters: request.filters,
            pinnedFilters: request.pinnedFilters,
            revision: 8,
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
        input === "/api/selection" && init?.method === "PUT",
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

test("keeps only four recently visited terminal views warm across switches", async () => {
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

  const terminalSessions = Array.from({ length: 6 }, (_, index) => ({
    ...runningSession,
    id: `session-${index + 1}`,
    name: `Terminal ${index + 1}`,
    cwd: `/workspace/terminal-${index + 1}`,
  }));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (input === "/api/sessions") {
      return jsonResponse(terminalSessions);
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
  for (let index = 2; index <= 6; index += 1) {
    await user.click(screen.getByRole("button", { name: `Select Terminal ${index}` }));
    expect(await screen.findByLabelText(`session-${index} terminal pane`)).toBeVisible();
  }

  expect(screen.getAllByLabelText(/session-\d+ terminal pane/)).toHaveLength(5);
  expect(unmounts.get("session-1")).toBe(1);
  expect(mounts.get("session-2")).toBe(1);
  expect(unmounts.get("session-2") ?? 0).toBe(0);

  await user.click(screen.getByRole("button", { name: "Select Terminal 2" }));
  expect(await screen.findByLabelText("session-2 terminal pane")).toBeVisible();
  expect(mounts.get("session-2")).toBe(1);
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
    if (input === "/api/selection" && (!init || init.method === undefined)) {
      return jsonResponse({
          terminalIds: ["session-1"],
          manualTerminalIds: ["session-1"],
          pinnedTerminalIds: [],
          focusedTerminalId: "session-1",
          filters: { statuses: [], cwds: [] },
          revision: 7,
      });
    }
    if (input === "/api/selection" && init?.method === "PUT") {
      const request = JSON.parse(String(init.body)) as {
        manualTerminalIds: string[];
        focusedTerminalId: string;
        expectedRevision: number;
      };
      writes.push(request);
      if (writes.length === 1) await firstWriteGate;
      return jsonResponse({
          terminalIds: request.manualTerminalIds,
          manualTerminalIds: request.manualTerminalIds,
          pinnedTerminalIds: [],
          focusedTerminalId: request.focusedTerminalId,
          filters: { statuses: [], cwds: [] },
          revision: 7 + writes.length,
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
    if (input === "/api/selection" && (!init || init.method === undefined)) {
      selectionReads++;
      const revision = selectionReads === 1 ? 7 : 8;
      return jsonResponse({
          terminalIds: ["session-1"],
          manualTerminalIds: ["session-1"],
          pinnedTerminalIds: [],
          focusedTerminalId: "session-1",
          filters: { statuses: [], cwds: [] },
          revision,
      });
    }
    if (input === "/api/selection" && init?.method === "PUT") {
      const request = JSON.parse(String(init.body)) as {
        manualTerminalIds: string[];
        expectedRevision: number;
      };
      writes.push(request);
      if (writes.length === 1) {
        return jsonResponse(
          {
            code: "selection_conflict",
            message: "stale",
            details: {},
          },
          409,
        );
      }
      return jsonResponse({
          terminalIds: request.manualTerminalIds,
          manualTerminalIds: request.manualTerminalIds,
          pinnedTerminalIds: [],
          focusedTerminalId: "session-2",
          filters: { statuses: [], cwds: [] },
          revision: 9,
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
      if (input === "/api/selection" && (!init || init.method === undefined)) {
        return jsonResponse({
            terminalIds: ["session-1"],
            manualTerminalIds: ["session-1"],
            pinnedTerminalIds: [],
            focusedTerminalId: "session-1",
            filters: { statuses: [], cwds: [] },
            revision: 3,
        });
      }
      if (input === "/api/events") {
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
      input === "/api/selection" && init?.method === "PUT",
  )).toBe(false);
  eventController?.close();
});

test("rediscovers an annotation created before the event subscription starts", async () => {
  let annotationReads = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions") {
      return jsonResponse([runningSession]);
    }
    if (input === "/api/selection" && (!init || init.method === undefined)) {
      return jsonResponse({
          terminalIds: ["session-1"],
          manualTerminalIds: ["session-1"],
          pinnedTerminalIds: [],
          focusedTerminalId: "session-1",
          filters: { statuses: [], cwds: [] },
          revision: 3,
      });
    }
    if (input === "/api/terminals/session-1/annotation") {
      annotationReads++;
      return jsonResponse({
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
      });
    }
    if (input === "/api/events") {
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

test("opens the Inbox item together with its terminal pane", async () => {
  const summary: AgentSummary = {
    terminalId: secondRunningSession.id,
    provider: "claude",
    status: "waiting",
    summary: "The agent is waiting for confirmation before editing the route.",
    action: "Approve the requested file change.",
    generatedAt: "2026-08-05T00:00:00Z",
    unread: true,
  };
  const readSummary: AgentSummary = { ...summary, unread: false };
  let releaseRead: (() => void) | undefined;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (input === "/api/sessions") {
      return jsonResponse([runningSession, secondRunningSession]);
    }
    if (input === "/api/agent-summaries") {
      return jsonResponse([summary]);
    }
    if (input === "/api/agent-summaries/session-2/read") {
      await readGate;
      return jsonResponse(readSummary);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
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

  expect(await screen.findByLabelText("Codex terminal pane")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Inbox" }));

  expect(await screen.findByRole("heading", { name: "Action required" })).toBeVisible();
  expect(screen.getByText(summary.summary)).toBeVisible();
  expect(screen.getByText(summary.action!)).toBeVisible();
  expect(fetchMock).toHaveBeenCalledWith("/api/agent-summaries", expect.anything());

  await user.click(screen.getByRole("button", { name: "Open Needs approval" }));
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent-summaries/session-2/read",
      expect.objectContaining({ method: "POST" }),
    );
  });
  expect(screen.getByRole("heading", { name: "Action required" })).toBeVisible();
  expect(await screen.findByLabelText("Claude terminal pane")).toBeVisible();
  expect(screen.getByLabelText("Inbox pane")).toHaveAttribute("data-visible", "true");
  releaseRead?.();
  expect(screen.getByRole("region", { name: "Selected Inbox item" })).toBeVisible();
  expect(window.location.pathname).toBe("/inbox/session-2");
});

test("replaces the previous terminal when switching Inbox items", async () => {
  const firstSummary: AgentSummary = {
    terminalId: runningSession.id,
    provider: "codex",
    status: "running",
    summary: "The agent is still working on the first request.",
    generatedAt: "2026-08-05T00:00:00Z",
    unread: false,
  };
  const secondSummary: AgentSummary = {
    terminalId: secondRunningSession.id,
    provider: "claude",
    status: "waiting",
    summary: "The agent is waiting for confirmation before editing the route.",
    action: "Approve the requested file change.",
    generatedAt: "2026-08-05T00:01:00Z",
    unread: false,
  };
  const pushState = vi.spyOn(window.history, "pushState");
  const replaceState = vi.spyOn(window.history, "replaceState");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (input === "/api/sessions") {
      return jsonResponse([runningSession, secondRunningSession]);
    }
    if (input === "/api/agent-summaries") {
      return jsonResponse([firstSummary, secondSummary]);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
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

  expect(await screen.findByLabelText("Codex terminal pane")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Inbox" }));
  expect(await screen.findByRole("heading", { name: "Action required" })).toBeVisible();
  await waitFor(() => expect(window.location.pathname).toBe("/inbox/session-1"));

  await user.click(screen.getByRole("button", { name: "Open Implement v0.2" }));
  expect(await screen.findByLabelText("Codex terminal pane")).toBeVisible();
  expect(screen.getByLabelText("Inbox pane")).toHaveAttribute("data-visible", "true");
  await waitFor(() => {
    const lastURL = pushState.mock.calls[pushState.mock.calls.length - 1]?.[2];
    expect(lastURL).toBe("/inbox/session-1?terminal=session-1&focus=session-1");
  });

  pushState.mockClear();
  replaceState.mockClear();
  expect(pushState).not.toHaveBeenCalled();
  expect(replaceState).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Open Needs approval" }));

  expect(await screen.findByLabelText("Claude terminal pane")).toBeVisible();
  expectTerminalPaneHidden("Codex terminal pane");
  expect(screen.getByLabelText("Inbox pane")).toHaveAttribute("data-visible", "true");
  expect(screen.getByLabelText("Claude pane")).toHaveAttribute("data-active", "true");
  expect(pushState.mock.calls.map((call) => call[2])).toEqual([
    "/inbox/session-2?focus=session-2&terminal=session-2",
  ]);
  expect(replaceState).toHaveBeenCalledTimes(1);
});

test("executes an Inbox option, locks only its terminal, and reconciles Done", async () => {
  history.replaceState(null, "", "/?terminal=session-1&terminal=session-2");
  const summary: AgentSummary = {
    terminalId: secondRunningSession.id,
    provider: "openai",
    status: "waiting",
    summary: "The agent is waiting for confirmation before editing the route.",
    action: "Approve the requested file change.",
    options: [{ id: "option-1", label: "Allow access" }],
    generatedAt: "2026-08-05T00:00:00Z",
    unread: true,
  };
  const doneSummary: AgentSummary = {
    ...summary,
    unread: false,
    done: true,
  };
  let releaseExecute: (() => void) | undefined;
  const executeGate = new Promise<void>((resolve) => {
    releaseExecute = resolve;
  });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions") return jsonResponse([runningSession, secondRunningSession]);
    if (input === "/api/agent-summaries") return jsonResponse([summary]);
    if (input === "/api/agent-summaries/session-2/options/option-1/execute") {
      expect(init?.method).toBe("POST");
      await executeGate;
      return jsonResponse(doneSummary);
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
      renderTerminal={(session, _api, _active, _layout, _onConnection, _reconnect, _family, _size, _history, _visible, _line, _cursor, _blink, _sensitivity, _alt, locked) => (
        <div
          aria-label={`${session.name} terminal pane`}
          data-automation-locked={locked ? "true" : "false"}
        />
      )}
    />,
  );

  expect(await screen.findByLabelText("Claude terminal pane")).toHaveAttribute(
    "data-automation-locked",
    "false",
  );
  await user.click(screen.getByRole("button", { name: "Inbox" }));
  await user.click(await screen.findByRole("button", { name: "Allow access" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/agent-summaries/session-2/options/option-1/execute",
    expect.objectContaining({ method: "POST" }),
  ));
  expect(screen.getByLabelText("Claude terminal pane")).toHaveAttribute(
    "data-automation-locked",
    "true",
  );
  expect(screen.getByLabelText("Codex terminal pane")).toHaveAttribute(
    "data-automation-locked",
    "false",
  );

  releaseExecute?.();
  await waitFor(() => expect(screen.getByRole("tab", { name: /Inbox · Action required 0/ })).toHaveAttribute(
    "aria-selected",
    "true",
  ));
  expect(screen.getByLabelText("Claude terminal pane")).toHaveAttribute(
    "data-automation-locked",
    "false",
  );
  expect(screen.getByRole("tab", { name: /Done 1/ })).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: /Done 1/ }));
  expect(screen.getByText(doneSummary.summary)).toBeInTheDocument();
});

test("queues a refresh for every identified agent from the Agents dashboard", async () => {
  const summary: AgentSummary = {
    terminalId: runningSession.id,
    provider: "codex",
    status: "running",
    summary: "The agent is updating the API.",
    generatedAt: "2026-08-05T00:00:00Z",
    unread: true,
  };
  let releaseRefresh: (() => void) | undefined;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions") {
      return jsonResponse([runningSession, secondRunningSession]);
    }
    if (input === "/api/agent-summaries") {
      return jsonResponse([summary]);
    }
    if (input === "/api/agent-summaries/refresh" && init?.method === "POST") {
      await refreshGate;
      return jsonResponse({ queued: 2 }, 202);
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
      renderTerminal={(session) => (
        <div aria-label={`${session.name} terminal pane`} />
      )}
    />,
  );

  expect(await screen.findByLabelText("Codex terminal pane")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Inbox" }));
  const refresh = await screen.findByRole("button", {
    name: "Refresh all agent summaries",
  });
  await user.click(refresh);
  expect(refresh).toBeDisabled();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/agent-summaries/refresh",
    expect.objectContaining({ method: "POST" }),
  );

  releaseRefresh?.();
  await waitFor(() => expect(refresh).not.toBeDisabled());
});

test("marks an Agent action Done and shows it in the Done tab", async () => {
  const summary: AgentSummary = {
    terminalId: secondRunningSession.id,
    provider: "claude",
    status: "waiting",
    summary: "The agent is waiting for confirmation before editing the route.",
    action: "Approve the requested file change.",
    priority: "high",
    generatedAt: "2026-08-05T00:00:00Z",
    unread: true,
    done: false,
  };
  const doneSummary: AgentSummary = { ...summary, unread: false, done: true };
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions") {
      return jsonResponse([runningSession, secondRunningSession]);
    }
    if (input === "/api/agent-summaries") {
      return jsonResponse([summary]);
    }
    if (input === "/api/agent-summaries/session-2/done" && init?.method === "POST") {
      return jsonResponse(doneSummary);
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
      renderTerminal={(session) => (
        <div aria-label={`${session.name} terminal pane`} />
      )}
    />,
  );

  expect(await screen.findByLabelText("Codex terminal pane")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Inbox" }));
  await user.click(await screen.findByRole("button", { name: "Mark Needs approval as done" }));

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent-summaries/session-2/done",
      expect.objectContaining({ method: "POST" }),
    );
  });
  expect(await screen.findByRole("tab", { name: /Inbox · Action required 0/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(screen.getByRole("tab", { name: /Done 1/ }));
  expect(screen.getByText(doneSummary.summary)).toBeVisible();
});

test("moves a Done action back to Action required when the agent updates it", async () => {
  const doneSummary: AgentSummary = {
    terminalId: secondRunningSession.id,
    provider: "claude",
    status: "waiting",
    summary: "The agent is waiting for confirmation before editing the route.",
    action: "Approve the requested file change.",
    priority: "medium",
    generatedAt: "2026-08-05T00:00:00Z",
    unread: false,
    done: true,
  };
  const updatedSummary: AgentSummary = {
    ...doneSummary,
    summary: "The agent needs a fresh confirmation after updating the route.",
    action: "Review the updated route before continuing.",
    priority: "high",
    generatedAt: "2026-08-05T00:01:00Z",
    unread: true,
    done: false,
  };
  const encoder = new TextEncoder();
  let eventController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (input === "/api/sessions") {
      return jsonResponse([runningSession, secondRunningSession]);
    }
    if (input === "/api/agent-summaries") {
      return jsonResponse([doneSummary]);
    }
    if (input === "/api/selection") {
      return jsonResponse({
          terminalIds: [runningSession.id],
          manualTerminalIds: [runningSession.id],
          pinnedTerminalIds: [],
          focusedTerminalId: runningSession.id,
          filters: { statuses: [], cwds: [] },
          revision: 3,
      });
    }
    if (input === "/api/events") {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          eventController = controller;
        },
      }), {
        headers: { "Content-Type": "application/x-ndjson" },
      });
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => (
        <div aria-label={`${session.name} terminal pane`} />
      )}
    />,
  );

  expect(await screen.findByLabelText("Codex terminal pane")).toBeVisible();
  await waitFor(() => expect(eventController).toBeDefined());
  await user.click(screen.getByRole("button", { name: "Inbox" }));
  await user.click(await screen.findByRole("tab", { name: /Done 1/ }));
  expect(screen.getByText(doneSummary.summary)).toBeVisible();

  eventController?.enqueue(encoder.encode(JSON.stringify({
    sequence: 12,
    occurredAt: "2026-08-05T00:02:00Z",
    type: "agent.summary.updated",
    data: updatedSummary,
  }) + "\n"));

  await waitFor(() => {
    expect(screen.queryByText(doneSummary.summary)).not.toBeInTheDocument();
  });
  await user.click(screen.getByRole("tab", { name: /Action required 1/ }));
  expect(screen.getByText(updatedSummary.summary)).toBeVisible();
  expect(screen.getByText(updatedSummary.action!)).toBeVisible();
  expect(screen.getByTestId("agent-summary-priority")).toHaveAttribute(
    "data-priority",
    "high",
  );

  eventController?.close();
  expect(fetchMock).toHaveBeenCalledWith("/api/events", expect.anything());
});

test("keeps the Agents sidebar count lifecycle-based while the queue includes read summaries", async () => {
  const sessions = [
    { ...runningSession, agentStatus: "waiting" },
    secondRunningSession,
  ];
  const readWaitingSummary: AgentSummary = {
    terminalId: runningSession.id,
    provider: "codex",
    status: "waiting",
    summary: "A read summary still needs lifecycle attention.",
    generatedAt: "2026-08-05T00:00:00Z",
    unread: false,
  };
  const unreadWaitingSummary: AgentSummary = {
    terminalId: secondRunningSession.id,
    provider: "claude",
    status: "waiting",
    summary: "An unread waiting summary belongs in the Action required queue.",
    generatedAt: "2026-08-05T00:01:00Z",
    unread: true,
  };
  const user = userEvent.setup();
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (input === "/api/sessions") return jsonResponse(sessions);
    if (input === "/api/agent-summaries") {
      return jsonResponse([readWaitingSummary, unreadWaitingSummary]);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
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

  expect(await screen.findByLabelText("Codex terminal pane")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Inbox" }));
  await waitFor(() => {
    const count = screen.getByRole("button", { name: "Inbox" })
      .querySelector(".sidebar-attention-count");
    expect(count).toHaveTextContent("2");
  });
  expect(screen.getByRole("tab", { name: /Action required 2/ })).toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(
    ([input]) => input === "/api/agent-summaries",
  )).toHaveLength(1);
});

test("does not let the startup summary snapshot overwrite an earlier SSE update", async () => {
  const staleSummary: AgentSummary = {
    terminalId: secondRunningSession.id,
    provider: "claude",
    status: "running",
    summary: "The stale startup snapshot.",
    generatedAt: "2026-08-05T00:00:00Z",
    unread: false,
  };
  const liveSummary: AgentSummary = {
    ...staleSummary,
    status: "waiting",
    summary: "The live SSE summary.",
    generatedAt: "2026-08-05T00:01:00Z",
    unread: true,
  };
  const selection = {
    terminalIds: [runningSession.id],
    manualTerminalIds: [runningSession.id],
    pinnedTerminalIds: [],
    focusedTerminalId: runningSession.id,
    filters: { statuses: [], cwds: [] },
    revision: 3,
  };
  let summaryRequestCount = 0;
  let releaseSummary: (() => void) | undefined;
  const summaryGate = new Promise<void>((resolve) => {
    releaseSummary = resolve;
  });
  const encoder = new TextEncoder();
  let eventController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (input === "/api/sessions") return jsonResponse([runningSession, secondRunningSession]);
    if (input === "/api/selection") return jsonResponse(selection);
    if (input === "/api/events") {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          eventController = controller;
        },
      }), {
        headers: { "Content-Type": "application/x-ndjson" },
      });
    }
    if (input === "/api/agent-summaries") {
      summaryRequestCount += 1;
      await summaryGate;
      return jsonResponse([staleSummary]);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => (
        <div aria-label={`${session.name} terminal pane`} />
      )}
    />,
  );

  expect(await screen.findByLabelText("Codex terminal pane")).toBeVisible();
  await waitFor(() => expect(summaryRequestCount).toBe(1));
  await waitFor(() => expect(eventController).toBeDefined());
  eventController?.enqueue(encoder.encode(JSON.stringify({
    sequence: 11,
    occurredAt: "2026-08-05T00:02:00Z",
    type: "agent.summary.updated",
    data: liveSummary,
  }) + "\n"));
  await user.click(screen.getByRole("button", { name: "Inbox" }));
  expect((await screen.findAllByText(liveSummary.summary)).length).toBeGreaterThan(0);
  releaseSummary?.();
  await waitFor(() => expect(screen.getAllByText(liveSummary.summary).length).toBeGreaterThan(0));
  expect(screen.queryByText(staleSummary.summary)).not.toBeInTheDocument();
  eventController?.close();
  expect(fetchMock).toHaveBeenCalledWith("/api/agent-summaries", expect.anything());
});

test("retries the startup summary load when opening Agents after a failure", async () => {
  const summary: AgentSummary = {
    terminalId: runningSession.id,
    provider: "codex",
    status: "running",
    summary: "The retry succeeded.",
    generatedAt: "2026-08-05T00:00:00Z",
    unread: true,
  };
  let summaryRequestCount = 0;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (input === "/api/sessions") return jsonResponse([runningSession]);
    if (input === "/api/agent-summaries") {
      summaryRequestCount += 1;
      if (summaryRequestCount === 1) throw new Error("summary request failed");
      return jsonResponse([summary]);
    }
    if (input === "/api/agent-summaries/session-1/read") {
      return jsonResponse({ ...summary, unread: false });
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
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

  expect(await screen.findByLabelText("Codex terminal pane")).toBeVisible();
  await waitFor(() => expect(summaryRequestCount).toBe(1));
  await user.click(screen.getByRole("button", { name: "Inbox" }));
  await waitFor(() => expect(summaryRequestCount).toBe(2));
  expect((await screen.findAllByText(summary.summary)).length).toBeGreaterThan(0);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith("/api/agent-summaries", expect.anything());
});

test("keeps a failed agent read unread while still opening its terminal", async () => {
  const summary: AgentSummary = {
    terminalId: secondRunningSession.id,
    provider: "claude",
    status: "waiting",
    summary: "Unread until the read request succeeds.",
    action: "Approve the requested file change.",
    generatedAt: "2026-08-05T00:00:00Z",
    unread: true,
  };
  let summaryLoads = 0;
  let releaseReload: (() => void) | undefined;
  const reloadGate = new Promise<void>((resolve) => {
    releaseReload = resolve;
  });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (input === "/api/sessions") {
      return jsonResponse([runningSession, secondRunningSession]);
    }
    if (input === "/api/agent-summaries") {
      summaryLoads += 1;
      if (summaryLoads > 1) await reloadGate;
      return jsonResponse([summary]);
    }
    if (input === "/api/agent-summaries/session-2/read") {
      return jsonResponse({ code: "read_failed", message: "The read failed." }, 500);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
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

  expect(await screen.findByLabelText("Codex terminal pane")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Inbox" }));
  await user.click(await screen.findByRole("button", { name: "Open Needs approval" }));
  await user.click(screen.getByRole("button", { name: "Open terminal" }));
  expect(await screen.findByLabelText("Claude terminal pane")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Inbox" }));
  expect((await screen.findAllByText(summary.summary)).length).toBeGreaterThan(0);
  expect(await screen.findByRole("alert")).toHaveTextContent("The read failed.");
  expect(screen.getByTestId("agent-summary-card-session-2")).toHaveAttribute("data-unread", "true");
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/agent-summaries/session-2/read",
    expect.objectContaining({ method: "POST" }),
  );
  releaseReload?.();
});

test("keeps an updated summary in Action required while changing its unread weight", async () => {
  const readSummary: AgentSummary = {
    terminalId: secondRunningSession.id,
    provider: "claude",
    status: "running",
    summary: "Read summary",
    generatedAt: "2026-08-05T00:00:00Z",
    unread: false,
  };
  const unreadSummary: AgentSummary = {
    ...readSummary,
    summary: "New unread summary",
    unread: true,
    generatedAt: "2026-08-05T00:01:00Z",
  };
  const encoder = new TextEncoder();
  let eventController: ReadableStreamDefaultController<Uint8Array> | undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions") {
      return jsonResponse([runningSession, secondRunningSession]);
    }
    if (input === "/api/selection" && (!init || init.method === undefined)) {
      return jsonResponse({
          terminalIds: [runningSession.id],
          manualTerminalIds: [runningSession.id],
          pinnedTerminalIds: [],
          focusedTerminalId: runningSession.id,
          filters: { statuses: [], cwds: [] },
          revision: 3,
      });
    }
    if (input === "/api/events") {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          eventController = controller;
        },
      }), {
        headers: { "Content-Type": "application/x-ndjson" },
      });
    }
    if (input === "/api/agent-summaries") {
      return jsonResponse([readSummary]);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => (
        <div aria-label={`${session.name} terminal pane`} />
      )}
    />,
  );

  expect(await screen.findByLabelText("Codex terminal pane")).toBeVisible();
  await waitFor(() => expect(eventController).toBeDefined());
  await user.click(screen.getByRole("button", { name: "Inbox" }));
  expect(screen.getAllByText(readSummary.summary).length).toBeGreaterThan(0);

  eventController?.enqueue(encoder.encode(JSON.stringify({
    sequence: 10,
    occurredAt: "2026-08-05T00:02:00Z",
    type: "agent.summary.updated",
    data: unreadSummary,
  }) + "\n"));

  await waitFor(() => {
    expect(screen.queryByText(readSummary.summary)).not.toBeInTheDocument();
  });
  expect(screen.getAllByText(unreadSummary.summary).length).toBeGreaterThan(0);
  eventController?.close();
});

test("reloads agent summaries after an SSE reconnect", async () => {
  const readSummary: AgentSummary = {
    terminalId: secondRunningSession.id,
    provider: "claude",
    status: "running",
    summary: "The summary before reconnect.",
    generatedAt: "2026-08-05T00:00:00Z",
    unread: false,
  };
  const refreshedSummary: AgentSummary = {
    ...readSummary,
    summary: "The summary recovered after reconnect.",
    generatedAt: "2026-08-05T00:01:00Z",
    unread: true,
  };
  const eventControllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  let summaryLoads = 0;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions") {
      return jsonResponse([runningSession, secondRunningSession]);
    }
    if (input === "/api/selection" && (!init || init.method === undefined)) {
      return jsonResponse({
          terminalIds: [runningSession.id],
          manualTerminalIds: [runningSession.id],
          pinnedTerminalIds: [],
          focusedTerminalId: runningSession.id,
          filters: { statuses: [], cwds: [] },
          revision: 3,
      });
    }
    if (input === "/api/events") {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          eventControllers.push(controller);
        },
      }), {
        headers: { "Content-Type": "application/x-ndjson" },
      });
    }
    if (input === "/api/agent-summaries") {
      summaryLoads += 1;
      return jsonResponse([summaryLoads === 1 ? readSummary : refreshedSummary]);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => (
        <div aria-label={`${session.name} terminal pane`} />
      )}
    />,
  );

  expect(await screen.findByLabelText("Codex terminal pane")).toBeVisible();
  await waitFor(() => {
    expect(summaryLoads).toBe(1);
    expect(eventControllers).toHaveLength(1);
  });
  await user.click(screen.getByRole("button", { name: "Inbox" }));
  expect(screen.getAllByText(readSummary.summary).length).toBeGreaterThan(0);

  eventControllers[0].close();
  await waitFor(() => expect(summaryLoads).toBe(2), { timeout: 2_000 });
  expect(screen.getByText(refreshedSummary.summary)).toBeInTheDocument();
  eventControllers[eventControllers.length - 1]?.close();
  expect(fetchMock).toHaveBeenCalledWith("/api/agent-summaries", expect.anything());
});

test("does not resurrect a deleted summary from a stale reconnect snapshot", async () => {
  const summary: AgentSummary = {
    terminalId: secondRunningSession.id,
    provider: "claude",
    status: "running",
    summary: "The summary that was deleted.",
    generatedAt: "2026-08-05T00:00:00Z",
    unread: false,
  };
  const encoder = new TextEncoder();
  const eventControllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  let summaryLoads = 0;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions") {
      return jsonResponse([runningSession, secondRunningSession]);
    }
    if (input === "/api/selection" && (!init || init.method === undefined)) {
      return jsonResponse({
          terminalIds: [runningSession.id],
          manualTerminalIds: [runningSession.id],
          pinnedTerminalIds: [],
          focusedTerminalId: runningSession.id,
          filters: { statuses: [], cwds: [] },
          revision: 3,
      });
    }
    if (input === "/api/events") {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          eventControllers.push(controller);
        },
      }), {
        headers: { "Content-Type": "application/x-ndjson" },
      });
    }
    if (input === "/api/agent-summaries") {
      summaryLoads += 1;
      return jsonResponse([summary]);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => (
        <div aria-label={`${session.name} terminal pane`} />
      )}
    />,
  );

  expect(await screen.findByLabelText("Codex terminal pane")).toBeVisible();
  await waitFor(() => {
    expect(summaryLoads).toBe(1);
    expect(eventControllers).toHaveLength(1);
  });
  await user.click(screen.getByRole("button", { name: "Inbox" }));
  expect(screen.getByText(summary.summary)).toBeInTheDocument();

  eventControllers[0].enqueue(encoder.encode(JSON.stringify({
    sequence: 12,
    occurredAt: "2026-08-05T00:02:00Z",
    type: "agent.summary.deleted",
    data: { terminalId: summary.terminalId },
  }) + "\n"));
  await waitFor(() => expect(screen.queryByText(summary.summary)).not.toBeInTheDocument());
  eventControllers[0].close();

  await waitFor(() => expect(summaryLoads).toBe(2), { timeout: 2_000 });
  expect(screen.queryByText(summary.summary)).not.toBeInTheDocument();
  eventControllers[eventControllers.length - 1]?.close();
  expect(fetchMock).toHaveBeenCalledWith("/api/agent-summaries", expect.anything());
});

test("retries agent summaries after an initial load failure when Agents opens", async () => {
  const summary: AgentSummary = {
    terminalId: secondRunningSession.id,
    provider: "claude",
    status: "running",
    summary: "The summary loaded after retry.",
    generatedAt: "2026-08-05T00:00:00Z",
    unread: true,
  };
  let summaryLoads = 0;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (input === "/api/sessions") {
      return jsonResponse([runningSession, secondRunningSession]);
    }
    if (input === "/api/agent-summaries") {
      summaryLoads += 1;
      return summaryLoads === 1
        ? jsonResponse({ code: "temporary_failure", message: "Try again." }, 500)
        : jsonResponse([summary]);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
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

  expect(await screen.findByLabelText("Codex terminal pane")).toBeVisible();
  await waitFor(() => expect(summaryLoads).toBe(1));
  await user.click(screen.getByRole("button", { name: "Inbox" }));
  expect((await screen.findAllByText(summary.summary)).length).toBeGreaterThan(0);
  expect(summaryLoads).toBe(2);
  expect(fetchMock).toHaveBeenCalledWith("/api/agent-summaries", expect.anything());
});

test("does not let a stale read response overwrite a newer SSE summary", async () => {
  const readSummary: AgentSummary = {
    terminalId: secondRunningSession.id,
    provider: "claude",
    status: "running",
    summary: "The old read summary.",
    generatedAt: "2026-08-05T00:00:00Z",
    unread: true,
  };
  const unreadSummary: AgentSummary = {
    ...readSummary,
    status: "waiting",
    summary: "The newer unread summary.",
    generatedAt: "2026-08-05T00:01:00Z",
    unread: true,
  };
  let releaseRead: (() => void) | undefined;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const encoder = new TextEncoder();
  let eventController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions") {
      return jsonResponse([runningSession, secondRunningSession]);
    }
    if (input === "/api/selection" && (!init || init.method === undefined)) {
      return jsonResponse({
          terminalIds: [runningSession.id],
          manualTerminalIds: [runningSession.id],
          pinnedTerminalIds: [],
          focusedTerminalId: runningSession.id,
          filters: { statuses: [], cwds: [] },
          revision: 3,
      });
    }
    if (input === "/api/events") {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          eventController = controller;
        },
      }), {
        headers: { "Content-Type": "application/x-ndjson" },
      });
    }
    if (input === "/api/agent-summaries") {
      return jsonResponse([readSummary]);
    }
    if (input === "/api/agent-summaries/session-2/read") {
      await readGate;
      return jsonResponse(readSummary);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => (
        <div aria-label={`${session.name} terminal pane`} />
      )}
    />,
  );

  expect(await screen.findByLabelText("Codex terminal pane")).toBeVisible();
  await waitFor(() => expect(eventController).toBeDefined());
  await user.click(screen.getByRole("button", { name: "Inbox" }));
  await user.click(screen.getByRole("button", { name: "Open Needs approval" }));
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent-summaries/session-2/read",
      expect.objectContaining({ method: "POST" }),
    );
  });

  eventController?.enqueue(encoder.encode(JSON.stringify({
    sequence: 11,
    occurredAt: "2026-08-05T00:02:00Z",
    type: "agent.summary.updated",
    data: unreadSummary,
  }) + "\n"));
  await waitFor(() => {
    expect(screen.queryByText(readSummary.summary)).not.toBeInTheDocument();
  });

  expect((await screen.findAllByText(unreadSummary.summary)).length).toBeGreaterThan(0);

  releaseRead?.();
  await waitFor(() => {
    expect(screen.getByRole("tab", { name: /Action required/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getAllByText(unreadSummary.summary).length).toBeGreaterThan(0);
    expect(screen.queryByText(readSummary.summary)).not.toBeInTheDocument();
  });
  await user.click(screen.getByRole("button", { name: "Open terminal" }));
  expect(await screen.findByLabelText("Claude terminal pane")).toBeVisible();
  eventController?.close();
});

test("does not render the removed dashboard or request its API", async () => {
  history.replaceState(null, "", "/tasks");
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (input === "/api/sessions") return jsonResponse([runningSession]);
    if (input === "/api/projects") return jsonResponse([]);
    if (input === "/api/agent-summaries") return jsonResponse([]);
    throw new Error(`Unexpected request: ${String(input)}`);
  });

  render(
    <App
      syncSelection={false}
      syncEvents={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => (
        <div aria-label={`${session.name} terminal pane`} />
      )}
    />,
  );

  expect(await screen.findByLabelText("Codex terminal pane")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Tasks" })).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/tasks"))).toBe(false);
});

test("serializes rapid project reorder requests and keeps the latest intent", async () => {
  const secondProject: Project = {
    id: "project-second",
    path: "/workspace/second",
    createdAt: "2026-07-28T00:01:00Z",
    order: 2,
  };
  const firstProject: Project = {
    id: "project-first",
    path: "/workspace/first",
    createdAt: "2026-07-28T00:00:00Z",
    order: 1,
  };
  const session: Session = {
    ...plainTerminalSession,
    id: "project-order-session",
    projectId: firstProject.id,
  };
  const projectOrderRequests: string[][] = [];
  let releaseFirstRequest = () => {};
  const firstResponse = new Promise<Response>((resolve) => {
    releaseFirstRequest = () => {
      resolve(jsonResponse([secondProject, firstProject]));
    };
  });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([session]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([firstProject, secondProject]);
    }
    if (input === "/api/agent-summaries" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/projects/order" && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { ids: string[] };
      projectOrderRequests.push(body.ids);
      if (projectOrderRequests.length === 1) return firstResponse;
      return jsonResponse(
        body.ids.map((id) => id === firstProject.id ? firstProject : secondProject),
      );
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });

  render(
    <App
      syncSelection={false}
      syncEvents={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(currentSession) => <div aria-label={`${currentSession.id} terminal pane`} />}
    />,
  );

  const firstHeader = await screen.findByRole("heading", { name: "first" });
  const secondHeader = screen.getByRole("heading", { name: "second" });
  const dataTransfer = {
    effectAllowed: "",
    dropEffect: "",
    setData: vi.fn(),
    getData: vi.fn(),
  };
  fireEvent.dragStart(secondHeader.closest("header")!, { dataTransfer });
  fireEvent.dragOver(firstHeader.closest("header")!, { dataTransfer });
  fireEvent.drop(firstHeader.closest("header")!, { dataTransfer });

  await waitFor(() => expect(projectOrderRequests).toHaveLength(1));
  const optimisticFirstHeader = screen.getByRole("heading", { name: "second" });
  const optimisticSecondHeader = screen.getByRole("heading", { name: "first" });
  fireEvent.dragStart(optimisticSecondHeader.closest("header")!, { dataTransfer });
  fireEvent.dragOver(optimisticFirstHeader.closest("header")!, { dataTransfer });
  fireEvent.drop(optimisticFirstHeader.closest("header")!, { dataTransfer });

  expect(projectOrderRequests).toHaveLength(1);
  releaseFirstRequest();
  await waitFor(() => expect(projectOrderRequests).toHaveLength(2));
  expect(projectOrderRequests[0]).toEqual([secondProject.id, firstProject.id]);
  expect(projectOrderRequests[1]).toEqual([firstProject.id, secondProject.id]);
  await waitFor(() => {
    const headers = [...document.querySelectorAll(".project-sidebar-group > header h2")]
      .map((heading) => heading.textContent);
    expect(headers).toEqual(["first", "second"]);
  });
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/projects/order",
    expect.objectContaining({ method: "PUT" }),
  );
});

test("keeps an optimistic session order while polling returns a stale order", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const project: Project = {
      id: "project-session-order",
      path: "/workspace/session-order",
      createdAt: "2026-07-28T00:00:00Z",
      order: 1,
    };
    const firstSession: Session = {
      ...plainTerminalSession,
      id: "session-order-first",
      name: "First session",
      projectId: project.id,
    };
    const secondSession: Session = {
      ...plainTerminalSession,
      id: "session-order-second",
      name: "Second session",
      projectId: project.id,
    };
    const sessionOrderRequests: string[][] = [];
    let releaseFirstRequest = () => {};
    const firstResponse = new Promise<Response>((resolve) => {
      releaseFirstRequest = () => resolve(jsonResponse([secondSession, firstSession]));
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (input === "/api/sessions" && (!init || init.method === undefined)) {
        return jsonResponse([firstSession, secondSession]);
      }
      if (input === "/api/projects" && (!init || init.method === undefined)) {
        return jsonResponse([project]);
      }
      if (input === "/api/agent-summaries" && (!init || init.method === undefined)) {
        return jsonResponse([]);
      }
      if (input === "/api/sessions/order" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { ids: string[] };
        sessionOrderRequests.push(body.ids);
        if (sessionOrderRequests.length === 1) return firstResponse;
        return jsonResponse(body.ids.map((id) => id === firstSession.id ? firstSession : secondSession));
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    render(
      <App
        syncSelection={false}
        syncEvents={false}
        initialToken="valid-token"
        initialSettings={defaultSettings}
        renderTerminal={(currentSession) => <div aria-label={`${currentSession.id} terminal pane`} />}
      />,
    );

    const sidebar = await screen.findByRole("navigation", { name: "Projects and sessions" });
    const rowIDs = () => [...sidebar.querySelectorAll(".project-session-row")]
      .map((row) => row.getAttribute("data-session-id"));
    await waitFor(() => expect(rowIDs()).toEqual([firstSession.id, secondSession.id]));
    const firstRow = sidebar.querySelector(`[data-session-id="${firstSession.id}"]`);
    const secondRow = sidebar.querySelector(`[data-session-id="${secondSession.id}"]`);
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: vi.fn(),
      getData: vi.fn(),
    };
    fireEvent.dragStart(secondRow!, { dataTransfer });
    fireEvent.dragOver(firstRow!, { dataTransfer });
    fireEvent.drop(firstRow!, { dataTransfer });
    await waitFor(() => expect(sessionOrderRequests).toHaveLength(1));
    expect(rowIDs()).toEqual([secondSession.id, firstSession.id]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await waitFor(() => expect(rowIDs()).toEqual([secondSession.id, firstSession.id]));

    releaseFirstRequest();
    await waitFor(() => expect(rowIDs()).toEqual([secondSession.id, firstSession.id]));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/order",
      expect.objectContaining({ method: "PUT" }),
    );
  } finally {
    vi.useRealTimers();
  }
});

test("restores a selected Inbox item from its URL", async () => {
  history.replaceState(null, "", "/inbox/session-2");
  const firstSummary: AgentSummary = {
    terminalId: runningSession.id,
    provider: "codex",
    status: "running",
    summary: "The first agent is updating the API.",
    generatedAt: "2026-08-05T00:00:00Z",
    unread: false,
  };
  const secondSummary: AgentSummary = {
    terminalId: secondRunningSession.id,
    provider: "claude",
    status: "waiting",
    summary: "The second agent is waiting for approval.",
    action: "Review the proposed route change.",
    generatedAt: "2026-08-05T00:01:00Z",
    unread: false,
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (input === "/api/sessions") return jsonResponse([runningSession, secondRunningSession]);
    if (input === "/api/agent-summaries") return jsonResponse([firstSummary, secondSummary]);
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();
  render(
    <App
      syncSelection={false}
      syncEvents={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
    />,
  );

  expect(await screen.findByRole("heading", { name: "Inbox" })).toBeInTheDocument();
  expect(screen.getAllByText(secondSummary.summary).length).toBeGreaterThan(0);
  expect(window.location.pathname).toBe("/inbox/session-2");

  await user.click(screen.getByRole("button", { name: "Open Implement v0.2" }));
  expect(window.location.pathname).toBe("/inbox/session-1");
  expect(screen.getAllByText(firstSummary.summary).length).toBeGreaterThan(0);
});

test("acknowledges a need-attention terminal when it receives focus", async () => {
  const attention = { ...secondRunningSession, needsAttention: true };
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([runningSession, attention]))
    .mockImplementationOnce(legacyProjectsResponse)
    .mockImplementationOnce(() => jsonResponse([]))
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
      4,
      "/api/sessions/session-2/acknowledge-attention",
      expect.objectContaining({ method: "POST" }),
    );
  });
  expect(await screen.findByLabelText("Claude waiting")).toBeVisible();
});

test("does not select attention transitions", async () => {
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
        initialSettings={defaultSettings}
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

test("keeps a remaining session selected after an asynchronous disappearance with no prior survivor", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    history.replaceState(null, "", "/?terminal=stale-disappearance");
    const staleSession: Session = {
      ...plainTerminalSession,
      id: "stale-disappearance",
      name: "Stale disappearance",
    };
    const replacement: Session = {
      ...plainTerminalSession,
      id: "new-session-after-refresh",
      name: "New session after refresh",
    };
    let sessionReads = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (input === "/api/sessions") {
        sessionReads += 1;
        return jsonResponse(sessionReads === 1 ? [staleSession] : [replacement]);
      }
      if (input === "/api/projects") return legacyProjectsResponse();
      if (input === "/api/agent-summaries") return jsonResponse([]);
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    render(
      <App
        syncSelection={false}
        syncEvents={false}
        initialToken="valid-token"
        initialSettings={defaultSettings}
        renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
      />,
    );

    expect(await screen.findByLabelText("Stale disappearance terminal pane")).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Select New session after refresh" }))
        .toHaveAttribute("aria-current", "true");
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer valid-token" }),
      }),
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

function legacyProjectsResponse() {
  return jsonResponse({ code: "not_found", message: "Projects are unavailable." }, 404);
}

test("refreshes All sessions while the dialog remains open", async () => {
  const currentSession: AllSession = {
    id: "all-current",
    terminalId: runningSession.id,
    agent: "codex",
    sessionId: "all-current-session",
    title: "Current session",
    cwd: runningSession.cwd,
    updatedAt: "2026-08-27T00:00:00Z",
    state: "open",
  };
  const newSession: AllSession = {
    ...currentSession,
    id: "all-new",
    terminalId: "session-new",
    sessionId: "all-new-session",
    title: "New session while open",
    updatedAt: "2026-08-27T00:01:00Z",
  };
  let listedSessions = [currentSession];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([runningSession]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/agent-summaries" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/all-sessions" && (!init || init.method === undefined)) {
      return jsonResponse(listedSessions);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncSelection={false}
      syncEvents={false}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  await user.click(await screen.findByRole("button", { name: "All sessions" }));
  const dialog = await screen.findByRole("dialog", { name: "All sessions" });
  await waitFor(() => expect(within(dialog).getByText("Current session")).toBeVisible());

  listedSessions = [newSession, currentSession];
  await waitFor(() => {
    expect(within(dialog).getByText("New session while open")).toBeVisible();
  }, { timeout: 3_000 });
  expect(fetchMock.mock.calls.filter(([input]) => input === "/api/all-sessions").length)
    .toBeGreaterThan(1);
});

test("shows and resumes an archived session from the project sidebar", async () => {
  const archivedSession: Session = {
    ...runningSession,
    id: "archived-sidebar-session",
    name: "Archived rollout",
    state: "exited",
    archived: true,
    agentStatus: "waiting",
    agentTitle: "Build the release",
    agentSessionId: "archived-sidebar-session-id",
  };
  const resumedTerminal: Session = {
    ...archivedSession,
    id: "resumed-sidebar-session",
    name: "Codex",
    state: "running",
    archived: false,
    agentStatus: "waiting",
  };
  const selection: SelectionSnapshot = {
    terminalIds: [resumedTerminal.id],
    manualTerminalIds: [resumedTerminal.id],
    pinnedTerminalIds: [],
    focusedTerminalId: resumedTerminal.id,
    filters: { statuses: [], cwds: [] },
    pinnedFilters: { statuses: [], cwds: [] },
    revision: 9,
  };
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions/archived" && (!init || init.method === undefined)) {
      return jsonResponse([archivedSession]);
    }
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([plainTerminalSession]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/agent-summaries" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/all-sessions/codex/archived-sidebar-session-id/resume") {
      return jsonResponse({ terminal: resumedTerminal, selection });
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncSelection={false}
      syncEvents={false}
      renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
    />,
  );

  await user.click(await screen.findByRole("button", { name: "Show archived" }));
  const archivedRow = await screen.findByRole("button", {
    name: /Select Codex.*Build the release/,
  });
  expect(archivedRow.closest(".project-session-row")).toHaveAttribute(
    "data-state",
    "archived",
  );
  await user.click(archivedRow);

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/all-sessions/codex/archived-sidebar-session-id/resume",
      expect.objectContaining({ method: "POST" }),
    );
  });
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: /Select Codex.*Build the release/ }))
      .toHaveAttribute("aria-current", "true");
  });
  expect(screen.queryByRole("button", { name: "Show archived" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Hide archived" })).toBeVisible();
});

test("stores a valid token and shows project setup when the session list is empty", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([]))
    .mockImplementationOnce(() => jsonResponse([]))
    .mockImplementationOnce(() => jsonResponse([]));
  const user = userEvent.setup();
  render(
    <App syncSelection={false}
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div>{session.name}</div>}
    />,
  );

  await user.type(screen.getByLabelText("Access token"), "valid-token");
  await user.click(screen.getByRole("button", { name: "Open Euphony" }));

  expect(await screen.findByRole("button", { name: "Add project" })).toBeVisible();
  expect(screen.queryByRole("button", { name: /Select Terminal/ })).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock).toHaveBeenLastCalledWith("/api/agent-summaries", expect.anything());
  expect(fetchMock.mock.calls.some(
    ([input, init]) => input === "/api/sessions" && init?.method === "POST",
  )).toBe(false);
  expect(sessionStorage.getItem("euphony.token")).toBe("valid-token");
});

test("consumes a token from the URL without leaving it in browser history", async () => {
  history.replaceState(null, "", "/?token=development-token");
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([]))
    .mockImplementationOnce(() => jsonResponse([]))
    .mockImplementationOnce(() => jsonResponse([]));

  render(
    <App syncSelection={false}
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div>{session.name}</div>}
    />,
  );

  expect(await screen.findByRole("button", { name: "Add project" })).toBeVisible();
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

test("shows the project setup action without creating an implicit terminal", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/sessions" && init?.method === "POST") {
      return jsonResponse(runningSession, 201);
    }
    if (input === "/api/agent-summaries") return jsonResponse([]);
    throw new Error(`Unexpected request: ${String(input)}`);
  });

  const user = userEvent.setup();
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncSelection={false}
      syncEvents={false}
      renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
    />,
  );

  expect(await screen.findByRole("button", { name: "Add project" })).toBeVisible();
  expect(screen.queryByRole("button", { name: /Select Terminal/ })).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.some(
    ([input, init]) => input === "/api/sessions" && init?.method === "POST",
  )).toBe(false);

  await user.click(screen.getByRole("button", { name: "Add project" }));
  expect(screen.getByRole("dialog", { name: "Add project" })).toBeVisible();
  expect(fetchMock.mock.calls.some(
    ([input, init]) => input === "/api/sessions" && init?.method === "POST",
  )).toBe(false);
});

test("keeps legacy terminal creation when the project API is unavailable", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return legacyProjectsResponse();
    }
    if (input === "/api/agent-summaries") return jsonResponse([]);
    if (input === "/api/sessions" && init?.method === "POST") {
      return jsonResponse(runningSession, 201);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();

  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncSelection={false}
      syncEvents={false}
      renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
    />,
  );

  await user.click(await screen.findByRole("button", { name: "New terminal" }));

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

test("does not create work while the initial project capability is loading", async () => {
  let releaseSessions!: (response: Response) => void;
  const sessionsGate = new Promise<Response>((resolve) => {
    releaseSessions = resolve;
  });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return sessionsGate;
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/agent-summaries") return jsonResponse([]);
    if (input === "/api/sessions" && init?.method === "POST") {
      return jsonResponse(runningSession, 201);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncSelection={false}
      syncEvents={false}
    />,
  );

  fireEvent.keyDown(window, { key: "b", ctrlKey: true });
  fireEvent.keyDown(window, { key: "c" });
  expect(fetchMock.mock.calls.some(
    ([input, init]) => input === "/api/sessions" && init?.method === "POST",
  )).toBe(false);

  releaseSessions(await jsonResponse([]));
  expect(await screen.findByRole("button", { name: "Add project" })).toBeVisible();
});

test("creates a project and renders its empty project section", async () => {
  const createdProject: Project = {
    id: "project-new",
    path: "/workspace/new-project",
    createdAt: "2026-08-12T00:00:00Z",
  };
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/projects" && init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toEqual({ path: createdProject.path });
      return jsonResponse(createdProject, 201);
    }
    if (input === "/api/agent-summaries") return jsonResponse([]);
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();

  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncSelection={false}
      syncEvents={false}
      renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
    />,
  );

  await user.click(await screen.findByRole("button", { name: "Add project" }));
  await user.type(screen.getByLabelText("Project directory"), createdProject.path);
  await user.click(screen.getByRole("button", { name: "Add project" }));

  const projectHeading = await screen.findByRole("heading", { name: "new-project" });
  expect(projectHeading).toBeVisible();
  expect(projectHeading).toHaveAttribute("title", createdProject.path);
  expect(screen.getByRole("navigation", { name: "Projects and sessions" })).toHaveTextContent(
    "new-project",
  );
  expect(screen.queryByRole("dialog", { name: "Add project" })).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.some(
    ([input, init]) => input === "/api/sessions" && init?.method === "POST",
  )).toBe(false);
});

test("fills the project path from the GUI folder picker", async () => {
  const selectedPath = "/workspace/selected-project";
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/projects/pick-directory" && init?.method === "POST") {
      return jsonResponse({ path: selectedPath });
    }
    if (input === "/api/agent-summaries") return jsonResponse([]);
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();

  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncSelection={false}
      syncEvents={false}
    />,
  );

  await user.click(await screen.findByRole("button", { name: "Add project" }));
  const dialog = screen.getByRole("dialog", { name: "Add project" });
  await user.click(within(dialog).getByRole("button", { name: "Choose folder" }));

  expect(within(dialog).getByLabelText("Project directory")).toHaveValue(selectedPath);
  expect(fetchMock.mock.calls.some(
    ([input, init]) => input === "/api/projects" && init?.method === "POST",
  )).toBe(false);
});

test("keeps the project dialog open when creation fails", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/projects" && init?.method === "POST") {
      return jsonResponse(
        { code: "project_path_invalid", message: "Choose an existing project directory." },
        400,
      );
    }
    if (input === "/api/agent-summaries") return jsonResponse([]);
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();

  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncSelection={false}
      syncEvents={false}
    />,
  );

  await user.click(await screen.findByRole("button", { name: "Add project" }));
  const dialog = screen.getByRole("dialog", { name: "Add project" });
  const directory = within(dialog).getByLabelText("Project directory");
  await user.type(directory, "/workspace/missing");
  await user.click(within(dialog).getByRole("button", { name: "Add project" }));

  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Choose an existing project directory.",
  );
  expect(screen.getByRole("dialog", { name: "Add project" })).toBeVisible();
  expect(directory).toHaveValue("/workspace/missing");
  expect(fetchMock.mock.calls.filter(
    ([input, init]) => input === "/api/projects" && init?.method === "POST",
  )).toHaveLength(1);
});

test("creates a terminal with the selected project's id", async () => {
  const project: Project = {
    id: "project-1",
    path: "/workspace/project",
    createdAt: "2026-08-12T00:00:00Z",
  };
  const created = {
    ...plainTerminalSession,
    id: "project-terminal",
    cwd: project.path,
    projectId: project.id,
  };
  const selection: SelectionSnapshot = {
    terminalIds: [created.id],
    manualTerminalIds: [created.id],
    pinnedTerminalIds: [],
    focusedTerminalId: created.id,
    filters: { statuses: [], cwds: [] },
    revision: 4,
  };
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([project]);
    }
    if (input === "/api/terminals" && init?.method === "POST") {
      return jsonResponse({ terminal: created, selection }, 201);
    }
    if (input === "/api/agent-summaries") return jsonResponse([]);
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();

  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncSelection={false}
      syncEvents={false}
      renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
    />,
  );

  await user.click(await screen.findByRole("button", {
    name: `Create terminal in ${project.path}`,
  }));

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/terminals",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Terminal",
          selectionMode: "replace",
          projectId: project.id,
        }),
      }),
    );
  });
  expect(await screen.findByLabelText("Terminal terminal pane")).toBeVisible();
});

test("starts an agent from a project section", async () => {
  const project: Project = {
    id: "project-agent",
    path: "/workspace/agent-project",
    createdAt: "2026-08-12T00:00:00Z",
  };
  const created: Session = {
    ...plainTerminalSession,
    id: "project-agent-terminal",
    cwd: project.path,
    projectId: project.id,
    agent: "codex",
    agentStatus: "starting",
  };
  const started: Session = {
    ...created,
    agentStatus: "running",
    agentTitle: "Implement the project",
  };
  const selection: SelectionSnapshot = {
    terminalIds: [created.id],
    manualTerminalIds: [created.id],
    pinnedTerminalIds: [],
    focusedTerminalId: created.id,
    filters: { statuses: [], cwds: [] },
    revision: 8,
  };
  let listedSessions: Session[] = [];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse(listedSessions);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([project]);
    }
    if (input === "/api/agent-summaries") return jsonResponse([]);
    if (input === "/api/terminals" && init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toEqual({
        name: "Terminal",
        selectionMode: "replace",
        projectId: project.id,
        command: "claude",
      });
      listedSessions = [started];
      return jsonResponse({ terminal: created, selection }, 201);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();

  render(
    <App
      initialToken="valid-token"
      initialSettings={{ ...defaultSettings, codingAgent: "claude" }}
      syncSelection={false}
      syncEvents={false}
      renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
    />,
  );

  await user.click(await screen.findByRole("button", {
    name: `Start agent in ${project.path}`,
  }));
  expect(screen.queryByRole("dialog", { name: "Start an agent" })).not.toBeInTheDocument();

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/terminals",
      expect.objectContaining({ method: "POST" }),
    );
  });
  expect(await screen.findByLabelText("Terminal terminal pane")).toBeVisible();
});

test("reports when a project agent exits before connecting", async () => {
  const project: Project = {
    id: "project-agent-exit",
    path: "/workspace/agent-exit-project",
    createdAt: "2026-08-12T00:00:00Z",
  };
  const created: Session = {
    ...plainTerminalSession,
    id: "project-agent-exit-terminal",
    cwd: project.path,
    projectId: project.id,
    agent: "codex",
    agentStatus: "starting",
  };
  const selection: SelectionSnapshot = {
    terminalIds: [created.id],
    manualTerminalIds: [created.id],
    pinnedTerminalIds: [],
    focusedTerminalId: created.id,
    filters: { statuses: [], cwds: [] },
    revision: 9,
  };
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([project]);
    }
    if (input === "/api/agent-summaries") return jsonResponse([]);
    if (input === "/api/terminals" && init?.method === "POST") {
      return jsonResponse({ terminal: created, selection }, 201);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();

  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncSelection={false}
      syncEvents={false}
      renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
    />,
  );

  await user.click(await screen.findByRole("button", {
    name: `Start agent in ${project.path}`,
  }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Codex exited before it could connect.",
  );
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/terminals",
    expect.objectContaining({ method: "POST" }),
  );
});

test("reports when a project agent disappears after the initial refresh", async () => {
  const project: Project = {
    id: "project-agent-race",
    path: "/workspace/agent-race-project",
    createdAt: "2026-08-12T00:00:00Z",
  };
  const created: Session = {
    ...plainTerminalSession,
    id: "project-agent-race-terminal",
    cwd: project.path,
    projectId: project.id,
    agent: "codex",
    agentStatus: "starting",
  };
  const selection: SelectionSnapshot = {
    terminalIds: [created.id],
    manualTerminalIds: [created.id],
    pinnedTerminalIds: [],
    focusedTerminalId: created.id,
    filters: { statuses: [], cwds: [] },
    revision: 10,
  };
  let sessionListCalls = 0;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      sessionListCalls += 1;
      return jsonResponse(sessionListCalls === 2 ? [created] : []);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([project]);
    }
    if (input === "/api/agent-summaries") return jsonResponse([]);
    if (input === "/api/terminals" && init?.method === "POST") {
      return jsonResponse({ terminal: created, selection }, 201);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();

  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncSelection={false}
      syncEvents={false}
      renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
    />,
  );

  await user.click(await screen.findByRole("button", {
    name: `Start agent in ${project.path}`,
  }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Codex exited before it could connect.",
  );
  expect(sessionListCalls).toBeGreaterThanOrEqual(3);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/terminals",
    expect.objectContaining({ method: "POST" }),
  );
});

test("keeps checking when the post-start refresh fails", async () => {
  const project: Project = {
    id: "project-agent-refresh-error",
    path: "/workspace/agent-refresh-error-project",
    createdAt: "2026-08-12T00:00:00Z",
  };
  const created: Session = {
    ...plainTerminalSession,
    id: "project-agent-refresh-error-terminal",
    cwd: project.path,
    projectId: project.id,
    agent: "codex",
    agentStatus: "starting",
  };
  const selection: SelectionSnapshot = {
    terminalIds: [created.id],
    manualTerminalIds: [created.id],
    pinnedTerminalIds: [],
    focusedTerminalId: created.id,
    filters: { statuses: [], cwds: [] },
    revision: 11,
  };
  let sessionListCalls = 0;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      sessionListCalls += 1;
      if (sessionListCalls === 2) throw new Error("temporary refresh failure");
      return jsonResponse([]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([project]);
    }
    if (input === "/api/agent-summaries") return jsonResponse([]);
    if (input === "/api/terminals" && init?.method === "POST") {
      return jsonResponse({ terminal: created, selection }, 201);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();

  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncSelection={false}
      syncEvents={false}
      renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
    />,
  );

  await user.click(await screen.findByRole("button", {
    name: `Start agent in ${project.path}`,
  }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Codex exited before it could connect.",
  );
  expect(sessionListCalls).toBeGreaterThanOrEqual(3);
});

test("retries a failed launch verification refresh", async () => {
  const project: Project = {
    id: "project-agent-verification-error",
    path: "/workspace/agent-verification-error-project",
    createdAt: "2026-08-12T00:00:00Z",
  };
  const created: Session = {
    ...plainTerminalSession,
    id: "project-agent-verification-error-terminal",
    cwd: project.path,
    projectId: project.id,
    agent: "codex",
    agentStatus: "starting",
  };
  const selection: SelectionSnapshot = {
    terminalIds: [created.id],
    manualTerminalIds: [created.id],
    pinnedTerminalIds: [],
    focusedTerminalId: created.id,
    filters: { statuses: [], cwds: [] },
    revision: 12,
  };
  let sessionListCalls = 0;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      sessionListCalls += 1;
      if (sessionListCalls === 3) throw new Error("temporary verification failure");
      return jsonResponse([]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([project]);
    }
    if (input === "/api/agent-summaries") return jsonResponse([]);
    if (input === "/api/terminals" && init?.method === "POST") {
      return jsonResponse({ terminal: created, selection }, 201);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();

  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncSelection={false}
      syncEvents={false}
      renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
    />,
  );

  await user.click(await screen.findByRole("button", {
    name: `Start agent in ${project.path}`,
  }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Codex exited before it could connect.",
  );
  expect(sessionListCalls).toBeGreaterThanOrEqual(4);
});

test("does not schedule launch verification after unmount", async () => {
  const project: Project = {
    id: "project-agent-unmount",
    path: "/workspace/agent-unmount-project",
    createdAt: "2026-08-12T00:00:00Z",
  };
  const created: Session = {
    ...plainTerminalSession,
    id: "project-agent-unmount-terminal",
    cwd: project.path,
    projectId: project.id,
    agent: "codex",
    agentStatus: "starting",
  };
  const selection: SelectionSnapshot = {
    terminalIds: [created.id],
    manualTerminalIds: [created.id],
    pinnedTerminalIds: [],
    focusedTerminalId: created.id,
    filters: { statuses: [], cwds: [] },
    revision: 13,
  };
  let sessionListCalls = 0;
  let resolvePostStartRefresh = () => {};
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      sessionListCalls += 1;
      if (sessionListCalls === 2) {
        return new Promise<Response>((resolve) => {
          resolvePostStartRefresh = () => resolve(new Response("[]", {
            headers: { "Content-Type": "application/json" },
          }));
        });
      }
      return jsonResponse([]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([project]);
    }
    if (input === "/api/agent-summaries") return jsonResponse([]);
    if (input === "/api/terminals" && init?.method === "POST") {
      return jsonResponse({ terminal: created, selection }, 201);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();
  const view = render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncSelection={false}
      syncEvents={false}
      renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
    />,
  );

  await user.click(await screen.findByRole("button", {
    name: `Start agent in ${project.path}`,
  }));
  await waitFor(() => expect(sessionListCalls).toBe(2));
  view.unmount();
  resolvePostStartRefresh();
  await new Promise((resolve) => setTimeout(resolve, 600));

  expect(sessionListCalls).toBe(2);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/terminals",
    expect.objectContaining({ method: "POST" }),
  );
});

test("does not let an older session refresh restore a failed launch", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const project: Project = {
      id: "project-agent-stale-refresh",
      path: "/workspace/agent-stale-refresh-project",
      createdAt: "2026-08-12T00:00:00Z",
    };
    const created: Session = {
      ...plainTerminalSession,
      id: "project-agent-stale-refresh-terminal",
      cwd: project.path,
      projectId: project.id,
      agent: "codex",
      agentStatus: "starting",
    };
    const selection: SelectionSnapshot = {
      terminalIds: [created.id],
      manualTerminalIds: [created.id],
      pinnedTerminalIds: [],
      focusedTerminalId: created.id,
      filters: { statuses: [], cwds: [] },
      revision: 14,
    };
    let sessionListCalls = 0;
    let resolveOlderRefresh = () => {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (input === "/api/sessions" && (!init || init.method === undefined)) {
        sessionListCalls += 1;
        if (sessionListCalls === 2) {
          return new Promise<Response>((resolve) => {
            resolveOlderRefresh = () => resolve(new Response(JSON.stringify([created]), {
              headers: { "Content-Type": "application/json" },
            }));
          });
        }
        if (sessionListCalls === 3) return jsonResponse([created]);
        return jsonResponse([]);
      }
      if (input === "/api/projects" && (!init || init.method === undefined)) {
        return jsonResponse([project]);
      }
      if (input === "/api/agent-summaries") return jsonResponse([]);
      if (input === "/api/terminals" && init?.method === "POST") {
        return jsonResponse({ terminal: created, selection }, 201);
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    render(
      <App
        initialToken="valid-token"
        initialSettings={defaultSettings}
        syncSelection={false}
        syncEvents={false}
        renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
      />,
    );

    await screen.findByRole("button", {
      name: `Start agent in ${project.path}`,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(sessionListCalls).toBe(2);

    fireEvent.click(screen.getByRole("button", {
      name: `Start agent in ${project.path}`,
    }));
    await waitFor(() => expect(sessionListCalls).toBe(3));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Codex exited before it could connect.",
    );

    resolveOlderRefresh();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByLabelText(`${created.id} terminal pane`)).not.toBeInTheDocument();
    expect(sessionListCalls).toBeGreaterThanOrEqual(4);
  } finally {
    vi.useRealTimers();
  }
});

test("does not spend launch verification attempts on superseded snapshots", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const project: Project = {
      id: "project-agent-superseded-verification",
      path: "/workspace/agent-superseded-verification-project",
      createdAt: "2026-08-12T00:00:00Z",
    };
    const created: Session = {
      ...plainTerminalSession,
      id: "project-agent-superseded-verification-terminal",
      cwd: project.path,
      projectId: project.id,
      agent: "codex",
      agentStatus: "starting",
    };
    const selection: SelectionSnapshot = {
      terminalIds: [created.id],
      manualTerminalIds: [created.id],
      pinnedTerminalIds: [],
      focusedTerminalId: created.id,
      filters: { statuses: [], cwds: [] },
      revision: 15,
    };
    let sessionListCalls = 0;
    const pendingRefreshes = new Map<number, () => void>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (input === "/api/sessions" && (!init || init.method === undefined)) {
        sessionListCalls += 1;
        if (sessionListCalls === 1) return jsonResponse([]);
        if (sessionListCalls === 2) return jsonResponse([created]);
        if (sessionListCalls % 2 === 1) {
          return new Promise<Response>((resolve) => {
            pendingRefreshes.set(sessionListCalls, () => resolve(new Response(
              JSON.stringify([created]),
              { headers: { "Content-Type": "application/json" } },
            )));
          });
        }
        return jsonResponse([created]);
      }
      if (input === "/api/projects" && (!init || init.method === undefined)) {
        return jsonResponse([project]);
      }
      if (input === "/api/agent-summaries") return jsonResponse([]);
      if (input === "/api/terminals" && init?.method === "POST") {
        return jsonResponse({ terminal: created, selection }, 201);
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    render(
      <App
        initialToken="valid-token"
        initialSettings={defaultSettings}
        syncSelection={false}
        syncEvents={false}
        renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
      />,
    );

    await screen.findByRole("button", {
      name: `Start agent in ${project.path}`,
    });
    fireEvent.click(screen.getByRole("button", {
      name: `Start agent in ${project.path}`,
    }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(sessionListCalls).toBe(4);
    pendingRefreshes.get(3)?.();
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    pendingRefreshes.get(5)?.();
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    pendingRefreshes.get(7)?.();
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    pendingRefreshes.get(9)?.();
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

test("shows the project terminal startup cause when starting an agent fails", async () => {
  const project: Project = {
    id: "project-agent-error",
    path: "/workspace/agent-error-project",
    createdAt: "2026-08-12T00:00:00Z",
  };
  const cause = "start ConPTY process: The system cannot find the file specified.";
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([project]);
    }
    if (input === "/api/agent-summaries") return jsonResponse([]);
    if (input === "/api/terminals" && init?.method === "POST") {
      return jsonResponse({
        code: "terminal_create_failed",
        message: "The terminal could not be created.",
        details: { cause },
      }, 500);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();

  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncSelection={false}
      syncEvents={false}
      renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
    />,
  );

  await user.click(await screen.findByRole("button", {
    name: `Start agent in ${project.path}`,
  }));
  expect(await screen.findByRole("alert")).toHaveTextContent(cause);
  expect(screen.getByRole("alert")).not.toHaveTextContent(
    "The project terminal could not be created.",
  );
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/terminals",
    expect.objectContaining({ method: "POST" }),
  );
});

test("does not render a permanent session information pane beside the terminal", async () => {
  const project: Project = {
    id: "project-info",
    path: "/workspace/info-project",
    createdAt: "2026-08-12T00:00:00Z",
  };
  const session: Session = {
    ...plainTerminalSession,
    id: "session-info",
    cwd: project.path,
    projectId: project.id,
    agent: "codex",
    agentStatus: "waiting",
  };
  const summary: AgentSummary = {
    terminalId: session.id,
    provider: "codex",
    status: "waiting",
    purpose: "Review the release changes",
    summary: "The release branch is ready for final checks.",
    action: "Run the release test suite",
    generatedAt: "2026-08-12T00:01:00Z",
    unread: true,
  };
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    if (input === "/api/sessions") return jsonResponse([session]);
    if (input === "/api/projects") return jsonResponse([project]);
    if (input === "/api/agent-summaries") return jsonResponse([summary]);
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();

  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncSelection={false}
      syncEvents={false}
      renderTerminal={(item) => <div aria-label={`${item.name} terminal pane`} />}
    />,
  );

  expect(await screen.findByLabelText("Terminal terminal pane")).toBeVisible();
  expect(screen.queryByRole("region", { name: "Session information" }))
    .not.toBeInTheDocument();
  expect(screen.queryByRole("separator", { name: "Resize session information" }))
    .not.toBeInTheDocument();
  expect(document.querySelector(".session-info-pane")).not.toBeInTheDocument();
  expect(document.querySelector(".workspace")?.getAttribute("style"))
    .not.toContain("--session-info-width");
  expect(fetchMock).toHaveBeenCalled();
});

test("selects the coding agent in Settings", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (input === "/api/settings" && init?.method === "PATCH") {
      return jsonResponse(JSON.parse(String(init.body)));
    }
    if (input === "/api/settings") return jsonResponse(defaultSettings);
    return jsonResponse([runningSession]);
  });
  const user = userEvent.setup();
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncSelection={false}
      syncEvents={false}
      renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
    />,
  );

  await user.click(await screen.findByRole("button", { name: /Select Codex/ }));
  await screen.findByLabelText("Codex terminal pane");
  await user.click(screen.getByRole("button", { name: "Open settings" }));

  const codingAgent = screen.getByLabelText("Coding agent");
  expect(codingAgent).toHaveValue("codex");
  await user.selectOptions(codingAgent, "claude");
  await user.click(screen.getByRole("button", { name: "Save settings" }));

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({
        method: "PATCH",
        body: expect.stringContaining('"codingAgent":"claude"'),
      }),
    );
  });
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
    .mockImplementationOnce(legacyProjectsResponse)
    .mockImplementationOnce(() => jsonResponse([]))
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
    4,
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

test("creates a terminal in the focused terminal cwd, selects it, and archives an agent", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([runningSession]))
    .mockImplementationOnce(legacyProjectsResponse)
    .mockImplementationOnce(() => jsonResponse([]))
    .mockImplementationOnce(() => jsonResponse(secondRunningSession, 201))
    .mockImplementationOnce(() => jsonResponse({
      id: secondRunningSession.id,
      selection: {
        terminalIds: [],
        manualTerminalIds: [],
        pinnedTerminalIds: [],
        filters: { statuses: [], cwds: [] },
        revision: 1,
      },
    }));

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
    4,
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
  fireEvent.contextMenu(screen.getByRole("button", { name: "Select Claude" }));
  const sessionMenu = screen.getByRole("menu", { name: "Actions for Claude" });
  await user.click(within(sessionMenu).getByRole("menuitem", { name: "Archive" }));

  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Select Claude" })).not.toBeInTheDocument();
  });
  expect(fetchMock).toHaveBeenCalledTimes(5);
  expect(fetchMock).toHaveBeenNthCalledWith(
    5,
    "/api/sessions/session-2/archive",
    expect.objectContaining({ method: "POST" }),
  );
});

test("opens the next rendered sidebar session after deleting across a project boundary", async () => {
  history.replaceState(null, "", "/?terminal=removed-session");
  const removedProject: Project = {
    id: "project-removed",
    path: "/workspace/removed",
    createdAt: "2026-08-20T00:00:00Z",
  };
  const belowProject: Project = {
    id: "project-below",
    path: "/workspace/below",
    createdAt: "2026-08-19T00:00:00Z",
  };
  const removedSession: Session = {
    id: "removed-session",
    name: "Removed",
    state: "running",
    cwd: removedProject.path,
    projectId: removedProject.id,
    createdAt: "2026-08-25T00:00:00Z",
    updatedAt: "2026-08-30T00:00:00Z",
  };
  const belowSession: Session = {
    id: "below-session",
    name: "Below",
    state: "running",
    cwd: belowProject.path,
    projectId: belowProject.id,
    createdAt: "2026-08-24T00:00:00Z",
    updatedAt: "2026-08-29T00:00:00Z",
  };
  const unassignedSession: Session = {
    id: "unassigned-session",
    name: "Unassigned",
    state: "running",
    cwd: "/workspace/unassigned",
    createdAt: "2026-08-23T00:00:00Z",
    updatedAt: "2026-08-28T00:00:00Z",
  };
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([belowSession, removedSession, unassignedSession]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([belowProject, removedProject]);
    }
    if (input === "/api/agent-summaries" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/sessions/removed-session" && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
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
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  const removed = await screen.findByRole("button", { name: "Select Removed" });
  fireEvent.contextMenu(removed);
  const menu = screen.getByRole("menu", { name: "Actions for Removed" });
  await user.click(within(menu).getByRole("menuitem", { name: "Delete" }));
  await user.click(screen.getByRole("button", { name: "Delete terminal" }));

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Select Unassigned" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });
  expect(screen.getByRole("button", { name: "Select Below" })).not.toHaveAttribute(
    "aria-current",
    "true",
  );
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/sessions/removed-session",
    expect.objectContaining({ method: "DELETE" }),
  );
});

test("opens the next rendered sidebar session after archiving across a project boundary", async () => {
  history.replaceState(null, "", "/?terminal=removed-agent");
  const removedProject: Project = {
    id: "project-removed-agent",
    path: "/workspace/removed-agent",
    createdAt: "2026-08-20T00:00:00Z",
  };
  const belowProject: Project = {
    id: "project-below-agent",
    path: "/workspace/below-agent",
    createdAt: "2026-08-19T00:00:00Z",
  };
  const removedAgent: Session = {
    id: "removed-agent",
    name: "Removed agent",
    state: "running",
    cwd: removedProject.path,
    projectId: removedProject.id,
    agent: "codex",
    agentStatus: "waiting",
    createdAt: "2026-08-25T00:00:00Z",
    updatedAt: "2026-08-30T00:00:00Z",
  };
  const belowSession: Session = {
    id: "below-agent-session",
    name: "Below agent",
    state: "running",
    cwd: belowProject.path,
    projectId: belowProject.id,
    createdAt: "2026-08-24T00:00:00Z",
    updatedAt: "2026-08-29T00:00:00Z",
  };
  const unassignedSession: Session = {
    id: "unassigned-agent-session",
    name: "Unassigned agent",
    state: "running",
    cwd: "/workspace/unassigned-agent",
    createdAt: "2026-08-23T00:00:00Z",
    updatedAt: "2026-08-28T00:00:00Z",
  };
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([belowSession, removedAgent, unassignedSession]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([belowProject, removedProject]);
    }
    if (input === "/api/agent-summaries" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/sessions/removed-agent/archive" && init?.method === "POST") {
      return jsonResponse({
        id: "removed-agent",
        selection: {
          terminalIds: [],
          manualTerminalIds: [],
          pinnedTerminalIds: [],
          filters: { statuses: [], cwds: [] },
          revision: 1,
        },
      });
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
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  const removed = await screen.findByRole("button", { name: "Select Codex" });
  fireEvent.contextMenu(removed);
  const menu = screen.getByRole("menu", { name: "Actions for Codex" });
  await user.click(within(menu).getByRole("menuitem", { name: "Archive" }));

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Select Unassigned agent" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });
  expect(screen.getByRole("button", { name: "Select Below agent" })).not.toHaveAttribute(
    "aria-current",
    "true",
  );
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/sessions/removed-agent/archive",
    expect.objectContaining({ method: "POST" }),
  );
});

test("preserves a newer local selection after a delayed delete", async () => {
  history.replaceState(null, "", "/?terminal=local-race-removed");
  const removedProject: Project = {
    id: "project-local-race-removed",
    path: "/workspace/local-race-removed",
    createdAt: "2026-08-20T00:00:00Z",
  };
  const belowProject: Project = {
    id: "project-local-race-below",
    path: "/workspace/local-race-below",
    createdAt: "2026-08-19T00:00:00Z",
  };
  const removedSession: Session = {
    ...plainTerminalSession,
    id: "local-race-removed",
    name: "Local race removed",
    cwd: removedProject.path,
    projectId: removedProject.id,
    createdAt: "2026-08-25T00:00:00Z",
    updatedAt: "2026-08-30T00:00:00Z",
  };
  const belowSession: Session = {
    ...plainTerminalSession,
    id: "local-race-below",
    name: "Local race below",
    cwd: belowProject.path,
    projectId: belowProject.id,
    createdAt: "2026-08-24T00:00:00Z",
    updatedAt: "2026-08-29T00:00:00Z",
  };
  const otherSession: Session = {
    ...plainTerminalSession,
    id: "local-race-other",
    name: "Local race other",
    cwd: "/workspace/local-race-other",
    createdAt: "2026-08-23T00:00:00Z",
    updatedAt: "2026-08-28T00:00:00Z",
  };
  let deleteStarted = false;
  let releaseDelete: (() => void) | undefined;
  const deleteResponse = new Promise<Response>((resolve) => {
    releaseDelete = () => resolve(new Response(null, { status: 204 }));
  });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([belowSession, removedSession, otherSession]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([belowProject, removedProject]);
    }
    if (input === "/api/agent-summaries" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/sessions/local-race-removed" && init?.method === "DELETE") {
      deleteStarted = true;
      return deleteResponse;
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
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  const removed = await screen.findByRole("button", { name: "Select Local race removed" });
  fireEvent.contextMenu(removed);
  const menu = screen.getByRole("menu", { name: "Actions for Local race removed" });
  await user.click(within(menu).getByRole("menuitem", { name: "Delete" }));
  await user.click(screen.getByRole("button", { name: "Delete terminal" }));
  await waitFor(() => expect(deleteStarted).toBe(true));

  await user.click(screen.getByRole("button", { name: "Select Local race other" }));
  expect(screen.getByRole("button", { name: "Select Local race other" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  releaseDelete?.();

  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Select Local race removed" })).not.toBeInTheDocument();
  });
  expect(screen.getByRole("button", { name: "Select Local race other" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  expect(screen.getByRole("button", { name: "Select Local race below" })).not.toHaveAttribute(
    "aria-current",
    "true",
  );
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/sessions/local-race-removed",
    expect.objectContaining({ method: "DELETE" }),
  );
});

test("preserves a newer local selection after a delayed archive", async () => {
  history.replaceState(null, "", "/?terminal=local-archive-race-removed");
  const removedProject: Project = {
    id: "project-local-archive-race-removed",
    path: "/workspace/local-archive-race-removed",
    createdAt: "2026-08-20T00:00:00Z",
  };
  const belowProject: Project = {
    id: "project-local-archive-race-below",
    path: "/workspace/local-archive-race-below",
    createdAt: "2026-08-19T00:00:00Z",
  };
  const removedSession: Session = {
    ...plainTerminalSession,
    id: "local-archive-race-removed",
    name: "Local archive race removed",
    cwd: removedProject.path,
    projectId: removedProject.id,
    agent: "codex",
    agentStatus: "waiting",
    createdAt: "2026-08-25T00:00:00Z",
    updatedAt: "2026-08-30T00:00:00Z",
  };
  const belowSession: Session = {
    ...plainTerminalSession,
    id: "local-archive-race-below",
    name: "Local archive race below",
    cwd: belowProject.path,
    projectId: belowProject.id,
    createdAt: "2026-08-24T00:00:00Z",
    updatedAt: "2026-08-29T00:00:00Z",
  };
  const otherSession: Session = {
    ...plainTerminalSession,
    id: "local-archive-race-other",
    name: "Local archive race other",
    cwd: "/workspace/local-archive-race-other",
    createdAt: "2026-08-23T00:00:00Z",
    updatedAt: "2026-08-28T00:00:00Z",
  };
  let archiveStarted = false;
  let releaseArchive: (() => void) | undefined;
  const archiveResponse = new Promise<Response>((resolve) => {
    releaseArchive = () => resolve(new Response(JSON.stringify({
      id: removedSession.id,
      selection: {
        terminalIds: [],
        manualTerminalIds: [],
        pinnedTerminalIds: [],
        filters: { statuses: [], cwds: [] },
        revision: 1,
      },
    }), {
      headers: { "Content-Type": "application/json" },
    }));
  });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([belowSession, removedSession, otherSession]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([belowProject, removedProject]);
    }
    if (input === "/api/agent-summaries" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/sessions/local-archive-race-removed/archive" && init?.method === "POST") {
      archiveStarted = true;
      return archiveResponse;
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
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  const removed = await screen.findByRole("button", { name: "Select Codex" });
  fireEvent.contextMenu(removed);
  const menu = screen.getByRole("menu", { name: "Actions for Codex" });
  await user.click(within(menu).getByRole("menuitem", { name: "Archive" }));
  await waitFor(() => expect(archiveStarted).toBe(true));

  await user.click(screen.getByRole("button", { name: "Select Local archive race other" }));
  expect(screen.getByRole("button", { name: "Select Local archive race other" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  releaseArchive?.();

  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Select Codex" })).not.toBeInTheDocument();
  });
  expect(screen.getByRole("button", { name: "Select Local archive race other" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  expect(screen.getByRole("button", { name: "Select Local archive race below" })).not.toHaveAttribute(
    "aria-current",
    "true",
  );
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/sessions/local-archive-race-removed/archive",
    expect.objectContaining({ method: "POST" }),
  );
});

test("corrects shared deletion to the next rendered sidebar session", async () => {
  history.replaceState(null, "", "/?terminal=removed-shared");
  const removedProject: Project = {
    id: "project-removed-shared",
    path: "/workspace/removed-shared",
    createdAt: "2026-08-19T00:00:00Z",
  };
  const belowProject: Project = {
    id: "project-below-shared",
    path: "/workspace/below-shared",
    createdAt: "2026-08-20T00:00:00Z",
  };
  const removedSession: Session = {
    ...plainTerminalSession,
    id: "removed-shared",
    name: "Removed shared",
    cwd: removedProject.path,
    projectId: removedProject.id,
    createdAt: "2026-08-25T00:00:00Z",
    updatedAt: "2026-08-30T00:00:00Z",
  };
  const belowSession: Session = {
    ...plainTerminalSession,
    id: "below-shared",
    name: "Below shared",
    cwd: belowProject.path,
    projectId: belowProject.id,
    createdAt: "2026-08-24T00:00:00Z",
    updatedAt: "2026-08-29T00:00:00Z",
  };
  const unassignedSession: Session = {
    ...plainTerminalSession,
    id: "unassigned-shared",
    name: "Unassigned shared",
    cwd: "/workspace/unassigned-shared",
    createdAt: "2026-08-26T00:00:00Z",
    updatedAt: "2026-08-28T00:00:00Z",
  };
  const initialSelection: SelectionSnapshot = {
    terminalIds: [removedSession.id],
    manualTerminalIds: [removedSession.id],
    pinnedTerminalIds: [],
    focusedTerminalId: removedSession.id,
    filters: { statuses: [], cwds: [] },
    pinnedFilters: { statuses: [], cwds: [] },
    revision: 5,
  };
  const serverSelection: SelectionSnapshot = {
    ...initialSelection,
    terminalIds: [unassignedSession.id],
    manualTerminalIds: [unassignedSession.id],
    focusedTerminalId: unassignedSession.id,
    revision: 6,
  };
  const correctedSelection: SelectionSnapshot = {
    ...serverSelection,
    terminalIds: [belowSession.id],
    manualTerminalIds: [belowSession.id],
    focusedTerminalId: belowSession.id,
    revision: 7,
  };
  let deletionCompleted = false;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([belowSession, removedSession, unassignedSession]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([removedProject, belowProject]);
    }
    if (input === "/api/selection" && (!init || init.method === undefined)) {
      return jsonResponse(deletionCompleted ? serverSelection : initialSelection);
    }
    if (input === "/api/selection" && init?.method === "PUT") {
      expect(JSON.parse(String(init.body))).toEqual({
        manualTerminalIds: [belowSession.id],
        pinnedTerminalIds: [],
        focusedTerminalId: belowSession.id,
        filters: { statuses: [], cwds: [] },
        pinnedFilters: { statuses: [], cwds: [] },
        expectedRevision: serverSelection.revision,
      });
      return jsonResponse(correctedSelection);
    }
    if (input === "/api/terminals/removed-shared" && init?.method === "DELETE") {
      deletionCompleted = true;
      return jsonResponse({ id: removedSession.id, selection: serverSelection });
    }
    if (input === "/api/agent-summaries" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncEvents={false}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  const removed = await screen.findByRole("button", { name: "Select Removed shared" });
  fireEvent.contextMenu(removed);
  const menu = screen.getByRole("menu", { name: "Actions for Removed shared" });
  await user.click(within(menu).getByRole("menuitem", { name: "Delete" }));
  await user.click(screen.getByRole("button", { name: "Delete terminal" }));

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Select Below shared" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });
  expect(screen.getByRole("button", { name: "Select Unassigned shared" })).not.toHaveAttribute(
    "aria-current",
    "true",
  );
  expect(fetchMock.mock.calls.filter(([input, init]) =>
    input === "/api/selection" && init?.method === "PUT",
  )).toHaveLength(1);
});

test("does not overwrite a remote selection that races a shared close response", async () => {
  history.replaceState(null, "", "/?terminal=remote-race-removed");
  const removedProject: Project = {
    id: "project-remote-race-removed",
    path: "/workspace/remote-race-removed",
    createdAt: "2026-08-20T00:00:00Z",
  };
  const belowProject: Project = {
    id: "project-remote-race-below",
    path: "/workspace/remote-race-below",
    createdAt: "2026-08-19T00:00:00Z",
  };
  const removedSession: Session = {
    ...plainTerminalSession,
    id: "remote-race-removed",
    name: "Remote race removed",
    cwd: removedProject.path,
    projectId: removedProject.id,
    createdAt: "2026-08-25T00:00:00Z",
    updatedAt: "2026-08-30T00:00:00Z",
  };
  const belowSession: Session = {
    ...plainTerminalSession,
    id: "remote-race-below",
    name: "Remote race below",
    cwd: belowProject.path,
    projectId: belowProject.id,
    createdAt: "2026-08-24T00:00:00Z",
    updatedAt: "2026-08-29T00:00:00Z",
  };
  const unassignedSession: Session = {
    ...plainTerminalSession,
    id: "remote-race-unassigned",
    name: "Remote race unassigned",
    cwd: "/workspace/remote-race-unassigned",
    createdAt: "2026-08-26T00:00:00Z",
    updatedAt: "2026-08-28T00:00:00Z",
  };
  const remoteSession: Session = {
    ...plainTerminalSession,
    id: "remote-race-selected",
    name: "Remote race selected",
    cwd: "/workspace/remote-race-selected",
    createdAt: "2026-08-23T00:00:00Z",
    updatedAt: "2026-08-27T00:00:00Z",
  };
  const initialSelection: SelectionSnapshot = {
    terminalIds: [removedSession.id],
    manualTerminalIds: [removedSession.id],
    pinnedTerminalIds: [],
    focusedTerminalId: removedSession.id,
    filters: { statuses: [], cwds: [] },
    pinnedFilters: { statuses: [], cwds: [] },
    revision: 5,
  };
  const remoteSelection: SelectionSnapshot = {
    ...initialSelection,
    terminalIds: [remoteSession.id],
    manualTerminalIds: [remoteSession.id],
    focusedTerminalId: remoteSession.id,
    revision: 6,
  };
  const staleCloseSelection: SelectionSnapshot = {
    ...initialSelection,
    terminalIds: [unassignedSession.id],
    manualTerminalIds: [unassignedSession.id],
    focusedTerminalId: unassignedSession.id,
    revision: 6,
  };
  const correctedSelection: SelectionSnapshot = {
    ...staleCloseSelection,
    terminalIds: [belowSession.id],
    manualTerminalIds: [belowSession.id],
    focusedTerminalId: belowSession.id,
    revision: 7,
  };
  const encoder = new TextEncoder();
  let eventController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let remoteEmitted = false;
  let deleteStarted = false;
  let releaseDelete: (() => void) | undefined;
  let correctionWrites = 0;
  const deleteResponse = new Promise<Response>((resolve) => {
    releaseDelete = () => resolve(
      new Response(
        JSON.stringify({ id: removedSession.id, selection: staleCloseSelection }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
  });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([
        belowSession,
        removedSession,
        unassignedSession,
        remoteSession,
      ]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([belowProject, removedProject]);
    }
    if (input === "/api/selection" && (!init || init.method === undefined)) {
      return jsonResponse(remoteEmitted ? remoteSelection : initialSelection);
    }
    if (input === "/api/events") {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          eventController = controller;
        },
      }), {
        headers: { "Content-Type": "application/x-ndjson" },
      });
    }
    if (input === "/api/selection" && init?.method === "PUT") {
      correctionWrites += 1;
      return jsonResponse(correctedSelection);
    }
    if (input === "/api/terminals/remote-race-removed" && init?.method === "DELETE") {
      deleteStarted = true;
      return deleteResponse;
    }
    if (input === "/api/agent-summaries" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  const removed = await screen.findByRole("button", { name: "Select Remote race removed" });
  await waitFor(() => expect(eventController).toBeDefined());
  fireEvent.contextMenu(removed);
  const menu = screen.getByRole("menu", { name: "Actions for Remote race removed" });
  await user.click(within(menu).getByRole("menuitem", { name: "Delete" }));
  await user.click(screen.getByRole("button", { name: "Delete terminal" }));
  await waitFor(() => expect(deleteStarted).toBe(true));

  remoteEmitted = true;
  eventController?.enqueue(encoder.encode(JSON.stringify({
    sequence: 9,
    occurredAt: "2026-08-30T00:00:00Z",
    type: "selection.changed",
    data: remoteSelection,
  }) + "\n"));
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Select Remote race selected" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  releaseDelete?.();
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Select Remote race selected" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });
  expect(correctionWrites).toBe(0);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/terminals/remote-race-removed",
    expect.objectContaining({ method: "DELETE" }),
  );
  eventController?.close();
});

test("skips correction when the close response is no longer the current selection", async () => {
  history.replaceState(null, "", "/?terminal=stale-close-response");
  const removedSession: Session = {
    ...plainTerminalSession,
    id: "stale-close-removed",
    name: "Stale close removed",
    cwd: "/workspace/stale-close-removed",
    createdAt: "2026-08-25T00:00:00Z",
    updatedAt: "2026-08-30T00:00:00Z",
  };
  const belowSession: Session = {
    ...plainTerminalSession,
    id: "stale-close-below",
    name: "Stale close below",
    cwd: "/workspace/stale-close-below",
    createdAt: "2026-08-24T00:00:00Z",
    updatedAt: "2026-08-29T00:00:00Z",
  };
  const unassignedSession: Session = {
    ...plainTerminalSession,
    id: "stale-close-unassigned",
    name: "Stale close unassigned",
    cwd: "/workspace/stale-close-unassigned",
    createdAt: "2026-08-26T00:00:00Z",
    updatedAt: "2026-08-28T00:00:00Z",
  };
  const remoteSession: Session = {
    ...plainTerminalSession,
    id: "stale-close-remote",
    name: "Stale close remote",
    cwd: "/workspace/stale-close-remote",
    createdAt: "2026-08-23T00:00:00Z",
    updatedAt: "2026-08-27T00:00:00Z",
  };
  const initialSelection: SelectionSnapshot = {
    terminalIds: [removedSession.id],
    manualTerminalIds: [removedSession.id],
    pinnedTerminalIds: [],
    focusedTerminalId: removedSession.id,
    filters: { statuses: [], cwds: [] },
    pinnedFilters: { statuses: [], cwds: [] },
    revision: 5,
  };
  const remoteSelection: SelectionSnapshot = {
    ...initialSelection,
    terminalIds: [remoteSession.id],
    manualTerminalIds: [remoteSession.id],
    focusedTerminalId: remoteSession.id,
    revision: 6,
  };
  const staleCloseSelection: SelectionSnapshot = {
    ...initialSelection,
    terminalIds: [unassignedSession.id],
    manualTerminalIds: [unassignedSession.id],
    focusedTerminalId: unassignedSession.id,
    revision: 6,
  };
  const correctedSelection: SelectionSnapshot = {
    ...staleCloseSelection,
    terminalIds: [belowSession.id],
    manualTerminalIds: [belowSession.id],
    focusedTerminalId: belowSession.id,
    revision: 7,
  };
  let closeResponseReturned = false;
  let correctionWrites = 0;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([
        belowSession,
        removedSession,
        unassignedSession,
        remoteSession,
      ]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/selection" && (!init || init.method === undefined)) {
      return jsonResponse(closeResponseReturned ? remoteSelection : initialSelection);
    }
    if (input === "/api/terminals/stale-close-removed" && init?.method === "DELETE") {
      closeResponseReturned = true;
      return jsonResponse({ id: removedSession.id, selection: staleCloseSelection });
    }
    if (input === "/api/selection" && init?.method === "PUT") {
      correctionWrites += 1;
      return jsonResponse(correctedSelection);
    }
    if (input === "/api/agent-summaries" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncEvents={false}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  const removed = await screen.findByRole("button", { name: "Select Stale close removed" });
  fireEvent.contextMenu(removed);
  const menu = screen.getByRole("menu", { name: "Actions for Stale close removed" });
  await user.click(within(menu).getByRole("menuitem", { name: "Delete" }));
  await user.click(screen.getByRole("button", { name: "Delete terminal" }));

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Select Stale close remote" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });
  expect(correctionWrites).toBe(0);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/terminals/stale-close-removed",
    expect.objectContaining({ method: "DELETE" }),
  );
});

test("preserves a shared archive correction error", async () => {
  history.replaceState(null, "", "/?terminal=shared-archive-removed");
  const removedProject: Project = {
    id: "project-shared-archive-removed",
    path: "/workspace/shared-archive-removed",
    createdAt: "2026-08-19T00:00:00Z",
  };
  const belowProject: Project = {
    id: "project-shared-archive-below",
    path: "/workspace/shared-archive-below",
    createdAt: "2026-08-20T00:00:00Z",
  };
  const removedSession: Session = {
    ...plainTerminalSession,
    id: "shared-archive-removed",
    name: "Shared archive removed",
    cwd: removedProject.path,
    projectId: removedProject.id,
    agent: "codex",
    agentStatus: "waiting",
    createdAt: "2026-08-25T00:00:00Z",
    updatedAt: "2026-08-30T00:00:00Z",
  };
  const belowSession: Session = {
    ...plainTerminalSession,
    id: "shared-archive-below",
    name: "Shared archive below",
    cwd: belowProject.path,
    projectId: belowProject.id,
    createdAt: "2026-08-24T00:00:00Z",
    updatedAt: "2026-08-29T00:00:00Z",
  };
  const unassignedSession: Session = {
    ...plainTerminalSession,
    id: "shared-archive-unassigned",
    name: "Shared archive unassigned",
    cwd: "/workspace/shared-archive-unassigned",
    createdAt: "2026-08-26T00:00:00Z",
    updatedAt: "2026-08-28T00:00:00Z",
  };
  const initialSelection: SelectionSnapshot = {
    terminalIds: [removedSession.id],
    manualTerminalIds: [removedSession.id],
    pinnedTerminalIds: [],
    focusedTerminalId: removedSession.id,
    filters: { statuses: [], cwds: [] },
    pinnedFilters: { statuses: [], cwds: [] },
    revision: 5,
  };
  const serverSelection: SelectionSnapshot = {
    ...initialSelection,
    terminalIds: [unassignedSession.id],
    manualTerminalIds: [unassignedSession.id],
    focusedTerminalId: unassignedSession.id,
    revision: 6,
  };
  let archiveCompleted = false;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([belowSession, removedSession, unassignedSession]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([removedProject, belowProject]);
    }
    if (input === "/api/selection" && (!init || init.method === undefined)) {
      return jsonResponse(archiveCompleted ? serverSelection : initialSelection);
    }
    if (input === "/api/sessions/shared-archive-removed/archive" && init?.method === "POST") {
      archiveCompleted = true;
      return jsonResponse({ id: removedSession.id, selection: serverSelection });
    }
    if (input === "/api/selection" && init?.method === "PUT") {
      expect(JSON.parse(String(init.body))).toEqual({
        manualTerminalIds: [belowSession.id],
        pinnedTerminalIds: [],
        focusedTerminalId: belowSession.id,
        filters: { statuses: [], cwds: [] },
        pinnedFilters: { statuses: [], cwds: [] },
        expectedRevision: serverSelection.revision,
      });
      throw new Error("shared archive correction failed");
    }
    if (input === "/api/agent-summaries" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncEvents={false}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  const removed = await screen.findByRole("button", { name: "Select Codex" });
  fireEvent.contextMenu(removed);
  const menu = screen.getByRole("menu", { name: "Actions for Codex" });
  await user.click(within(menu).getByRole("menuitem", { name: "Archive" }));

  await waitFor(() => {
    expect(screen.getByRole("alert")).toHaveTextContent("shared archive correction failed");
  });
  expect(screen.queryByRole("button", { name: "Select Codex" })).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/sessions/shared-archive-removed/archive",
    expect.objectContaining({ method: "POST" }),
  );
});

test("does not replace the remaining shared multi-selection after a close", async () => {
  history.replaceState(null, "", "/?terminal=multi-selection-removed");
  const removedSession: Session = {
    ...plainTerminalSession,
    id: "multi-selection-removed",
    name: "Multi-selection removed",
    cwd: "/workspace/multi-selection-removed",
    createdAt: "2026-08-25T00:00:00Z",
    updatedAt: "2026-08-30T00:00:00Z",
  };
  const keptSession: Session = {
    ...plainTerminalSession,
    id: "multi-selection-kept",
    name: "Multi-selection kept",
    cwd: "/workspace/multi-selection-kept",
    createdAt: "2026-08-24T00:00:00Z",
    updatedAt: "2026-08-29T00:00:00Z",
  };
  const initialSelection: SelectionSnapshot = {
    terminalIds: [removedSession.id, keptSession.id],
    manualTerminalIds: [removedSession.id, keptSession.id],
    pinnedTerminalIds: [],
    focusedTerminalId: removedSession.id,
    filters: { statuses: [], cwds: [] },
    pinnedFilters: { statuses: [], cwds: [] },
    revision: 5,
  };
  const remainingSelection: SelectionSnapshot = {
    ...initialSelection,
    terminalIds: [keptSession.id],
    manualTerminalIds: [keptSession.id],
    focusedTerminalId: keptSession.id,
    revision: 6,
  };
  let correctionWrites = 0;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([removedSession, keptSession]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/selection" && (!init || init.method === undefined)) {
      return jsonResponse(initialSelection);
    }
    if (input === "/api/terminals/multi-selection-removed" && init?.method === "DELETE") {
      return jsonResponse({ id: removedSession.id, selection: remainingSelection });
    }
    if (input === "/api/selection" && init?.method === "PUT") {
      correctionWrites += 1;
      return jsonResponse(remainingSelection);
    }
    if (input === "/api/agent-summaries" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncEvents={false}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  const removed = await screen.findByRole("button", { name: "Select Multi-selection removed" });
  fireEvent.contextMenu(removed);
  const menu = screen.getByRole("menu", { name: "Actions for Multi-selection removed" });
  await user.click(within(menu).getByRole("menuitem", { name: "Delete" }));
  await user.click(screen.getByRole("button", { name: "Delete terminal" }));

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Select Multi-selection kept" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });
  expect(correctionWrites).toBe(0);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/terminals/multi-selection-removed",
    expect.objectContaining({ method: "DELETE" }),
  );
});

test("uses the legacy sidebar order when the project endpoint is unavailable", async () => {
  history.replaceState(null, "", "/?terminal=legacy-removed");
  const removedSession: Session = {
    ...plainTerminalSession,
    id: "legacy-removed",
    name: "Legacy removed",
    cwd: "/workspace/legacy",
    agentStatus: "waiting",
    updatedAt: "2026-08-27T00:00:00Z",
  };
  const belowSession: Session = {
    ...plainTerminalSession,
    id: "legacy-below",
    name: "Legacy below",
    cwd: "/workspace/legacy",
    updatedAt: "2026-08-26T00:00:00Z",
  };
  const otherSession: Session = {
    ...plainTerminalSession,
    id: "legacy-other",
    name: "Legacy other",
    cwd: "/workspace/legacy",
    state: "exited",
    updatedAt: "2026-08-25T00:00:00Z",
  };
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([removedSession, otherSession, belowSession]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return legacyProjectsResponse();
    }
    if (input === "/api/agent-summaries" && (!init || init.method === undefined)) {
      return jsonResponse([]);
    }
    if (input === "/api/sessions/legacy-removed" && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
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
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  const removed = await screen.findByRole("button", { name: "Select Legacy removed" });
  fireEvent.contextMenu(removed);
  const menu = screen.getByRole("menu", { name: "Actions for Legacy removed" });
  await user.click(within(menu).getByRole("menuitem", { name: "Delete" }));
  await user.click(screen.getByRole("button", { name: "Delete terminal" }));

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Select Legacy other" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });
  expect(screen.getByRole("button", { name: "Select Legacy below" })).not.toHaveAttribute(
    "aria-current",
    "true",
  );
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/sessions/legacy-removed",
    expect.objectContaining({ method: "DELETE" }),
  );
});

test("falls back to home when the focused terminal cwd cannot be inherited", async () => {
  const created = { ...plainTerminalSession, id: "created-home", cwd: "/home/me" };
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([runningSession]))
    .mockImplementationOnce(legacyProjectsResponse)
    .mockImplementationOnce(() => jsonResponse([]))
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
    4,
    "/api/sessions",
    expect.objectContaining({
      body: JSON.stringify({
        name: "Terminal",
        cwd: "/workspace/euphony",
      }),
    }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    5,
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
    .mockImplementationOnce(legacyProjectsResponse)
    .mockImplementationOnce(() => jsonResponse([]))
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
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(fetchMock).toHaveBeenNthCalledWith(
    4,
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
    .mockImplementationOnce(legacyProjectsResponse)
    .mockImplementationOnce(() => jsonResponse([]))
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
    4,
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

test("renames the focused selected terminal from Quick Actions and updates the sidebar", async () => {
  history.replaceState(
    null,
    "",
    "/?terminal=session-1&terminal=session-2&focus=session-2",
  );
  const renamed = {
    ...secondRunningSession,
    name: "Renamed Claude",
    customName: true,
  };
  let serverSessions: Session[] = [runningSession, secondRunningSession];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions") {
      return jsonResponse(serverSessions);
    }
    if (input === "/api/agent-summaries") return jsonResponse([]);
    if (input === "/api/settings") return jsonResponse(defaultSettings);
    if (input === "/api/terminals/session-2" && init?.method === "PATCH") {
      expect(JSON.parse(String(init.body))).toEqual({ name: "Renamed Claude" });
      serverSessions = [runningSession, renamed];
      return jsonResponse({ terminal: renamed });
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
      renderTerminal={(session) => (
        <div aria-label={`${session.name} terminal pane`} />
      )}
    />,
  );

  await screen.findByLabelText("Claude terminal pane");
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  await user.click(await screen.findByRole("option", { name: /^Rename terminal…/ }));

  const dialog = await screen.findByRole("dialog", { name: "Rename terminal" });
  const input = within(dialog).getByRole("textbox", { name: "Terminal name" });
  expect(input).toHaveValue("Claude");
  expect(input).toHaveFocus();
  await user.clear(input);
  await user.type(input, "  Renamed Claude  ");
  await user.click(within(dialog).getByRole("button", { name: "Rename terminal" }));

  await waitFor(() => {
    expect(screen.getByText("Renamed Claude")).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Rename terminal" })).not.toBeInTheDocument();
  });
  expect(document.querySelector(".desktop-sidebar")).not.toHaveTextContent("Needs approval");
  expect(JSON.parse(localStorage.getItem("euphony.recentQuickActions:v1") ?? "[]"))
    .toContain("rename-terminal");
  expect(fetchMock.mock.calls.filter(
    ([input, init]) => input === "/api/terminals/session-2" && init?.method === "PATCH",
  )).toHaveLength(1);
  expect(fetchMock.mock.calls.some(
    ([input, init]) => input === "/api/terminals/session-1" && init?.method === "PATCH",
  )).toBe(false);
});

test("keeps the rename dialog open with useful validation errors", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (input === "/api/sessions") return jsonResponse([runningSession]);
    if (input === "/api/agent-summaries") return jsonResponse([]);
    if (input === "/api/settings") return jsonResponse(defaultSettings);
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();
  render(
    <App
      syncSelection={false}
      syncEvents={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div>{session.id}</div>}
    />,
  );

  await screen.findByRole("button", { name: "Select Codex" });
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  await user.click(await screen.findByRole("option", { name: /^Rename terminal…/ }));
  const dialog = await screen.findByRole("dialog", { name: "Rename terminal" });
  const input = within(dialog).getByRole("textbox", { name: "Terminal name" });

  fireEvent.change(input, { target: { value: "" } });
  expect(input).toHaveValue("");
  await user.click(within(dialog).getByRole("button", { name: "Rename terminal" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Enter a terminal name.",
  );
  expect(screen.getByRole("dialog", { name: "Rename terminal" })).toBeVisible();

  fireEvent.change(input, { target: { value: "x".repeat(81) } });
  expect(input).toHaveValue("x".repeat(81));
  await user.click(within(dialog).getByRole("button", { name: "Rename terminal" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Terminal name must be 80 characters or fewer.",
  );
  expect(fetchMock.mock.calls.some(
    ([input, init]) => typeof input === "string" && input.includes("/api/terminals/") && init?.method === "PATCH",
  )).toBe(false);
});

test("keeps the rename dialog open when the API rejects the new name", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions") return jsonResponse([runningSession]);
    if (input === "/api/agent-summaries") return jsonResponse([]);
    if (input === "/api/settings") return jsonResponse(defaultSettings);
    if (input === "/api/terminals/session-1" && init?.method === "PATCH") {
      return jsonResponse(
        {
          code: "rename_failed",
          message: "That terminal name is unavailable.",
        },
        409,
      );
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
      renderTerminal={(session) => <div>{session.id}</div>}
    />,
  );

  await screen.findByRole("button", { name: "Select Codex" });
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  await user.click(await screen.findByRole("option", { name: /^Rename terminal…/ }));
  const dialog = await screen.findByRole("dialog", { name: "Rename terminal" });
  const input = within(dialog).getByRole("textbox", { name: "Terminal name" });
  await user.clear(input);
  await user.type(input, "Unavailable");
  await user.click(within(dialog).getByRole("button", { name: "Rename terminal" }));

  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "That terminal name is unavailable.",
  );
  expect(screen.getByRole("dialog", { name: "Rename terminal" })).toBeVisible();
  expect(fetchMock.mock.calls.filter(
    ([input, init]) => input === "/api/terminals/session-1" && init?.method === "PATCH",
  )).toHaveLength(1);
});

test("deletes selected terminals from Quick Actions after confirmation", async () => {
  history.replaceState(null, "", "/?terminal=session-1&terminal=session-2");
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() =>
      jsonResponse([runningSession, secondRunningSession]),
    )
    .mockImplementationOnce(() => jsonResponse([]))
    .mockImplementationOnce(() => jsonResponse([]))
    .mockImplementationOnce(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    )
    .mockImplementationOnce(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
  const user = userEvent.setup();
  render(
    <App
      syncSelection={false}
      syncEvents={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => (
        <div aria-label={`${session.name} terminal pane`} />
      )}
    />,
  );

  await screen.findByLabelText("Codex terminal pane");
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  await user.click(
    await screen.findByRole("option", {
      name: /^Delete selected terminals/,
    }),
  );

  expect(
    screen.getByRole("dialog", { name: "Delete selected terminals?" }),
  ).toBeVisible();
  expect(
    screen.getByText(/2 selected terminals will be stopped/),
  ).toBeVisible();
  expect(fetchMock).toHaveBeenCalledTimes(3);

  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.queryByRole("dialog", { name: "Delete selected terminals?" }),
  ).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(3);

  fireEvent.keyDown(window, { key: "k", metaKey: true });
  await user.click(
    await screen.findByRole("option", {
      name: /^Delete selected terminals/,
    }),
  );
  await user.click(screen.getByRole("button", { name: "Delete terminals" }));

  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Select Codex" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Select Claude" })).not.toBeInTheDocument();
  });
  expect(fetchMock).toHaveBeenNthCalledWith(
    4,
    "/api/sessions/session-1",
    expect.objectContaining({ method: "DELETE" }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    5,
    "/api/sessions/session-2",
    expect.objectContaining({ method: "DELETE" }),
  );

  fireEvent.keyDown(window, { key: "k", metaKey: true });
  expect(
    screen.queryByRole("option", { name: /^Delete selected terminals/ }),
  ).not.toBeInTheDocument();
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
  expect(JSON.parse(localStorage.getItem("euphony.recentQuickActions:v1") ?? "null")).toEqual([
    "session:session-3",
    "session:session-2",
    "session:session-1",
    "status:waiting",
    "status:running",
  ]);
});

test("discards unavailable recent Quick Actions and searches the full catalog", async () => {
  localStorage.setItem(
    "euphony.recentQuickActions:v1",
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
  expect(JSON.parse(localStorage.getItem("euphony.recentQuickActions:v1") ?? "null")).toEqual([
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

test("reconnects disconnected panes automatically", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession]),
  );
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
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
      <button onClick={() => onConnectionChange?.(session.id, "disconnected")}>
        Disconnect {session.name}
      </button>
      <span aria-label={`${session.name} reconnect signal`}>
        {reconnectSignal}
      </span>
    </div>
  )) as unknown as ComponentProps<typeof App>["renderTerminal"];

  try {
    render(
      <App syncSelection={false}
        initialToken="valid-token"
        initialSettings={defaultSettings}
        renderTerminal={renderTerminal}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Disconnect Codex" }));
    expect(screen.getByLabelText("Codex reconnect signal")).toHaveTextContent("0");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(screen.getByLabelText("Codex reconnect signal")).toHaveTextContent("1");
  } finally {
    vi.useRealTimers();
  }
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

test("opens All sessions and selects an existing terminal", async () => {
  const allSession: AllSession = {
    id: "all-open",
    terminalId: runningSession.id,
    agent: "codex",
    sessionId: "codex-open",
    title: "Implement v0.2",
    purpose: "Current terminal",
    cwd: runningSession.cwd,
    project: "Euphony",
    updatedAt: "2026-08-13T00:00:00Z",
    state: "open",
  };
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([runningSession]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return legacyProjectsResponse();
    }
    if (input === "/api/all-sessions" && (!init || init.method === undefined)) {
      return jsonResponse([allSession]);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncSelection={false}
      syncEvents={false}
      renderTerminal={(session) => (
        <div aria-label={`${session.name} terminal pane`} />
      )}
    />,
  );

  await user.click(await screen.findByRole("button", { name: "All sessions" }));
  expect(await screen.findByRole("dialog", { name: "All sessions" })).toBeVisible();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/all-sessions",
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer valid-token" }),
    }),
  );

  await user.click(screen.getByRole("button", { name: /Open terminal/ }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "All sessions" })).not.toBeInTheDocument();
  });
  expect(screen.getByRole("button", { name: "Select Codex" })).toHaveAttribute(
    "aria-current",
    "true",
  );
});

test("resumes a history session once, applies returned selection, and closes the dialog", async () => {
  const historySession: AllSession = {
    id: "history-only",
    agent: "codex",
    sessionId: "history/codex",
    title: "Resume the release work",
    summary: "Continue from the previous run",
    cwd: "/workspace/release",
    updatedAt: "2026-08-13T01:00:00Z",
    state: "resume",
  };
  const resumedTerminal: Session = {
    ...runningSession,
    id: "resumed-terminal",
    name: "Resumed Codex",
    cwd: historySession.cwd,
    agentTitle: historySession.title,
  };
  const selection: SelectionSnapshot = {
    terminalIds: [resumedTerminal.id],
    manualTerminalIds: [resumedTerminal.id],
    pinnedTerminalIds: [],
    focusedTerminalId: resumedTerminal.id,
    filters: { statuses: [], cwds: [] },
    revision: 9,
  };
  let releaseResume!: (response: Response) => void;
  const resumeResponse = new Promise<Response>((resolve) => {
    releaseResume = resolve;
  });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([runningSession]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return legacyProjectsResponse();
    }
    if (input === "/api/all-sessions" && (!init || init.method === undefined)) {
      return jsonResponse([historySession]);
    }
    if (input === "/api/all-sessions/codex/history%2Fcodex/resume") {
      return resumeResponse;
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncSelection={false}
      syncEvents={false}
      renderTerminal={(session) => (
        <div aria-label={`${session.name} terminal pane`} />
      )}
    />,
  );

  await user.click(await screen.findByRole("button", { name: "All sessions" }));
  const resumeButton = await screen.findByRole("button", { name: /Resume session/ });
  fireEvent.click(resumeButton);
  fireEvent.click(resumeButton);
  await waitFor(() => {
    expect(fetchMock.mock.calls.filter(([input]) =>
      input === "/api/all-sessions/codex/history%2Fcodex/resume",
    )).toHaveLength(1);
  });
  expect(resumeButton).toBeDisabled();

  releaseResume(await jsonResponse({ terminal: resumedTerminal, selection }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "All sessions" })).not.toBeInTheDocument();
  });
  expect(await screen.findByLabelText("Resumed Codex terminal pane")).toBeVisible();
  expect(screen.getByRole("button", { name: "Select Resumed Codex" })).toHaveAttribute(
    "aria-current",
    "true",
  );
});

test.each(["/resume"])(
  "automatically resumes an unknown URL session from %s and cleans consumed params after success",
  async (entryPath) => {
  history.replaceState(
    null,
    "",
    `${entryPath}?agent=codex&session=external-session&cwd=/workspace/external&cwd=running%00%2Fworkspace%2Ffilter&view=resume#terminal`,
  );
  const resumedTerminal: Session = {
    ...runningSession,
    id: "external-terminal",
    name: "External Codex",
    cwd: "/workspace/external",
  };
  const selection: SelectionSnapshot = {
    terminalIds: [resumedTerminal.id],
    manualTerminalIds: [resumedTerminal.id],
    pinnedTerminalIds: [],
    focusedTerminalId: resumedTerminal.id,
    filters: {
      statuses: [],
      cwds: [{ status: "running", cwd: "/workspace/filter" }],
    },
    revision: 12,
  };
  const initialSelection: SelectionSnapshot = {
    terminalIds: [runningSession.id],
    manualTerminalIds: [runningSession.id],
    pinnedTerminalIds: [],
    focusedTerminalId: runningSession.id,
    filters: { statuses: [], cwds: [] },
    revision: 11,
  };
  let releaseResume!: (response: Response) => void;
  const resumeResponse = new Promise<Response>((resolve) => {
    releaseResume = resolve;
  });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([runningSession]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return legacyProjectsResponse();
    }
    if (input === "/api/selection" && (!init || init.method === undefined)) {
      return jsonResponse(initialSelection);
    }
    if (input === "/api/agent-summaries") {
      return jsonResponse([]);
    }
    if (input === "/api/all-sessions/codex/external-session/resume?cwd=%2Fworkspace%2Fexternal") {
      return resumeResponse;
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  render(
    <StrictMode>
      <App
        initialToken="valid-token"
        initialSettings={defaultSettings}
        syncEvents={false}
        renderTerminal={(session) => (
          <div aria-label={`${session.name} terminal pane`} />
        )}
      />
    </StrictMode>,
  );

  await waitFor(() => {
    expect(fetchMock.mock.calls.filter(([input]) =>
      input === "/api/all-sessions/codex/external-session/resume?cwd=%2Fworkspace%2Fexternal",
    ).length).toBe(1);
  });
  expect(new URLSearchParams(window.location.search).get("agent")).toBe("codex");
  expect(new URLSearchParams(window.location.search).get("session")).toBe("external-session");
  expect(new URLSearchParams(window.location.search).get("cwd")).toBe("/workspace/external");

  releaseResume(await jsonResponse({ terminal: resumedTerminal, selection }));

  expect(await screen.findByLabelText("External Codex terminal pane")).toBeVisible();
  expect(screen.getByRole("button", { name: "Select External Codex" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  const parameters = new URLSearchParams(window.location.search);
  expect(parameters.get("agent")).toBeNull();
  expect(parameters.get("session")).toBeNull();
  expect(parameters.getAll("cwd")).toEqual(["running\0/workspace/filter"]);
  expect(parameters.get("view")).toBe("resume");
  expect(window.location.hash).toBe("#terminal");

  act(() => window.dispatchEvent(new PopStateEvent("popstate")));
  expect(new URLSearchParams(window.location.search).get("agent")).toBeNull();
  expect(new URLSearchParams(window.location.search).get("session")).toBeNull();
  expect(window.location.pathname).toBe("/");
  },
);

test.each([
  {
    name: "incomplete resume params",
    pathname: "/",
    query: "agent=codex&session=external-session",
  },
  {
    name: "invalid resume agent",
    pathname: "/",
    query: "agent=cursor&session=external-session&cwd=%2Fworkspace%2Fexternal",
  },
  {
    name: "workspace root",
    pathname: "/",
    query: "agent=codex&session=external-session&cwd=%2Fworkspace%2Fexternal",
  },
  {
    name: "trailing slash resume path",
    pathname: "/resume/",
    query: "agent=codex&session=external-session&cwd=%2Fworkspace%2Fexternal",
  },
])("does not resume with $name", async ({ pathname, query }) => {
  history.replaceState(null, "", `${pathname}?${query}`);
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([runningSession]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return legacyProjectsResponse();
    }
    if (input === "/api/agent-summaries") {
      return jsonResponse([]);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncSelection={false}
      syncEvents={false}
      renderTerminal={(session) => (
        <div aria-label={`${session.name} terminal pane`} />
      )}
    />,
  );

  await screen.findByLabelText("Codex terminal pane");
  expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/resume"))).toBe(false);
});

test("keeps the All sessions dialog open when resume fails", async () => {
  const historySession: AllSession = {
    id: "stale-history",
    agent: "claude",
    sessionId: "stale/claude",
    title: "Stale history",
    cwd: "/workspace/stale",
    updatedAt: "2026-08-13T02:00:00Z",
    state: "resume",
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input === "/api/sessions" && (!init || init.method === undefined)) {
      return jsonResponse([runningSession]);
    }
    if (input === "/api/projects" && (!init || init.method === undefined)) {
      return legacyProjectsResponse();
    }
    if (input === "/api/all-sessions" && (!init || init.method === undefined)) {
      return jsonResponse([historySession]);
    }
    if (input === "/api/all-sessions/claude/stale%2Fclaude/resume") {
      return jsonResponse({ code: "stale_session", message: "The history entry disappeared." }, 404);
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  const user = userEvent.setup();
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      syncSelection={false}
      syncEvents={false}
      renderTerminal={(session) => <div>{session.name}</div>}
    />,
  );

  await user.click(await screen.findByRole("button", { name: "All sessions" }));
  await user.click(await screen.findByRole("button", { name: /Resume session/ }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The history entry disappeared.",
  );
  expect(screen.getByRole("dialog", { name: "All sessions" })).toBeVisible();
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

test("does not render terminal pane deselection checkboxes", async () => {
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
  expect(screen.queryByRole("checkbox", { name: /Deselect/ })).not.toBeInTheDocument();
});

test("keeps the focused pane visible without a terminal pane checkbox", async () => {
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

  expect(screen.queryByRole("checkbox", { name: /Deselect/ })).not.toBeInTheDocument();
  expect(new URLSearchParams(window.location.search).get("focus")).toBe(
    "session-3",
  );
});

test("keeps a filter-owned pane focused without a terminal pane checkbox", async () => {
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

  expect(screen.queryByRole("checkbox", { name: /Deselect/ })).not.toBeInTheDocument();
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
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(
        ([input]) => input === "/api/agent-summaries",
      )).toHaveLength(1);
    });
    const initialRenders = renders;
    expect(initialRenders).toBeGreaterThanOrEqual(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(
      fetchMock.mock.calls.filter(([input]) => input === "/api/sessions"),
    ).toHaveLength(2);
    expect(renders).toBe(initialRenders);
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

test("keeps a running agent selected when it starts running", async () => {
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
      await vi.advanceTimersByTimeAsync(10_000);
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

test("Escape cancels prefix mode while reaching the focused terminal", async () => {
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
  expect(terminalKeyDown).toHaveBeenCalledWith(
    expect.objectContaining({ key: "Escape" }),
  );
});

test("tmux split keys are not delivered to the focused terminal", async () => {
  const created = { ...plainTerminalSession, id: "created-v" };
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([runningSession]))
    .mockImplementationOnce(legacyProjectsResponse)
    .mockImplementationOnce(() => jsonResponse([]))
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
    .mockImplementationOnce(legacyProjectsResponse)
    .mockImplementationOnce(() => jsonResponse([]))
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
    4,
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
    5,
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
  const summaryProvider = within(dialog).getByLabelText("Summary provider");
  expect(summaryProvider).toHaveValue("codex");
  const summaryPrompt = within(dialog).getByLabelText("Additional summary instructions");
  expect(summaryPrompt).toHaveValue(defaultSettings.agentSummaryPrompt);
  expect(summaryPrompt).toHaveAttribute("maxLength", "8000");
  fireEvent.change(interfaceFontSize, { target: { value: "18" } });
  fireEvent.change(terminalFontSize, { target: { value: "17" } });
  fireEvent.change(agentLogFontSize, { target: { value: "16" } });
  fireEvent.change(terminalFontFamily, {
    target: { value: '"JetBrains Mono", monospace' },
  });
  await user.selectOptions(summaryProvider, "claude");
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
  expect(within(reopenedDialog).getByLabelText("Summary provider")).toHaveValue(
    "codex",
  );
  const reopenedSummaryPrompt = within(reopenedDialog).getByLabelText(
    "Additional summary instructions",
  );
  expect(reopenedSummaryPrompt).toHaveValue(defaultSettings.agentSummaryPrompt);
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
  await user.selectOptions(within(reopenedDialog).getByLabelText("Summary provider"), "claude");
  fireEvent.change(reopenedSummaryPrompt, {
    target: { value: "Highlight risks and concrete next steps." },
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
        agentSummaryProvider: "claude",
        agentSummaryPrompt: "Highlight risks and concrete next steps.",
      }),
    }),
  );

  await user.click(screen.getByRole("button", { name: "Open settings" }));
  const savedDialog = screen.getByRole("dialog", { name: "Settings" });
  expect(within(savedDialog).getByLabelText("Additional summary instructions")).toHaveValue(
    "Highlight risks and concrete next steps.",
  );
  await user.keyboard("{Escape}");
});

test("offers OpenAI GPT-5.6 reasoning effort and persists the selected value", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (input === "/api/settings" && init?.method === "PATCH") {
      return jsonResponse(JSON.parse(String(init.body)));
    }
    if (input === "/api/settings") return jsonResponse(defaultSettings);
    return jsonResponse([runningSession]);
  });
  const user = userEvent.setup();
  render(
    <App
      syncSelection={false}
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );
  await screen.findByLabelText("session-1 terminal pane");
  await user.click(screen.getByRole("button", { name: "Open settings" }));

  const dialog = screen.getByRole("dialog", { name: "Settings" });
  const provider = within(dialog).getByLabelText("Summary provider");
  await user.selectOptions(provider, "openai");
  const effort = within(dialog).getByLabelText("OpenAI reasoning effort");
  expect(within(effort).getAllByRole("option").map((option) => option.textContent)).toEqual([
    "None",
    "Low",
    "Medium",
    "High",
    "Xhigh",
    "Max",
  ]);
  await user.selectOptions(effort, "max");
  await user.click(within(dialog).getByRole("button", { name: "Save settings" }));

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/settings",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({
        ...defaultSettings,
        agentSummaryProvider: "openai",
        agentSummaryOpenAIEffort: "max",
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

test("does not expose automatic selection settings", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession])
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
  expect(
    screen.queryByRole("checkbox", {
      name: "Auto-select attention terminals",
    }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("checkbox", {
      name: "Auto-deselect running agent terminals",
    }),
  ).not.toBeInTheDocument();
});

test("does not send automatic selection settings", async () => {
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
  await user.click(screen.getByRole("button", { name: "Save settings" }));

  const settingsRequest = fetchMock.mock.calls.find(
    ([input, init]) => input === "/api/settings" && init?.method === "PATCH",
  );
  expect(settingsRequest).toBeDefined();
  const body = JSON.parse(String(settingsRequest?.[1]?.body)) as Record<string, unknown>;
  expect(body).not.toHaveProperty("autoSelectAttention");
  expect(body).not.toHaveProperty("autoDeselectRunning");
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
