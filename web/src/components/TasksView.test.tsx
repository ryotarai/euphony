import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TasksView } from "./TasksView";
import type { Session, Task, TaskRefinement } from "../types";

const sessions: Session[] = [{
  id: "terminal-1",
  name: "Terminal",
  state: "running",
  cwd: "/workspace/euphony",
  agent: "claude",
  agentStatus: "running",
  createdAt: "2026-08-05T00:00:00Z",
}];

const task: Task = {
  id: "task-1",
  title: "Implement task API",
  description: "Persist tasks and connect them to agents.",
  priority: "high",
  status: "in_progress",
  terminalId: "terminal-1",
  agent: "claude",
  createdAt: "2026-08-05T00:00:00Z",
  updatedAt: "2026-08-05T00:02:00Z",
  updates: [{
    id: "update-1",
    taskId: "task-1",
    terminalId: "terminal-1",
    kind: "agent_summary",
    body: "Agent summary: Implementing the task API.",
    createdAt: "2026-08-05T00:02:00Z",
  }],
};

const doneTask: Task = {
  ...task,
  id: "task-done",
  title: "Ship Agents pane",
  status: "done",
  terminalId: undefined,
  agent: undefined,
};

function baseProps() {
  return {
    tasks: [task, doneTask],
    sessions,
    selectedTaskID: task.id,
    onSelectTask: vi.fn(),
    onCreateTask: vi.fn().mockResolvedValue(undefined),
    onUpdateTask: vi.fn().mockResolvedValue(undefined),
    onDeleteTask: vi.fn().mockResolvedValue(undefined),
    onStartAgent: vi.fn().mockResolvedValue(undefined),
    onOpenTerminal: vi.fn(),
    onRefineTask: vi.fn().mockResolvedValue(undefined),
    onApplyRefinement: vi.fn().mockResolvedValue(undefined),
    onPromptTask: vi.fn().mockResolvedValue(undefined),
  };
}

test("renders open and done queues with the selected task detail", () => {
  const props = baseProps();
  render(<TasksView {...props} />);

  expect(screen.getByRole("heading", { name: "Tasks" })).toBeVisible();
  expect(screen.getByRole("region", { name: "Open tasks" })).toHaveTextContent(
    "Implement task API",
  );
  expect(screen.getByRole("region", { name: "Done tasks" })).toHaveTextContent(
    "Ship Agents pane",
  );
  const detail = screen.getByRole("region", { name: "Task detail" });
  expect(within(detail).getByDisplayValue("Implement task API")).toBeVisible();
  expect(within(detail).getByText("Agent summary: Implementing the task API.")).toBeVisible();
  expect(within(detail).getByRole("button", { name: "Open terminal" })).toBeVisible();
});

test("creates a task, refines it with AI, applies the proposal, and sends an instruction", async () => {
  const props = baseProps();
  const user = userEvent.setup();
  const { rerender } = render(<TasksView {...props} />);

  await user.click(screen.getByRole("button", { name: "New task" }));
  const createDialog = screen.getByRole("dialog", { name: "New task" });
  await user.type(within(createDialog).getByLabelText("Title"), "Write docs");
  await user.type(within(createDialog).getByLabelText("Description"), "Document the workflow.");
  await user.selectOptions(within(createDialog).getByLabelText("Priority"), "medium");
  await user.click(within(createDialog).getByRole("button", { name: "Create task" }));
  expect(props.onCreateTask).toHaveBeenCalledWith({
    title: "Write docs",
    description: "Document the workflow.",
    priority: "medium",
    status: "todo",
  });

  await user.click(screen.getByRole("button", { name: "Refine with AI" }));
  expect(props.onRefineTask).toHaveBeenCalledWith(task.id);

  const refinement: TaskRefinement = {
    title: "Document the task workflow",
    description: "Write a short guide for create, refine, start, and communicate.",
    priority: "medium",
    status: "todo",
    rationale: "The task has a clear user-facing sequence.",
  };
  rerender(<TasksView {...props} refinement={refinement} />);
  expect(screen.getByRole("region", { name: "AI refinement proposal" })).toHaveTextContent(
    refinement.title,
  );
  await user.click(screen.getByRole("button", { name: "Apply refinement" }));
  expect(props.onApplyRefinement).toHaveBeenCalledWith(task.id, refinement);

  const composer = screen.getByLabelText("Instruction for agent");
  await user.type(composer, "Run the task tests.");
  await user.click(screen.getByRole("button", { name: "Send instruction" }));
  expect(props.onPromptTask).toHaveBeenCalledWith(task.id, "Run the task tests.");
});

test("starts an agent and opens its linked terminal", async () => {
  const props = baseProps();
  const user = userEvent.setup();
  render(<TasksView {...props} />);

  await user.click(screen.getByRole("button", { name: "Open terminal" }));
  expect(props.onOpenTerminal).toHaveBeenCalledWith("terminal-1");

  await user.selectOptions(screen.getByLabelText("Agent to start"), "codex");
  await user.click(screen.getByRole("button", { name: "Start agent" }));
  expect(props.onStartAgent).toHaveBeenCalledWith(task.id, {
    agent: "codex",
    cwd: "/workspace/euphony",
  });
});

test("renders loading and error states", () => {
  const props = baseProps();
  const { rerender } = render(<TasksView {...props} tasks={[]} loading />);
  expect(screen.getByRole("status", { name: "Loading tasks" })).toBeVisible();
  rerender(<TasksView {...props} tasks={[]} error="Tasks are unavailable." />);
  expect(screen.getByRole("alert")).toHaveTextContent("Tasks are unavailable.");
  expect(screen.getByText("No tasks yet.")).toBeVisible();
});
