import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentsView } from "./AgentsView";
import type { AgentSummary, Session } from "../types";

const sessions: Session[] = [
  {
    id: "blocked-terminal",
    name: "Codex",
    state: "running",
    cwd: "/workspace/api",
    agent: "codex",
    agentStatus: "blocked",
    agentTitle: "Permission request",
    createdAt: "2026-08-05T00:00:00Z",
  },
  {
    id: "running-terminal",
    name: "Claude",
    state: "running",
    cwd: "/workspace/web",
    agent: "claude",
    agentStatus: "running",
    agentTitle: "Implement dashboard",
    createdAt: "2026-08-05T00:01:00Z",
  },
];

const summaries: AgentSummary[] = [
  {
    terminalId: "blocked-terminal",
    provider: "codex",
    status: "blocked",
    summary: "The agent needs permission to edit the API.",
    action: "Approve the requested file access.",
    generatedAt: "2026-08-05T00:02:00Z",
    unread: true,
  },
  {
    terminalId: "running-terminal",
    provider: "claude",
    status: "running",
    summary: "The agent is updating the dashboard tests.",
    generatedAt: "2026-08-05T00:03:00Z",
    unread: true,
  },
  {
    terminalId: "missing-terminal",
    provider: "claude",
    status: "running",
    summary: "Do not render this.",
    generatedAt: "2026-08-05T00:04:00Z",
    unread: true,
  },
];

const tabSummaries: AgentSummary[] = [
  {
    terminalId: "blocked-terminal",
    provider: "codex",
    status: "blocked",
    summary: "Unread summary",
    generatedAt: "2026-08-05T00:02:00Z",
    unread: true,
  },
  {
    terminalId: "running-terminal",
    provider: "claude",
    status: "running",
    summary: "Read summary",
    generatedAt: "2026-08-05T00:03:00Z",
    unread: false,
  },
];

test("separates action-required and running agents with actionable copy", async () => {
  const onSelectSession = vi.fn();
  const user = userEvent.setup();
  render(<AgentsView summaries={summaries} sessions={sessions} onSelectSession={onSelectSession} />);

  const actionSection = screen.getByRole("region", { name: "Action required" });
  const runningSection = screen.getByRole("region", { name: "Running" });
  expect(within(actionSection).getByText("Permission request")).toBeInTheDocument();
  expect(within(actionSection).getByText("Codex · GPT-5.6-luna")).toBeInTheDocument();
  expect(within(actionSection).getByText("The agent needs permission to edit the API.")).toBeInTheDocument();
  expect(within(actionSection).getByText("Approve the requested file access.")).toBeInTheDocument();
  expect(within(runningSection).getByText("Implement dashboard")).toBeInTheDocument();
  expect(within(runningSection).getByText("The agent is updating the dashboard tests.")).toBeInTheDocument();
  expect(screen.queryByText("Do not render this.")).not.toBeInTheDocument();

  await user.click(within(actionSection).getByRole("button", { name: /Permission request/ }));
  expect(onSelectSession).toHaveBeenCalledWith("blocked-terminal");
});

test("filters summaries through accessible unread and read tabs", async () => {
  const user = userEvent.setup();
  render(
    <AgentsView
      summaries={tabSummaries}
      sessions={sessions}
      onSelectSession={vi.fn()}
    />,
  );

  expect(screen.getByRole("tab", { name: /Unread 1/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByText("Unread summary")).toBeInTheDocument();
  expect(screen.queryByText("Read summary")).not.toBeInTheDocument();

  await user.click(screen.getByRole("tab", { name: /Read 1/ }));

  expect(screen.getByText("Read summary")).toBeInTheDocument();
  expect(screen.queryByText("Unread summary")).not.toBeInTheDocument();
});

test("renders loading, error, and empty section states", () => {
  const props = {
    summaries: [],
    sessions: [],
    onSelectSession: vi.fn(),
  };
  const { rerender } = render(<AgentsView {...props} loading />);
  expect(screen.getByRole("status", { name: "Loading agent summaries" })).toBeInTheDocument();

  rerender(<AgentsView {...props} error="Summaries are unavailable." />);
  expect(screen.getByRole("alert")).toHaveTextContent("Summaries are unavailable.");
  expect(within(screen.getByRole("region", { name: "Action required" })).getByText("No unread agents need attention.")).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Running" })).getByText("No unread agents are running.")).toBeInTheDocument();
});
