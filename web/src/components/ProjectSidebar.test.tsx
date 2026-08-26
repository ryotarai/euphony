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
  customName: true,
  state: "running",
  cwd: project.path,
  projectId: project.id,
  createdAt: "2026-08-12T00:03:00Z",
};

const archivedSession: Session = {
  ...agentSession,
  id: "archived-agent",
  name: "Archived rollout",
  agentTitle: "Archived rollout",
  agentSessionId: "archived-session",
  state: "exited",
  archived: true,
  createdAt: "2026-08-11T00:00:00Z",
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
  expect(screen.getByRole("heading", { name: "api" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "empty" })).toBeVisible();
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

test("keeps the actual coding agent identity when summary provider differs", () => {
  renderSidebar({
    sessions: [{ ...agentSession, agent: "claude" }],
    agentSummaries: [{ ...unreadSummary, provider: "codex" }],
  });

  expect(screen.getByRole("button", { name: /Select Claude/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Select Codex/ })).not.toBeInTheDocument();
});

test("hides completion notices that are not a human decision", () => {
  const completedNotice: AgentSummary = {
    ...unreadSummary,
    terminalId: "completed-notice",
    purpose: "Release notes",
    summary: "The release notes are complete.",
    action: "Work completed. Please check it.",
  };
  renderSidebar({
    sessions: [{ ...agentSession, id: "completed-notice" }],
    agentSummaries: [completedNotice],
    selectedID: "completed-notice",
  });

  const row = screen.getByRole("button", { name: "Select Codex — Release notes" });
  expect(row).toHaveTextContent("Release notes");
  expect(row).not.toHaveTextContent("Work completed. Please check it.");
  expect(row).toHaveAccessibleDescription(
    "Status: Waiting. Latest summary: The release notes are complete. Required action: None. Unread.",
  );
});

test("filters sessions incrementally across purpose, directory, and project", async () => {
  const user = userEvent.setup();
  const otherProject: Project = {
    id: "project-web",
    path: "/workspace/web",
    createdAt: "2026-08-12T00:01:00Z",
  };
  const otherSession: Session = {
    ...terminalSession,
    id: "terminal-web",
    name: "Shell",
    cwd: otherProject.path,
    projectId: otherProject.id,
  };
  renderSidebar({
    projects: [project, otherProject],
    sessions: [agentSession, otherSession],
    agentSummaries: [{ ...unreadSummary, purpose: "API permissions" }],
  });

  const filter = screen.getByRole("searchbox", { name: "Filter sessions" });
  expect(screen.getByRole("button", { name: "Select Codex — API permissions — Approve the pending change" }))
    .toBeVisible();
  expect(screen.getByRole("button", { name: "Select Shell" })).toBeVisible();

  await user.type(filter, "permissions");

  expect(screen.getByRole("button", { name: /Select Codex.*Approve the pending change/ }))
    .toBeVisible();
  expect(screen.queryByRole("button", { name: "Select Shell" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: otherProject.path })).not.toBeInTheDocument();
  expect(screen.getByText("1 of 2 sessions")).toBeVisible();

  await user.clear(filter);
  await user.type(filter, "does not exist");
  expect(screen.getByText("No sessions match your filter.")).toBeVisible();
});

test("shows archived sessions only after the sidebar asks for them", async () => {
  const user = userEvent.setup();
  const onShowArchived = vi.fn();
  const onSelectArchivedSession = vi.fn();
  const { rerender } = renderSidebar({
    sessions: [agentSession],
    onShowArchived,
    archivedVisible: false,
  });

  expect(screen.getByRole("button", { name: "Show archived" })).toBeVisible();
  expect(screen.queryByRole("button", { name: /Archived rollout/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Show archived" }));
  expect(onShowArchived).toHaveBeenCalledOnce();

  rerender(
    <ProjectSidebar
      projects={[project]}
      sessions={[agentSession, archivedSession]}
      agentSummaries={[unreadSummary]}
      selectedID={agentSession.id}
      onSelectSession={vi.fn()}
      onSelectArchivedSession={onSelectArchivedSession}
      archivedVisible
      onHideArchived={vi.fn()}
    />,
  );
  const archivedRow = screen.getByRole("button", { name: /Select Codex.*Archived rollout/ });
  expect(archivedRow.closest(".project-session-row")).toHaveAttribute("data-state", "archived");
  expect(archivedRow).toHaveTextContent("Archived");
  await user.click(archivedRow);
  expect(onSelectArchivedSession).toHaveBeenCalledWith(archivedSession);
});

test("labels a manually named terminal with no purpose or summary by its name", () => {
  renderSidebar({
    sessions: [{ ...terminalSession, id: "new-session", name: "Shell" }],
    agentSummaries: [],
  });

  expect(screen.getByRole("button", { name: "Select Shell" }))
    .toHaveTextContent("Shell");
});

test("preserves legacy non-default terminal names without a custom-name flag", () => {
  renderSidebar({
    sessions: [{ ...terminalSession, id: "legacy-shell", customName: false }],
    agentSummaries: [],
  });

  expect(screen.getByRole("button", { name: "Select Shell" })).toBeInTheDocument();
});

test("gives generated terminals stable project-scoped identities", () => {
  const first: Session = {
    ...terminalSession,
    id: "generated-terminal-1",
    name: "Terminal",
    customName: false,
    processName: "zsh",
    createdAt: "2026-08-12T00:03:00Z",
  };
  const second: Session = {
    ...first,
    id: "generated-terminal-2",
    createdAt: "2026-08-12T00:04:00Z",
  };
  const props: React.ComponentProps<typeof ProjectSidebar> = {
    projects: [project],
    sessions: [first, second],
    agentSummaries: [],
    selectedID: first.id,
    onSelectSession: vi.fn(),
  };
  const { rerender } = render(<ProjectSidebar {...props} />);

  const group = screen.getByRole("heading", { name: "api" }).closest("section");
  expect(group).not.toBeNull();
  expect(
    within(group as HTMLElement).getAllByRole("button").map((button) => button.getAttribute("aria-label")),
  ).toEqual(["Select Terminal 1", "Select Terminal 2"]);
  expect(within(group as HTMLElement).getByRole("button", { name: "Select Terminal 1" }))
    .toHaveTextContent("zsh");

  rerender(<ProjectSidebar {...props} sessions={[second, first]} selectedID={second.id} />);

  expect(screen.getByRole("button", { name: "Select Terminal 2" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  expect(screen.getByRole("button", { name: "Select Terminal 1" })).toBeInTheDocument();
});

test("filters generated terminal identities as they appear in the sidebar", async () => {
  const user = userEvent.setup();
  const first: Session = {
    ...terminalSession,
    id: "generated-terminal-1",
    name: "Terminal",
    customName: false,
    processName: "zsh",
  };
  const second: Session = {
    ...first,
    id: "generated-terminal-2",
  };

  renderSidebar({
    sessions: [first, second],
    agentSummaries: [],
    selectedID: second.id,
  });

  await user.type(screen.getByRole("searchbox", { name: "Filter sessions" }), "Terminal 2");

  expect(screen.getByRole("button", { name: "Select Terminal 2" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Select Terminal 1" })).not.toBeInTheDocument();
  expect(screen.getByText("1 of 2 sessions")).toBeVisible();
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

test("shows the project directory name while retaining the full path as a tooltip", () => {
  const { container } = renderSidebar({
    projects: [{ ...project, path: "/Users/ryotarai/work/euphony/very-long-project" }],
  });

  const heading = within(container).getByRole("heading", {
    name: "very-long-project",
  });
  expect(heading).toHaveClass("project-sidebar-path");
  expect(heading).toHaveAttribute(
    "title",
    "/Users/ryotarai/work/euphony/very-long-project",
  );
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

test("keeps project and session order stable when activity changes", () => {
  const recentProject: Project = {
    id: "project-recent",
    path: "/workspace/recent",
    createdAt: "2026-08-10T00:00:00Z",
  };
  const createdAtFallbackProject: Project = {
    id: "project-created-at-fallback",
    path: "/workspace/created-at-fallback",
    createdAt: "2026-08-11T00:00:00Z",
  };
  const olderProject: Project = {
    id: "project-older",
    path: "/workspace/older",
    createdAt: "2026-08-09T00:00:00Z",
  };
  const attentionSession: Session = {
    id: "recent-attention",
    name: "Attention session",
    state: "running",
    cwd: recentProject.path,
    projectId: recentProject.id,
    needsAttention: true,
    createdAt: "2026-08-20T00:00:00Z",
    updatedAt: "2026-08-20T01:00:00Z",
  };
  const newestSession: Session = {
    id: "recent-newest",
    name: "Newest session",
    state: "exited",
    cwd: recentProject.path,
    projectId: recentProject.id,
    createdAt: "2026-08-21T00:00:00Z",
    updatedAt: "2026-08-25T00:00:00Z",
  };
  const fallbackSession: Session = {
    id: "created-at-fallback-session",
    name: "Created at fallback",
    state: "exited",
    cwd: createdAtFallbackProject.path,
    projectId: createdAtFallbackProject.id,
    createdAt: "2026-08-24T00:00:00Z",
  };
  const olderSession: Session = {
    id: "older-session",
    name: "Older session",
    state: "exited",
    cwd: olderProject.path,
    projectId: olderProject.id,
    createdAt: "2026-08-18T00:00:00Z",
    updatedAt: "2026-08-23T00:00:00Z",
  };
  const onSelectSession = vi.fn();

  renderSidebar({
    projects: [olderProject, createdAtFallbackProject, recentProject],
    sessions: [attentionSession, newestSession, fallbackSession, olderSession],
    agentSummaries: [],
    selectedID: newestSession.id,
    onSelectSession,
  });

  const navigation = screen.getByRole("navigation", {
    name: "Projects and sessions",
  });
  expect(
    within(navigation)
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent),
  ).toEqual([
    "older",
    "created-at-fallback",
    "recent",
  ]);

  const recentSection = screen
    .getByRole("heading", { name: "recent" })
    .closest("section") as HTMLElement;
  expect(
    Array.from(recentSection.querySelectorAll(".project-session-select")).map(
      (button) => button.getAttribute("aria-label"),
    ),
  ).toEqual(["Select Attention session", "Select Newest session"]);

  const selectedButton = within(recentSection).getByRole("button", {
    name: "Select Newest session",
  });
  expect(selectedButton).toHaveAttribute("aria-pressed", "true");
  expect(selectedButton).toHaveAttribute("aria-current", "true");
  fireEvent.click(selectedButton);
  expect(onSelectSession).toHaveBeenCalledWith(newestSession.id);
});

test("preserves project input order and keeps Unassigned last", () => {
  const emptyProjectInOrder: Project = {
    id: "project-empty-in-order",
    path: "/workspace/empty-in-order",
    createdAt: "2026-08-01T00:00:00Z",
  };
  const tieSecondProject: Project = {
    id: "project-tie-second",
    path: "/workspace/tie-second",
    createdAt: "2026-08-02T00:00:00Z",
  };
  const invalidProject: Project = {
    id: "project-invalid",
    path: "/workspace/invalid",
    createdAt: "2026-08-03T00:00:00Z",
  };
  const validProject: Project = {
    id: "project-valid",
    path: "/workspace/valid",
    createdAt: "2026-08-04T00:00:00Z",
  };
  const tieFirstProject: Project = {
    id: "project-tie-first",
    path: "/workspace/tie-first",
    createdAt: "2026-08-05T00:00:00Z",
  };
  const sessionFor = (
    id: string,
    name: string,
    projectId: string,
    updatedAt: string,
  ): Session => ({
    id,
    name,
    state: "exited",
    cwd: `/workspace/${id}`,
    projectId,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt,
  });
  const unassignedAttention: Session = {
    id: "unassigned-attention",
    name: "Unassigned attention",
    state: "running",
    cwd: "/workspace/unassigned",
    projectId: "unknown-project",
    needsAttention: true,
    createdAt: "2026-08-20T00:00:00Z",
    updatedAt: "2026-08-20T00:00:00Z",
  };
  const unassignedNewest: Session = {
    id: "unassigned-newest",
    name: "Unassigned newest",
    state: "exited",
    cwd: "/workspace/unassigned",
    projectId: "another-unknown-project",
    createdAt: "2026-08-21T00:00:00Z",
    updatedAt: "2026-08-26T00:00:00Z",
  };

  renderSidebar({
    projects: [
      emptyProjectInOrder,
      tieSecondProject,
      invalidProject,
      validProject,
      tieFirstProject,
    ],
    sessions: [
      sessionFor(
        "tie-second-session",
        "Tie second session",
        tieSecondProject.id,
        "2026-08-24T00:00:00Z",
      ),
      sessionFor(
        "invalid-session",
        "Invalid session",
        invalidProject.id,
        "not-a-date",
      ),
      sessionFor(
        "valid-session",
        "Valid session",
        validProject.id,
        "2026-08-25T00:00:00Z",
      ),
      sessionFor(
        "tie-first-session",
        "Tie first session",
        tieFirstProject.id,
        "2026-08-24T00:00:00Z",
      ),
      unassignedAttention,
      unassignedNewest,
    ],
    agentSummaries: [],
  });

  const navigation = screen.getByRole("navigation", {
    name: "Projects and sessions",
  });
  expect(
    within(navigation)
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent),
  ).toEqual([
    "empty-in-order",
    "tie-second",
    "invalid",
    "valid",
    "tie-first",
    "Unassigned",
  ]);

  const groups = Array.from(
    navigation.querySelectorAll(".project-sidebar-group"),
  );
  const unassignedSection = groups.at(-1) as HTMLElement;
  expect(unassignedSection).toHaveAttribute("data-project-id", "unassigned");
  expect(
    Array.from(
      unassignedSection.querySelectorAll(".project-session-select"),
    ).map((button) => button.getAttribute("aria-label")),
  ).toEqual(["Select Unassigned attention", "Select Unassigned newest"]);
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

test("keeps Delete for a bare terminal even when a stale summary is present", async () => {
  const user = userEvent.setup();
  const onArchive = vi.fn();
  const onDelete = vi.fn();
  renderSidebar({
    sessions: [terminalSession],
    agentSummaries: [{ ...unreadSummary, terminalId: terminalSession.id }],
    selectedID: terminalSession.id,
    onArchive,
    onDelete,
  });

  const row = within(screen.getByRole("listitem")).getByRole("button");
  fireEvent.contextMenu(row);
  const menu = screen.getByRole("menu", { name: "Actions for Shell" });
  await user.click(within(menu).getByRole("menuitem", { name: "Delete" }));

  expect(onDelete).toHaveBeenCalledWith(terminalSession);
  expect(onArchive).not.toHaveBeenCalled();
});

test("does not render split checkboxes or an Inbox dashboard button", () => {
  renderSidebar();

  expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "Inbox" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
});
