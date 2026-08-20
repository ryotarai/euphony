import { fireEvent, render, screen, within } from "@testing-library/react";
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
  purpose: "API permissions",
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

  expect(screen.getByRole("navigation", { name: "Projects and sessions" }))
    .toHaveAttribute("data-pane-name", "agent-list");
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

test("renders the generated purpose and required action without status text", () => {
  renderSidebar();

  const row = screen.getByRole("button", {
    name: /Select Codex.*Approve the pending change/i,
  });
  expect(row).toHaveAttribute("data-unread", "true");
  expect(row).not.toHaveTextContent("Waiting");
  expect(row).toHaveTextContent("API permissions");
  expect(row).toHaveTextContent("Updating the API");
  expect(row).toHaveTextContent("Approve the pending change");
});

test("labels a session with no purpose or summary as New session", () => {
  renderSidebar({
    sessions: [{ ...terminalSession, id: "new-session", name: "Shell" }],
    agentSummaries: [],
  });

  expect(screen.getByRole("button", { name: "Select Shell" }))
    .toHaveTextContent("New session");
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

test("forwards session hover and focus events from project rows", () => {
  const onSessionPointerEnter = vi.fn();
  const onSessionPointerLeave = vi.fn();
  const onSessionFocus = vi.fn();
  const onSessionBlur = vi.fn();
  renderSidebar({
    onSessionPointerEnter,
    onSessionPointerLeave,
    onSessionFocus,
    onSessionBlur,
  });

  const select = screen.getByRole("button", {
    name: /Select Codex.*Approve the pending change/i,
  });
  const row = select.closest(".project-session-row");
  expect(row).not.toBeNull();

  fireEvent.pointerEnter(row!, { clientX: 120, clientY: 180 });
  fireEvent.pointerLeave(row!);
  fireEvent.focus(select);
  fireEvent.blur(select);

  expect(onSessionPointerEnter).toHaveBeenCalledWith(agentSession, expect.any(Object));
  expect(onSessionPointerLeave).toHaveBeenCalledWith(agentSession.id);
  expect(onSessionFocus).toHaveBeenCalledWith(agentSession, expect.any(Object));
  expect(onSessionBlur).toHaveBeenCalledWith(agentSession.id);
});

test("preserves attention state on project rows", () => {
  renderSidebar({
    sessions: [{ ...agentSession, needsAttention: true }],
  });

  const row = screen.getByRole("button", { name: /Select Codex/ });
  expect(row).toHaveAttribute("aria-describedby");
  expect(row).toHaveAccessibleDescription(/Needs attention/);
  expect(row.querySelector(".attention-dot")).toHaveAttribute("aria-hidden", "true");
  expect(row.closest(".project-session-row")).toHaveAttribute("data-attention", "true");
});

test("starts terminal or agent work only through project callbacks", async () => {
  const user = userEvent.setup();
  const { props } = renderSidebar();

  const terminalButton = screen.getByRole("button", {
    name: `Create terminal in ${project.path}`,
  });
  expect(terminalButton.querySelector("svg")).toHaveClass("lucide-square-terminal");
  await user.click(terminalButton);
  await user.click(
    screen.getByRole("button", { name: `Start agent in ${project.path}` }),
  );
  await user.click(screen.getByRole("button", { name: "Add project" }));

  expect(props.onCreateTerminal).toHaveBeenCalledWith(project.id);
  expect(props.onCreateAgent).toHaveBeenCalledWith(project.id);
  expect(props.onAddProject).toHaveBeenCalledOnce();
});

test("opens a project-filtered Kanban view from the project header", async () => {
  const user = userEvent.setup();
  const onOpenKanban = vi.fn();
  renderSidebar({ onOpenKanban });

  await user.click(screen.getByRole("button", {
    name: `Open Kanban for ${project.path}`,
  }));

  expect(onOpenKanban).toHaveBeenCalledWith(project.path);
});

test("right-aligns project paths and truncates their left side", () => {
  const { container } = renderSidebar({
    projects: [{ ...project, path: "/Users/ryotarai/work/euphony/very-long-project" }],
  });

  const heading = within(container).getByRole("heading", {
    name: "/Users/ryotarai/work/euphony/very-long-project",
  });
  expect(heading).toHaveClass("project-sidebar-path");
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

test("archives agent sessions and deletes bare terminals from context menus", async () => {
  const user = userEvent.setup();
  const onSelectSession = vi.fn();
  const onArchive = vi.fn();
  const onDelete = vi.fn();
  renderSidebar({ onSelectSession, onArchive, onDelete });

  const row = screen.getByRole("button", { name: /Select Codex/ });
  expect(screen.queryByRole("button", { name: "Delete Codex" })).not.toBeInTheDocument();
  fireEvent.contextMenu(row);
  const menu = screen.getByRole("menu", { name: "Actions for Codex" });
  await user.click(within(menu).getByRole("menuitem", { name: "Archive" }));

  expect(onArchive).toHaveBeenCalledWith(agentSession);
  expect(onDelete).not.toHaveBeenCalled();
  expect(onSelectSession).not.toHaveBeenCalled();

  const terminalRow = screen.getByRole("button", { name: "Select Shell" });
  fireEvent.contextMenu(terminalRow);
  const terminalMenu = screen.getByRole("menu", { name: "Actions for Shell" });
  await user.click(within(terminalMenu).getByRole("menuitem", { name: "Delete" }));
  expect(onDelete).toHaveBeenCalledWith(terminalSession);

  await user.click(row);
  expect(onSelectSession).toHaveBeenCalledWith(agentSession.id);
});

test("does not render split checkboxes or an Inbox dashboard button", () => {
  renderSidebar();

  expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "Inbox" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
});
