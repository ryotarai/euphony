import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectSidebar } from "./ProjectSidebar";
import type { AgentSummary, Project, Session } from "../types";

const project: Project = {
  id: "project-api",
  path: "/workspace/api",
  createdAt: "2026-08-12T00:00:00Z",
};

const emptyProject: Project = {
  id: "project-empty",
  path: "/workspace/empty",
  createdAt: "2026-08-12T00:01:00Z",
};

const agentSession: Session = {
  id: "agent-1",
  name: "Codex",
  state: "running",
  cwd: project.path,
  projectId: project.id,
  agent: "codex",
  agentStatus: "waiting",
  agentTitle: "Implement the API",
  createdAt: "2026-08-12T00:02:00Z",
};

const terminalSession: Session = {
  id: "terminal-1",
  name: "Shell",
  state: "running",
  cwd: project.path,
  projectId: project.id,
  createdAt: "2026-08-12T00:03:00Z",
};

const legacySession: Session = {
  id: "legacy-1",
  name: "Legacy terminal",
  state: "exited",
  cwd: "/workspace/legacy",
  createdAt: "2026-08-12T00:04:00Z",
};

const unreadSummary: AgentSummary = {
  terminalId: agentSession.id,
  provider: "codex",
  status: "waiting",
  summary: "Updating the API",
  action: "Approve the pending change",
  generatedAt: "2026-08-12T00:05:00Z",
  unread: true,
};

function renderSidebar(
  overrides: Partial<React.ComponentProps<typeof ProjectSidebar>> = {},
) {
  const props: React.ComponentProps<typeof ProjectSidebar> = {
    projects: [project],
    sessions: [agentSession, terminalSession],
    agentSummaries: [unreadSummary],
    selectedID: agentSession.id,
    onSelectSession: vi.fn(),
    onCreateTerminal: vi.fn(),
    onCreateAgent: vi.fn(),
    onAddProject: vi.fn(),
    ...overrides,
  };
  return { ...render(<ProjectSidebar {...props} />), props };
}

test("renders persisted projects including an empty project", () => {
  renderSidebar({ projects: [project, emptyProject] });

  expect(screen.getByRole("heading", { name: project.path })).toBeVisible();
  expect(screen.getByRole("heading", { name: emptyProject.path })).toBeVisible();
});

test("renders legacy sessions in a bounded Unassigned group", () => {
  renderSidebar({ sessions: [legacySession] });

  const heading = screen.getByRole("heading", { name: "Unassigned" });
  const group = heading.closest("section");
  expect(group).not.toBeNull();
  expect(group).toHaveClass("project-sidebar-unassigned");
  expect(group).toHaveAttribute("data-project-id", "unassigned");
  expect(within(group as HTMLElement).getByRole("button", { name: "Select Legacy terminal" }))
    .toBeInTheDocument();
});

test("routes sessions with an unknown project ID to Unassigned", () => {
  renderSidebar({
    sessions: [{ ...legacySession, projectId: "missing-project" }],
  });

  const group = screen.getByRole("heading", { name: "Unassigned" }).closest("section");
  expect(group).not.toBeNull();
  expect(within(group as HTMLElement).getByRole("button", { name: "Select Legacy terminal" }))
    .toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "missing-project" })).not.toBeInTheDocument();
});

test("renders unread purpose, latest status, and required action", () => {
  renderSidebar();

  const row = screen.getByRole("button", {
    name: /Select Codex.*Approve the pending change/i,
  });
  expect(row).toHaveAttribute("data-unread", "true");
  expect(row).toHaveTextContent("Waiting");
  expect(row).toHaveTextContent("Implement the API");
  expect(row).toHaveTextContent("Updating the API");
  expect(row).toHaveTextContent("Approve the pending change");
});

test("announces row status, summary, action, and unread state", () => {
  renderSidebar();

  const row = screen.getByRole("button", {
    name: /Select Codex.*Approve the pending change/i,
  });
  expect(row).toHaveAttribute("aria-describedby");
  expect(row).toHaveAccessibleDescription(
    "Status: Waiting. Latest summary: Updating the API. Required action: Approve the pending change. Unread.",
  );
});

test("starts terminal or agent work only through project callbacks", async () => {
  const user = userEvent.setup();
  const { props } = renderSidebar();

  await user.click(
    screen.getByRole("button", { name: `Create terminal in ${project.path}` }),
  );
  await user.click(
    screen.getByRole("button", { name: `Start agent in ${project.path}` }),
  );
  await user.click(screen.getByRole("button", { name: "Add project" }));

  expect(props.onCreateTerminal).toHaveBeenCalledWith(project.id);
  expect(props.onCreateAgent).toHaveBeenCalledWith(project.id);
  expect(props.onAddProject).toHaveBeenCalledOnce();
});

test("does not render project controls when their callbacks are missing", () => {
  renderSidebar({
    onCreateTerminal: undefined,
    onCreateAgent: undefined,
    onAddProject: undefined,
  });

  expect(screen.queryByRole("button", { name: "Add project" })).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: `Create terminal in ${project.path}` }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: `Start agent in ${project.path}` }),
  ).not.toBeInTheDocument();
});

test("keeps selection and deletion as separate row actions", async () => {
  const user = userEvent.setup();
  const onSelectSession = vi.fn();
  const onDelete = vi.fn();
  renderSidebar({ onSelectSession, onDelete });

  const row = screen.getByRole("button", { name: /Select Codex/ });
  await user.click(screen.getByRole("button", { name: "Delete Codex" }));

  expect(onDelete).toHaveBeenCalledWith(agentSession);
  expect(onSelectSession).not.toHaveBeenCalled();

  await user.click(row);
  expect(onSelectSession).toHaveBeenCalledWith(agentSession.id);
});

test("does not render split checkboxes or an Inbox dashboard button", () => {
  renderSidebar();

  expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "Inbox" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
});
