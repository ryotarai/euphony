import { act, render, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";
import type { ApiClient } from "../api";
import type { AgentTranscript, Session } from "../types";
import { AgentLogView } from "./AgentLogView";

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
  entries: [
    {
      id: "1-0",
      kind: "message",
      role: "assistant",
      timestamp: "2026-07-30T01:02:03Z",
      content: "# Result\n\n- one\n- two\n\n| Check | Result |\n| --- | --- |\n| Tests | Pass |\n\n`go test ./...`\n\n<script>alert('no')</script>",
    },
    {
      id: "2-0",
      kind: "tool",
      title: "exec_command",
      content: '{\n  "cmd": "go test ./..."\n}',
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
  expect(screen.getByText("<script>alert('no')</script>")).toBeInTheDocument();
  expect(document.querySelector("script")).toBeNull();
  expect(screen.getByText("exec_command")).toBeInTheDocument();
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
  expect(getAgentLog).toHaveBeenLastCalledWith("terminal-1", 'W/"first"');

  rerender(<AgentLogView session={session} api={api} active={false} />);
  await act(async () => {
    vi.advanceTimersByTime(2000);
    await Promise.resolve();
  });
  expect(getAgentLog).toHaveBeenCalledTimes(2);
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
