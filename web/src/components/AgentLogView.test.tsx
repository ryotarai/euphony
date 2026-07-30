import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import type { ApiClient } from "../api";
import type { AgentTranscript, Session } from "../types";
import { AgentLogView } from "./AgentLogView";

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: mermaidMocks,
}));

beforeEach(() => {
  mermaidMocks.initialize.mockClear();
  mermaidMocks.render.mockReset().mockResolvedValue({
    svg: '<svg role="img" aria-label="Plan to build diagram"></svg>',
  });
});

const session: Session = {
  id: "terminal-1",
  name: "Terminal one",
  state: "running",
  cwd: "/repo",
  agent: "codex",
  createdAt: "2026-07-30T01:00:00Z",
};

const initialLog: AgentTranscript = {
  agent: "codex",
  sessionId: "session-1",
  startCursor: "100",
  endCursor: "200",
  nextCursor: "100",
  entries: [
    {
      id: "1-0",
      kind: "message",
      role: "assistant",
      timestamp: "2026-07-30T01:02:03Z",
      content: "# Result\n\n- one\n- two\n\n| Check | Result |\n| --- | --- |\n| Tests | Pass |\n\n`go test ./...`\n\n```typescript\nconst answer = 42;\n```\n\n<script>alert('no')</script>",
    },
    {
      id: "2-0",
      kind: "tool_group",
      toolCalls: 3,
    },
  ],
};

test("applies the configured agent log font size", () => {
  const api = {
    getAgentLog: vi.fn().mockResolvedValue({ log: initialLog, etag: 'W/"first"' }),
  } as unknown as ApiClient;

  render(<AgentLogView session={session} api={api} active={false} fontSize={17} />);

  expect(screen.getByRole("region", { name: "Agent log" })).toHaveStyle({
    "--agent-log-font-size": "17px",
  });
});

test("renders normalized transcript as safe semantic HTML", async () => {
  const api = {
    getAgentLog: vi.fn().mockResolvedValue({ log: initialLog, etag: 'W/"first"' }),
  } as unknown as ApiClient;
  render(<AgentLogView session={session} api={api} active />);

  expect(await screen.findByRole("heading", { name: "Result" })).toBeInTheDocument();
  expect(screen.getByRole("list")).toHaveTextContent(/one\s+two/);
  const table = screen.getByRole("table");
  expect(within(table).getByRole("columnheader", { name: "Check" })).toBeVisible();
  expect(within(table).getByRole("columnheader", { name: "Result" })).toBeVisible();
  expect(within(table).getByRole("cell", { name: "Tests" })).toBeVisible();
  expect(within(table).getByRole("cell", { name: "Pass" })).toBeVisible();
  expect(screen.getByText("go test ./...")).toBeInstanceOf(HTMLElement);
  expect(screen.getByText("const answer = 42;")).toHaveClass("language-typescript");
  expect(screen.getByText("<script>alert('no')</script>")).toBeInTheDocument();
  expect(document.querySelector("script")).toBeNull();
  expect(screen.getByText("3 tool calls")).toBeInTheDocument();
  expect(screen.getByText("3 tool calls").closest("details")).toBeNull();
});

test("renders Mermaid fenced code as a diagram", async () => {
  const mermaidLog: AgentTranscript = {
    ...initialLog,
    entries: [
      {
        id: "mermaid-1",
        kind: "message",
        role: "assistant",
        content: [
          "```mermaid",
          "flowchart LR",
          "  Plan --> Build",
          "```",
        ].join("\n"),
      },
    ],
  };
  const api = {
    getAgentLog: vi.fn().mockResolvedValue({ log: mermaidLog, etag: 'W/"mermaid"' }),
  } as unknown as ApiClient;

  render(<AgentLogView session={session} api={api} active />);

  const diagram = await screen.findByRole("figure", { name: "Mermaid diagram" });
  await waitFor(() => {
    expect(diagram.querySelector("svg")).toBeInTheDocument();
  });
  expect(diagram.querySelector("code.language-mermaid")).toBeNull();
});

test("preserves Mermaid source when the diagram cannot be rendered", async () => {
  mermaidMocks.render.mockRejectedValueOnce(new Error("Invalid diagram"));
  const invalidMermaidLog: AgentTranscript = {
    ...initialLog,
    entries: [
      {
        id: "mermaid-invalid",
        kind: "message",
        role: "assistant",
        content: "```mermaid\nflowchart definitely-invalid\n```",
      },
    ],
  };
  const api = {
    getAgentLog: vi.fn().mockResolvedValue({
      log: invalidMermaidLog,
      etag: 'W/"invalid-mermaid"',
    }),
  } as unknown as ApiClient;

  render(<AgentLogView session={session} api={api} active />);

  const diagram = await screen.findByRole("figure", { name: "Mermaid diagram" });
  expect(within(diagram).getByText(/flowchart definitely-invalid/)).toBeVisible();
  expect(
    await within(diagram).findByText("Diagram could not be rendered."),
  ).toBeVisible();
});

test("polls with the previous etag only while active", async () => {
  vi.useFakeTimers();
  const getAgentLog = vi
    .fn()
    .mockResolvedValueOnce({ log: initialLog, etag: 'W/"first"' })
    .mockResolvedValueOnce({ log: null, etag: 'W/"first"' });
  const api = { getAgentLog } as unknown as ApiClient;
  const { rerender } = render(<AgentLogView session={session} api={api} active />);
  await act(async () => Promise.resolve());
  expect(getAgentLog).toHaveBeenCalledWith("terminal-1", undefined);

  await act(async () => {
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
  });
  expect(getAgentLog).toHaveBeenLastCalledWith("terminal-1", {
    after: "200",
    etag: 'W/"first"',
  });

  rerender(<AgentLogView session={session} api={api} active={false} />);
  await act(async () => {
    vi.advanceTimersByTime(2000);
    await Promise.resolve();
  });
  expect(getAgentLog).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});

test("loads older entries from the top and preserves the reading position", async () => {
  const user = userEvent.setup();
  const olderLog: AgentTranscript = {
    agent: "codex",
    sessionId: "session-1",
    startCursor: "0",
    endCursor: "100",
    entries: [
      { id: "0-0", kind: "message", role: "assistant", content: "Oldest message" },
      { id: "50-0", kind: "tool_group", toolCalls: 2 },
    ],
  };
  let scrollHeight = 1000;
  const getAgentLog = vi
    .fn()
    .mockResolvedValueOnce({ log: initialLog, etag: 'W/"first"' })
    .mockImplementationOnce(async () => {
      scrollHeight = 1600;
      return { log: olderLog, etag: 'W/"first"' };
    });
  const api = { getAgentLog } as unknown as ApiClient;
  render(<AgentLogView session={session} api={api} active />);
  await screen.findByRole("heading", { name: "Result" });
  const viewport = screen.getByLabelText("Agent log", {
    selector: '[data-slot="message-scroller-viewport"]',
  });
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  fireEvent.scroll(viewport, { target: { scrollTop: 250 } });

  await user.click(screen.getByRole("button", { name: "Load more" }));

  expect(await screen.findByText("Oldest message")).toBeInTheDocument();
  expect(screen.getByText("2 tool calls")).toBeInTheDocument();
  expect(getAgentLog).toHaveBeenNthCalledWith(2, "terminal-1", {
    before: "100",
  });
  await waitFor(() => expect(viewport.scrollTop).toBe(850));
  expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
});

test("appends only records after the observed live edge", async () => {
  vi.useFakeTimers();
  const appendedLog: AgentTranscript = {
    agent: "codex",
    sessionId: "session-1",
    startCursor: "200",
    endCursor: "240",
    entries: [
      { id: "200-0", kind: "tool_group", toolCalls: 2 },
      { id: "220-0", kind: "message", role: "assistant", content: "Newest message" },
    ],
  };
  const getAgentLog = vi
    .fn()
    .mockResolvedValueOnce({ log: initialLog, etag: 'W/"first"' })
    .mockResolvedValueOnce({ log: appendedLog, etag: 'W/"second"' });
  const api = { getAgentLog } as unknown as ApiClient;
  render(<AgentLogView session={session} api={api} active />);
  await act(async () => Promise.resolve());

  await act(async () => {
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
  });

  expect(getAgentLog).toHaveBeenLastCalledWith("terminal-1", {
    after: "200",
    etag: 'W/"first"',
  });
  expect(screen.getByText("Newest message")).toBeInTheDocument();
  expect(screen.getByText("5 tool calls")).toBeInTheDocument();
  vi.useRealTimers();
});

test("replaces the transcript when a linked agent session changes", async () => {
  const secondLog: AgentTranscript = {
    agent: "claude",
    sessionId: "session-2",
    entries: [{ id: "1-0", kind: "message", role: "assistant", content: "Newest session" }],
  };
  const getAgentLog = vi
    .fn()
    .mockResolvedValueOnce({ log: initialLog, etag: 'W/"first"' })
    .mockResolvedValueOnce({ log: secondLog, etag: 'W/"second"' });
  const api = { getAgentLog } as unknown as ApiClient;
  const { rerender } = render(<AgentLogView session={session} api={api} active />);
  expect(await screen.findByRole("heading", { name: "Result" })).toBeInTheDocument();

  rerender(<AgentLogView session={{ ...session, agent: "claude" }} api={api} active />);
  expect(await screen.findByText("Newest session")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Result" })).not.toBeInTheDocument();
});

test("explains unavailable logs and retries automatically", async () => {
  const api = {
    getAgentLog: vi.fn().mockRejectedValue({
      status: 404,
      code: "agent_log_not_found",
      message: "The linked agent log is not available yet.",
    }),
  } as unknown as ApiClient;
  render(<AgentLogView session={{ ...session, agent: undefined }} api={api} active />);

  await waitFor(() => {
    expect(screen.getByText("Agent log will appear when Claude or Codex starts here.")).toBeInTheDocument();
  });
});

test("distinguishes a linked transcript that has not appeared yet", async () => {
  const api = {
    getAgentLog: vi.fn().mockRejectedValue({
      status: 404,
      code: "agent_log_not_found",
      message: "The linked agent log is not available yet.",
    }),
  } as unknown as ApiClient;
  render(<AgentLogView session={{ ...session, agent: "claude" }} api={api} active />);

  expect(
    await screen.findByText("Waiting for the linked Claude transcript…"),
  ).toBeInTheDocument();
});

test("shows an explicit empty state for an empty transcript", async () => {
  const api = {
    getAgentLog: vi.fn().mockResolvedValue({
      log: { ...initialLog, entries: null },
      etag: 'W/"empty"',
    }),
  } as unknown as ApiClient;
  render(<AgentLogView session={session} api={api} active />);

  expect(await screen.findByText("Transcript is empty")).toBeInTheDocument();
  expect(screen.getByText("Waiting for the first agent event…")).toBeInTheDocument();
});

test("keeps the current log visible while a refresh is failing", async () => {
  vi.useFakeTimers();
  const getAgentLog = vi
    .fn()
    .mockResolvedValueOnce({ log: initialLog, etag: 'W/"first"' })
    .mockRejectedValueOnce(new Error("Temporary failure"));
  const api = { getAgentLog } as unknown as ApiClient;
  render(<AgentLogView session={session} api={api} active />);
  await act(async () => Promise.resolve());

  await act(async () => {
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
  });

  expect(screen.getByRole("heading", { name: "Result" })).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Refresh interrupted. Retrying automatically.",
  );
  vi.useRealTimers();
});
