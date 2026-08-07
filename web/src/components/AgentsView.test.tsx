import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentsView } from "./AgentsView";
import type { AgentSummary, Session } from "../types";

const sessions: Session[] = [
  {
    id: "high-terminal",
    name: "Codex high",
    state: "running",
    cwd: "/workspace/api",
    agent: "codex",
    agentStatus: "blocked",
    agentTitle: "Permission request",
    createdAt: "2026-08-05T00:00:00Z",
  },
  {
    id: "medium-terminal",
    name: "Codex medium",
    state: "running",
    cwd: "/workspace/api",
    agent: "codex",
    agentStatus: "waiting",
    agentTitle: "Review request",
    createdAt: "2026-08-05T00:01:00Z",
  },
  {
    id: "low-terminal",
    name: "Claude low",
    state: "running",
    cwd: "/workspace/web",
    agent: "claude",
    agentStatus: "blocked",
    agentTitle: "Routine follow-up",
    createdAt: "2026-08-05T00:02:00Z",
  },
  {
    id: "running-terminal",
    name: "Claude",
    state: "running",
    cwd: "/workspace/web",
    agent: "claude",
    agentStatus: "running",
    agentTitle: "Implement dashboard",
    createdAt: "2026-08-05T00:03:00Z",
  },
  {
    id: "done-terminal",
    name: "Codex done",
    state: "running",
    cwd: "/workspace/read",
    agent: "codex",
    agentStatus: "blocked",
    agentTitle: "Completed permission request",
    createdAt: "2026-08-05T00:04:00Z",
  },
];

const summaries: AgentSummary[] = [
  {
    terminalId: "low-terminal",
    provider: "claude",
    status: "blocked",
    summary: "A routine follow-up is ready.",
    action: "Review the generated notes.",
    priority: "low",
    generatedAt: "2026-08-05T00:05:00Z",
    unread: false,
    done: false,
  },
  {
    terminalId: "medium-terminal",
    provider: "codex",
    status: "waiting",
    summary: "The agent is waiting for review.",
    action: "Review the requested change.",
    priority: "medium",
    generatedAt: "2026-08-05T00:06:00Z",
    unread: false,
    done: false,
  },
  {
    terminalId: "high-terminal",
    provider: "codex",
    status: "blocked",
    summary: "The agent needs permission to edit the API.",
    action: "Approve the requested file access.",
    priority: "high",
    generatedAt: "2026-08-05T00:07:00Z",
    unread: true,
    done: false,
  },
  {
    terminalId: "running-terminal",
    provider: "claude",
    status: "running",
    summary: "The agent is updating the dashboard tests.",
    generatedAt: "2026-08-05T00:08:00Z",
    unread: true,
    done: false,
  },
  {
    terminalId: "done-terminal",
    provider: "codex",
    status: "blocked",
    summary: "The permission request was completed.",
    action: "Approve the requested file access.",
    priority: "high",
    generatedAt: "2026-08-05T00:09:00Z",
    unread: false,
    done: true,
  },
  {
    terminalId: "missing-terminal",
    provider: "claude",
    status: "running",
    summary: "Do not render this.",
    generatedAt: "2026-08-05T00:10:00Z",
    unread: true,
    done: false,
  },
];

function renderAgents(overrides: Partial<React.ComponentProps<typeof AgentsView>> = {}) {
  return render(
    <AgentsView
      summaries={summaries}
      sessions={sessions}
      onSelectSession={vi.fn()}
      onMarkDone={vi.fn().mockResolvedValue(undefined)}
      {...overrides}
    />,
  );
}

test("keeps unread and read summaries in one Action required queue", () => {
  renderAgents();

  expect(screen.getByRole("tab", { name: /Action required 4/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("tab", { name: /Done 1/ })).toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: /Unread|Read/ })).not.toBeInTheDocument();
  expect(screen.getByText("Approve the requested file access.")).toBeInTheDocument();
  expect(screen.getByText("The agent is updating the dashboard tests.")).toBeInTheDocument();
  expect(screen.queryByText("The permission request was completed.")).not.toBeInTheDocument();
});

test("sorts action cards by AI priority and renders text badges", () => {
  renderAgents();

  const cards = screen.getByRole("region", { name: "Action required" })
    .querySelectorAll("[data-testid^='agent-summary-card-']");
  expect([...cards].map((card) => card.querySelector("[data-testid='agent-summary-priority']")?.textContent))
    .toEqual(["High", "Medium", "Low"]);
  expect(screen.getByLabelText("High priority")).toBeInTheDocument();
  expect(screen.getByLabelText("Medium priority")).toBeInTheDocument();
  expect(screen.getByLabelText("Low priority")).toBeInTheDocument();
});

test("marks unread content for bold presentation without an unread tab", () => {
  renderAgents();

  const unreadCard = screen.getByTestId("agent-summary-card-high-terminal");
  const readCard = screen.getByTestId("agent-summary-card-medium-terminal");
  expect(unreadCard).toHaveAttribute("data-unread", "true");
  expect(readCard).toHaveAttribute("data-unread", "false");
  expect(unreadCard.querySelector(".agent-summary-title")).toHaveAttribute("data-unread", "true");
  expect(unreadCard.querySelector(".agent-summary-copy")).toHaveAttribute("data-unread", "true");
  expect(unreadCard.querySelector(".agent-summary-action")).toHaveAttribute("data-unread", "true");
  expect(unreadCard.querySelector(".agent-summary-unread-marker")).toBeNull();
});

test("moves Done summaries to the Done tab while keeping the two status sections there", async () => {
  const user = userEvent.setup();
  renderAgents();

  await user.click(screen.getByRole("tab", { name: /Done 1/ }));

  expect(screen.getByRole("region", { name: "Done" })).toBeInTheDocument();
  expect(screen.getByText("The permission request was completed.")).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Running" })).not.toBeInTheDocument();
  expect(screen.queryByText("Approve the requested file access.")).toBeInTheDocument();
});

test("marks an action Done with the separate checkmark button", async () => {
  const onSelectSession = vi.fn();
  const onMarkDone = vi.fn().mockResolvedValue(undefined);
  const user = userEvent.setup();
  renderAgents({ onSelectSession, onMarkDone });

  const doneButton = screen.getByRole("button", { name: "Mark Permission request as done" });
  await user.click(doneButton);

  expect(onMarkDone).toHaveBeenCalledWith("high-terminal");
  expect(onSelectSession).not.toHaveBeenCalled();
  expect(screen.getByRole("tab", { name: /Done 1/ })).toHaveAttribute("aria-selected", "true");
});

test("activates the Done checkmark with the keyboard", async () => {
  const onMarkDone = vi.fn().mockResolvedValue(undefined);
  const user = userEvent.setup();
  renderAgents({ onMarkDone });

  const doneButton = screen.getByRole("button", { name: "Mark Permission request as done" });
  doneButton.focus();
  await user.keyboard("{Enter}");

  expect(onMarkDone).toHaveBeenCalledWith("high-terminal");
});

test("opens a card body with the keyboard", async () => {
  const onSelectSession = vi.fn();
  const user = userEvent.setup();
  renderAgents({ onSelectSession });

  const openButton = screen.getByRole("button", { name: "Open Permission request" });
  openButton.focus();
  await user.keyboard("{Enter}");

  expect(onSelectSession).toHaveBeenCalledWith("high-terminal");
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
  expect(within(screen.getByRole("region", { name: "Action required" })).getByText("No actions require attention.")).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Running" })).getByText("No agents are running.")).toBeInTheDocument();
});
