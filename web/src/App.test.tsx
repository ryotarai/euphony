import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { App, attentionTransitions } from "./App";
import type { Session, Settings } from "./types";

const defaultSettings: Settings = {
  prefix: "Ctrl+B",
  sidebarWidth: 304,
  sidebarCollapsed: false,
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

test("detects only new transitions into attention", () => {
  const attention = { ...runningSession, agentStatus: "attention" };
  expect(attentionTransitions([runningSession], [attention])).toEqual([attention]);
  expect(attentionTransitions([attention], [attention])).toEqual([]);
});

test("acknowledges a need-attention terminal when it receives focus", async () => {
  const attention = { ...secondRunningSession, agentStatus: "attention" };
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([runningSession, attention]))
    .mockImplementationOnce(() =>
      jsonResponse({ ...attention, agentStatus: "waiting" }),
    );
  const user = userEvent.setup();
  render(
    <App
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
    <App
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
    <App
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
  render(<App initialSettings={defaultSettings} />);

  await user.type(screen.getByLabelText("Access token"), "invalid-token");
  await user.click(screen.getByRole("button", { name: "Open Euphony" }));

  expect(await screen.findByText("That token was not accepted.")).toBeVisible();
  expect(sessionStorage.getItem("euphony.token")).toBeNull();
});

test("creates a terminal without asking for a name, selects it, and deletes it", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([runningSession]))
    .mockImplementationOnce(() => jsonResponse(secondRunningSession, 201))
    .mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 204 })));

  const user = userEvent.setup();
  render(
    <App
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
      body: JSON.stringify({ name: "Terminal" }),
    }),
  );
  expect(await screen.findByRole("button", { name: "Select Claude" })).toHaveAttribute("aria-current", "true");
  fireEvent.click(screen.getByRole("button", { name: "Delete Claude" }));

  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Delete Claude" })).not.toBeInTheDocument();
  });
});

test("opens Command-K and creates a terminal in the chosen directory", async () => {
  const created = { ...plainTerminalSession, id: "created", cwd: "/workspace/other" };
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([runningSession]))
    .mockImplementationOnce(() => jsonResponse(created, 201));
  const user = userEvent.setup();
  render(
    <App
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
    <App
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

test("navigates Quick Actions with arrows and Ctrl-P/N before Enter selects", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession]),
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
    <App
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
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
    />,
  );

  expect(await screen.findByLabelText("Claude terminal pane")).toBeVisible();
  expect(screen.queryByLabelText("Codex terminal pane")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Select Codex" }));
  expect(new URLSearchParams(window.location.search).get("terminal")).toBe("session-1");
  expect(await screen.findByLabelText("Codex terminal pane")).toBeVisible();

  history.pushState(null, "", "/?terminal=session-2");
  fireEvent(window, new PopStateEvent("popstate"));
  expect(await screen.findByLabelText("Claude terminal pane")).toBeVisible();
});

test("browser navigation clears ownership from previous dynamic filters", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession]),
  );
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  await screen.findByLabelText("session-1 terminal pane");
  fireEvent.click(screen.getByRole("checkbox", { name: "Show all Running terminals" }));

  history.pushState(null, "", "/?terminal=session-1");
  fireEvent(window, new PopStateEvent("popstate"));
  fireEvent.click(screen.getByRole("checkbox", { name: "Show all Waiting terminals" }));

  expect(screen.getByLabelText("session-1 terminal pane")).toBeVisible();
  expect(await screen.findByLabelText("session-2 terminal pane")).toBeVisible();
});

test("command-click selects multiple terminal panes and stores them in the URL", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession]),
  );
  render(
    <App
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

test("passes the pane count to terminals when the topology changes", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession]),
  );
  render(
    <App
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

test("a checked activity group automatically adds newly matching terminal panes", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([runningSession, secondRunningSession]))
    .mockImplementation(() =>
      jsonResponse([runningSession, secondRunningSession, thirdRunningSession]),
    );
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  await screen.findByLabelText("session-1 terminal pane");
  fireEvent.click(screen.getByRole("checkbox", { name: "Show all Running terminals" }));
  await vi.advanceTimersByTimeAsync(1500);

  expect(await screen.findByLabelText("session-3 terminal pane")).toBeVisible();
  expect(new URLSearchParams(window.location.search).getAll("status")).toEqual(["running"]);
  vi.useRealTimers();
});

test("a checked activity group removes a terminal after its status changes", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([runningSession, thirdRunningSession]))
    .mockImplementation(() =>
      jsonResponse([runningSession, { ...thirdRunningSession, agentStatus: "waiting" }]),
    );
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  await screen.findByLabelText("session-1 terminal pane");
  fireEvent.click(screen.getByRole("checkbox", { name: "Show all Running terminals" }));
  expect(await screen.findByLabelText("session-3 terminal pane")).toBeVisible();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });

  await waitFor(() => {
    expect(screen.queryByLabelText("session-3 terminal pane")).not.toBeInTheDocument();
  });
  expect(screen.getByLabelText("session-1 terminal pane")).toBeVisible();
  vi.useRealTimers();
});

test("a focused terminal stays selected when polling identifies it as an agent", async () => {
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
          agent: "claude",
          agentStatus: "waiting",
          agentTitle: "Claude Code",
        },
        otherTerminal,
      ]),
    );
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  await screen.findByLabelText("session-plain terminal pane");
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Include all terminals in /workspace/shell",
    }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });

  expect(screen.getByLabelText("session-plain terminal pane")).toBeVisible();
  expect(screen.queryByLabelText("session-other terminal pane")).not.toBeInTheDocument();
  expect(new URLSearchParams(location.search).getAll("terminal")).toEqual(["session-plain"]);
  expect(new URLSearchParams(location.search).getAll("status")).toEqual([]);
  expect(new URLSearchParams(location.search).getAll("cwd")).toEqual([]);
  expect(new URLSearchParams(location.search).get("focus")).toBe("session-plain");
  vi.useRealTimers();
});

test("a checked status and cwd group dynamically follows matching terminals", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
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
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  await screen.findByLabelText("session-1 terminal pane");
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Include all terminals in /workspace/euphony",
    }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });

  await waitFor(() => {
    expect(screen.queryByLabelText("session-1 terminal pane")).not.toBeInTheDocument();
  });
  expect(screen.getByLabelText("session-replacement terminal pane")).toBeVisible();
  expect(new URLSearchParams(window.location.search).getAll("cwd")).toEqual([
    "running\u0000/workspace/euphony",
  ]);
  vi.useRealTimers();
});

test("the Terminal activity checkbox selects shells without a coding agent", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, plainTerminalSession]),
  );
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  await screen.findByLabelText("session-1 terminal pane");
  fireEvent.click(screen.getByRole("checkbox", { name: "Show all Terminal terminals" }));

  expect(await screen.findByLabelText("session-plain terminal pane")).toBeVisible();
});

test("unchecking an activity group removes only its terminal panes", async () => {
  const terminals = Array.from({ length: 4 }, (_, index) => ({
    ...plainTerminalSession,
    id: `terminal-${index + 1}`,
    name: `Terminal ${index + 1}`,
  }));
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, ...terminals]),
  );
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  await screen.findByLabelText("session-1 terminal pane");
  const terminalGroup = screen.getByRole("checkbox", {
    name: "Show all Terminal terminals",
  });
  fireEvent.click(terminalGroup);
  for (const terminal of terminals) {
    expect(await screen.findByLabelText(`${terminal.id} terminal pane`)).toBeVisible();
  }

  fireEvent.click(terminalGroup);

  expect(screen.getByLabelText("session-1 terminal pane")).toBeVisible();
  for (const terminal of terminals) {
    expect(screen.queryByLabelText(`${terminal.id} terminal pane`)).not.toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: `Include ${terminal.name} in split` }),
    ).not.toBeChecked();
  }
  const params = new URLSearchParams(window.location.search);
  expect(params.getAll("terminal")).toEqual(["session-1"]);
  expect(params.getAll("status")).toEqual([]);
  expect(params.get("focus")).toBe("session-1");
});

test("clicking a status label replaces the current pane selection", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession]),
  );
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );
  await screen.findByLabelText("session-1 terminal pane");
  const claudeCheckbox = screen.getByRole("checkbox", { name: "Include Claude in split" });
  fireEvent.click(claudeCheckbox);
  expect(await screen.findByLabelText("session-2 terminal pane")).toBeVisible();
  expect(claudeCheckbox).toBeChecked();

  fireEvent.click(screen.getByRole("button", { name: "Show only Waiting terminals" }));

  expect(screen.queryByLabelText("session-1 terminal pane")).not.toBeInTheDocument();
  expect(screen.getByLabelText("session-2 terminal pane")).toBeVisible();
  expect(new URLSearchParams(window.location.search).getAll("status")).toEqual(["waiting"]);
});

test("clicking a cwd label selects only terminals in that status and cwd", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession, thirdRunningSession]),
  );
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );
  await screen.findByLabelText("session-1 terminal pane");

  fireEvent.click(
    screen.getByRole("button", {
      name: "Show only Running terminals in /workspace/api",
    }),
  );

  expect(screen.queryByLabelText("session-1 terminal pane")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("session-2 terminal pane")).not.toBeInTheDocument();
  expect(await screen.findByLabelText("session-3 terminal pane")).toBeVisible();
  const parameters = new URLSearchParams(window.location.search);
  expect(parameters.getAll("status")).toEqual([]);
  expect(parameters.getAll("cwd")).toEqual(["running\u0000/workspace/api"]);
});

test("a status selection checks its cwd groups and allows one cwd to be excluded", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, thirdRunningSession]),
  );
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );
  await screen.findByLabelText("session-1 terminal pane");

  fireEvent.click(screen.getByRole("checkbox", { name: "Show all Running terminals" }));
  expect(
    screen.getByRole("checkbox", {
      name: "Include all terminals in /workspace/euphony",
    }),
  ).toBeChecked();
  const apiCwd = screen.getByRole("checkbox", {
    name: "Include all terminals in /workspace/api",
  });
  expect(apiCwd).toBeChecked();

  fireEvent.click(apiCwd);

  expect(screen.getByLabelText("session-1 terminal pane")).toBeVisible();
  expect(screen.queryByLabelText("session-3 terminal pane")).not.toBeInTheDocument();
  expect(
    screen.getByRole("checkbox", { name: "Show all Running terminals" }),
  ).toHaveAttribute("aria-checked", "mixed");
  expect(apiCwd).not.toBeChecked();
  const parameters = new URLSearchParams(window.location.search);
  expect(parameters.getAll("status")).toEqual([]);
  expect(parameters.getAll("cwd")).toEqual([
    "running\u0000/workspace/euphony",
  ]);

  fireEvent.click(apiCwd);

  expect(
    screen.getByRole("checkbox", { name: "Show all Running terminals" }),
  ).toHaveAttribute("aria-checked", "true");
  expect(apiCwd).toBeChecked();
  expect(await screen.findByLabelText("session-3 terminal pane")).toBeVisible();
  const restoredParameters = new URLSearchParams(window.location.search);
  expect(restoredParameters.getAll("status")).toEqual(["running"]);
  expect(restoredParameters.getAll("cwd")).toEqual([]);
});

test("rechecking the only cwd restores its parent status as a dynamic filter", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([runningSession]))
    .mockImplementation(() => jsonResponse([runningSession, thirdRunningSession]));
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );
  await screen.findByLabelText("session-1 terminal pane");

  fireEvent.click(screen.getByRole("checkbox", { name: "Show all Running terminals" }));
  const cwd = screen.getByRole("checkbox", {
    name: "Include all terminals in /workspace/euphony",
  });
  fireEvent.click(cwd);
  expect(screen.queryByLabelText("session-1 terminal pane")).not.toBeInTheDocument();

  fireEvent.click(cwd);
  expect(
    screen.getByRole("checkbox", { name: "Show all Running terminals" }),
  ).toHaveAttribute("aria-checked", "true");
  expect(new URLSearchParams(window.location.search).getAll("status")).toEqual([
    "running",
  ]);
  expect(new URLSearchParams(window.location.search).getAll("cwd")).toEqual([]);

  await vi.advanceTimersByTimeAsync(1_500);
  expect(await screen.findByLabelText("session-3 terminal pane")).toBeVisible();
  vi.useRealTimers();
});

test("unchecking a terminal releases its ancestor status filter", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, thirdRunningSession]),
  );
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );
  await screen.findByLabelText("session-1 terminal pane");

  fireEvent.click(screen.getByRole("checkbox", { name: "Show all Running terminals" }));
  await screen.findByLabelText("session-3 terminal pane");
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Include Codex in split" }),
  );

  expect(screen.queryByLabelText("session-1 terminal pane")).not.toBeInTheDocument();
  expect(screen.getByLabelText("session-3 terminal pane")).toBeVisible();
  expect(
    screen.getByRole("checkbox", { name: "Show all Running terminals" }),
  ).toHaveAttribute("aria-checked", "mixed");
  expect(
    screen.getByRole("checkbox", {
      name: "Include all terminals in /workspace/euphony",
    }),
  ).not.toBeChecked();
  expect(
    screen.getByRole("checkbox", {
      name: "Include all terminals in /workspace/api",
    }),
  ).toBeChecked();
  const parameters = new URLSearchParams(window.location.search);
  expect(parameters.getAll("status")).toEqual([]);
  expect(parameters.getAll("cwd")).toEqual(["running\u0000/workspace/api"]);
});

test("tmux navigation keys switch terminals and focus panes", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession]),
  );
  render(
    <App
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
    <App
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
    <App
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
    <App
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
    <App
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
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );
  await screen.findByLabelText("session-1 terminal pane");

  fireEvent.keyDown(window, { key: "b", ctrlKey: true });
  fireEvent.keyDown(window, { key: "c" });
  expect(await screen.findByLabelText("created-c terminal pane")).toBeVisible();
  expect(screen.queryByLabelText("session-1 terminal pane")).not.toBeInTheDocument();

  fireEvent.keyDown(window, { key: "b", ctrlKey: true });
  fireEvent.keyDown(window, { key: "v" });
  expect(await screen.findByLabelText("created-v terminal pane")).toBeVisible();
  expect(screen.getByLabelText("created-c terminal pane")).toBeVisible();
  expect(new URLSearchParams(window.location.search).getAll("terminal")).toEqual([
    "created-c",
    "created-v",
  ]);
});

test("loads settings and saves a changed prefix", async () => {
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
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );
  await screen.findByLabelText("session-1 terminal pane");

  await user.click(screen.getByRole("button", { name: "Open settings" }));
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  expect(dialog).toHaveAttribute("data-slot", "dialog-content");
  const prefix = screen.getByLabelText("Prefix");
  expect(prefix).toHaveAttribute("data-slot", "input");
  expect(prefix).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Open settings" }));
  const reopenedPrefix = screen.getByLabelText("Prefix");
  await user.clear(reopenedPrefix);
  await user.type(reopenedPrefix, "Ctrl+A");
  await user.click(screen.getByRole("button", { name: "Save settings" }));

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/settings",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ ...defaultSettings, prefix: "Ctrl+A" }),
    }),
  );
});
