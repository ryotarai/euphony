import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionNavigation } from "./SessionNavigation";
import type { AgentSummary, Project, Session, Settings } from "../types";

function useMobileViewport() {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
}

afterEach(() => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
  });
});

const settings: Settings = {
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
  agentSummaryPrompt: "",
};

const sessions: Session[] = [
  {
    id: "one",
    name: "Codex",
    state: "running",
    cwd: "/Users/ryotarai/work/euphony",
    agent: "codex",
    agentStatus: "running",
    agentTitle: "Implement v0.2",
    createdAt: "2026-07-28T00:00:00Z",
  },
  {
    id: "two",
    name: "Claude",
    state: "exited",
    cwd: "/workspace/website",
    agent: "claude",
    createdAt: "2026-07-28T00:01:00Z",
    exitCode: 0,
  },
  {
    id: "three",
    name: "Terminal",
    state: "running",
    cwd: "/workspace/plain-shell",
    createdAt: "2026-07-28T00:02:00Z",
  },
];

const project: Project = {
  id: "project-euphony",
  path: "/workspace/euphony",
  createdAt: "2026-08-12T00:00:00Z",
};

const projectAgent: Session = {
  ...sessions[0],
  id: "project-agent",
  name: "Codex",
  cwd: project.path,
  projectId: project.id,
  agentTitle: "Implement the sidebar",
};

const projectSummary: AgentSummary = {
  terminalId: projectAgent.id,
  provider: "codex",
  status: "running",
  purpose: "Sidebar fix",
  summary: "Implementing the sidebar",
  generatedAt: "2026-08-12T00:05:00Z",
  unread: true,
};

test("composes terminal navigation from the shadcn sidebar without a monogram", () => {
  render(
    <SessionNavigation
      sessions={sessions}
      selectedIDs={["one"]}
      onSelect={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
    />,
  );

  const navigation = screen.getByLabelText("Terminal sessions");
  expect(navigation.closest('[data-slot="sidebar"]')).toBeInTheDocument();
  expect(screen.queryByText("EU")).not.toBeInTheDocument();
});

test("keeps the legacy mobile title based on session order, not selected ID order", () => {
  useMobileViewport();
  render(
    <SessionNavigation
      sessions={[sessions[1], sessions[0]]}
      selectedIDs={["one", "two"]}
      onSelect={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
    />,
  );

  expect(document.querySelector(".mobile-header")).toHaveTextContent("Claude");
});

test("places Tasks above Agents and opens each workspace dashboard", async () => {
  const onOpenTasks = vi.fn();
  const onOpenAgents = vi.fn();
  const user = userEvent.setup();
  render(
    <SessionNavigation
      sessions={sessions}
      selectedIDs={["one"]}
      onSelect={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
      agentSummaryCount={2}
      taskCount={3}
      onOpenTasks={onOpenTasks}
      onOpenAgents={onOpenAgents}
    />,
  );

  const terminalTree = screen
    .getByLabelText("Terminal sessions")
    .closest('[data-slot="sidebar-content"]') as HTMLElement | null;
  expect(terminalTree).not.toBeNull();
  const tasks = within(terminalTree!).getByRole("button", { name: /Tasks/ });
  const agents = within(terminalTree!).getByRole("button", { name: "Inbox" });
  expect(agents).toHaveTextContent("2");
  expect(tasks).toHaveTextContent("3");
  expect(within(terminalTree!).getAllByRole("button")[0]).toBe(tasks);
  expect(within(terminalTree!).getAllByRole("button")[1]).toBe(agents);

  await user.click(tasks);
  expect(onOpenTasks).toHaveBeenCalledOnce();
  await user.click(agents);
  expect(onOpenAgents).toHaveBeenCalledOnce();
});

test("treats Tasks and Agents as selectable panes with checkboxes", async () => {
  const onOpenTasks = vi.fn();
  const onOpenAgents = vi.fn();
  const user = userEvent.setup();
  render(
    <SessionNavigation
      sessions={sessions}
      selectedIDs={["one"]}
      onSelect={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
      onOpenTasks={onOpenTasks}
      onOpenAgents={onOpenAgents}
    />,
  );

  const tasksCheckbox = screen.getByRole("checkbox", { name: "Include Tasks in split" });
  const agentsCheckbox = screen.getByRole("checkbox", { name: "Include Inbox in split" });
  expect(tasksCheckbox).toHaveAttribute("aria-checked", "false");
  expect(agentsCheckbox).toHaveAttribute("aria-checked", "false");

  await user.click(tasksCheckbox);
  expect(onOpenTasks).toHaveBeenCalledWith(true);
  await user.click(screen.getByRole("button", { name: "Tasks" }));
  expect(onOpenTasks).toHaveBeenCalledWith(false);

  await user.click(agentsCheckbox);
  expect(onOpenAgents).toHaveBeenCalledWith(true);
});

test("renders the project tree without Inbox or split controls", () => {
  render(
    <SessionNavigation
      projects={[project]}
      sessions={[projectAgent]}
      agentSummaries={[projectSummary]}
      selectedIDs={[projectAgent.id]}
      selectedID={projectAgent.id}
      onSelect={() => undefined}
      onSelectSession={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
      onCreateTerminal={() => undefined}
      onCreateAgent={() => undefined}
      onAddProject={() => undefined}
    />,
  );

  expect(screen.getByRole("heading", { name: project.path })).toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: /Include .* in split/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Inbox" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
});

test("renders the generated session purpose without provider or status text", () => {
  const { container } = render(
    <SessionNavigation
      projects={[project]}
      sessions={[projectAgent]}
      agentSummaries={[projectSummary]}
      selectedIDs={[projectAgent.id]}
      selectedID={projectAgent.id}
      onSelect={() => undefined}
      onSelectSession={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
      onCreateTerminal={() => undefined}
      onCreateAgent={() => undefined}
      onAddProject={() => undefined}
    />,
  );

  const row = container.querySelector(".project-session-row");
  expect(row).not.toBeNull();
  expect(row?.querySelector(".project-session-name")).toBeNull();
  expect(row?.querySelector(".project-session-purpose")).toHaveTextContent("Sidebar fix");
  expect(row?.querySelector(".project-session-status")).toBeNull();
  expect(screen.queryByText("Running")).not.toBeInTheDocument();
  expect(screen.getByText(projectSummary.summary)).toBeVisible();
});

test("selecting a project session closes the mobile drawer", async () => {
  useMobileViewport();
  const onSelectSession = vi.fn();
  const user = userEvent.setup();
  render(
    <SessionNavigation
      projects={[project]}
      sessions={[projectAgent]}
      agentSummaries={[projectSummary]}
      selectedIDs={[projectAgent.id]}
      selectedID={projectAgent.id}
      onSelect={() => undefined}
      onSelectSession={onSelectSession}
      onCreate={() => undefined}
      onDelete={() => undefined}
      onCreateTerminal={() => undefined}
      onCreateAgent={() => undefined}
      onAddProject={() => undefined}
    />,
  );

  await user.click(screen.getByRole("button", { name: "Open terminal menu" }));
  const drawer = screen.getByRole("dialog", { name: "Terminal menu" });
  await user.click(
    within(drawer).getByRole("button", { name: /Select Codex/ }),
  );

  expect(onSelectSession).toHaveBeenCalledWith(projectAgent.id);
  expect(screen.queryByRole("dialog", { name: "Terminal menu" })).not.toBeInTheDocument();
});

test("project actions close the mobile drawer", async () => {
  useMobileViewport();
  const onCreateTerminal = vi.fn();
  const user = userEvent.setup();
  render(
    <SessionNavigation
      projects={[project]}
      sessions={[projectAgent]}
      agentSummaries={[projectSummary]}
      selectedIDs={[projectAgent.id]}
      selectedID={projectAgent.id}
      onSelect={() => undefined}
      onSelectSession={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
      onCreateTerminal={onCreateTerminal}
      onCreateAgent={() => undefined}
      onAddProject={() => undefined}
    />,
  );

  await user.click(screen.getByRole("button", { name: "Open terminal menu" }));
  const drawer = screen.getByRole("dialog", { name: "Terminal menu" });
  await user.click(
    within(drawer).getByRole("button", {
      name: `Create terminal in ${project.path}`,
    }),
  );

  expect(onCreateTerminal).toHaveBeenCalledWith(project.id);
  expect(screen.queryByRole("dialog", { name: "Terminal menu" })).not.toBeInTheDocument();
});

test("reports whether more terminal tree content remains below", () => {
  render(
    <SessionNavigation
      sessions={sessions}
      selectedIDs={["one"]}
      onSelect={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
    />,
  );

  const terminalTree = screen
    .getByLabelText("Terminal sessions")
    .closest('[data-slot="sidebar-content"]');
  expect(terminalTree).not.toBeNull();
  Object.defineProperties(terminalTree!, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, value: 500 },
    scrollTop: { configurable: true, value: 0, writable: true },
  });

  fireEvent.scroll(terminalTree!);
  expect(terminalTree).toHaveAttribute("data-overflow-bottom", "true");

  terminalTree!.scrollTop = 300;
  fireEvent.scroll(terminalTree!);
  expect(terminalTree).not.toHaveAttribute("data-overflow-bottom");
});

test("opens and closes the mobile drawer with keyboard focus restoration", async () => {
  useMobileViewport();
  const user = userEvent.setup();
  render(
    <SessionNavigation
      sessions={sessions}
      selectedIDs={["one"]}
      onSelect={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
    />,
  );

  const menu = screen.getByRole("button", { name: "Open terminal menu" });
  await user.click(menu);
  expect(screen.getByRole("dialog", { name: "Terminal menu" })).toBeVisible();

  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Terminal menu" })).not.toBeInTheDocument();
  expect(menu).toHaveFocus();
});

test("selecting a mobile session closes the drawer", async () => {
  useMobileViewport();
  const onSelect = vi.fn();
  const user = userEvent.setup();
  render(
    <SessionNavigation
      sessions={sessions}
      selectedIDs={["one"]}
      onSelect={onSelect}
      onCreate={() => undefined}
      onDelete={() => undefined}
    />,
  );

  await user.click(screen.getByRole("button", { name: "Open terminal menu" }));
  const drawer = screen.getByRole("dialog", { name: "Terminal menu" });
  await user.click(within(drawer).getByRole("button", { name: "Select Claude" }));

  expect(onSelect).toHaveBeenCalledWith("two", false);
  expect(screen.queryByRole("dialog", { name: "Terminal menu" })).not.toBeInTheDocument();
});

test("opening settings from mobile closes the terminal drawer", async () => {
  useMobileViewport();
  const onOpenSettings = vi.fn();
  const user = userEvent.setup();
  render(
    <SessionNavigation
      sessions={sessions}
      selectedIDs={["one"]}
      onSelect={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
      onOpenSettings={onOpenSettings}
    />,
  );

  await user.click(screen.getByRole("button", { name: "Open terminal menu" }));
  const drawer = screen.getByRole("dialog", { name: "Terminal menu" });
  await user.click(within(drawer).getByRole("button", { name: "Open settings" }));

  expect(onOpenSettings).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog", { name: "Terminal menu" })).not.toBeInTheDocument();
});

test("renders a cwd-first tree with lifecycle icons and trailing attention", () => {
  const grouped: Session[] = [
    {
      ...sessions[0],
      cwd: "/workspace/project",
      agentStatus: "running",
    },
    {
      ...sessions[0],
      id: "starting",
      name: "Starting",
      state: "starting",
      cwd: "/workspace/project",
      agentStatus: undefined,
      agentTitle: "",
    },
    {
      ...sessions[1],
      id: "blocked",
      name: "Permission request",
      cwd: "/workspace/project",
      agent: "codex",
      agentStatus: "blocked",
      agentTitle: "Permission request",
      needsAttention: true,
    },
    { ...sessions[2], cwd: "/workspace/shell" },
  ];
  render(
    <SessionNavigation
      sessions={grouped}
      selectedIDs={["one"]}
      onSelect={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
    />,
  );

  expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
    "/workspace/project",
    "/workspace/shell",
  ]);
  expect(screen.queryByRole("heading", { name: "Running" })).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: /Show all/ })).not.toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Running" })).toHaveClass("session-status-running");
  expect(screen.getByRole("img", { name: "Running" })).toHaveClass("lucide-circle-dot");
  expect(screen.getByRole("img", { name: "Starting" })).toHaveClass("lucide-clock-3");
  expect(screen.getByRole("img", { name: "Blocked" })).toHaveTextContent("🚫");

  const attentionButton = screen.getByRole("button", {
    name: "Select Permission request",
  });
  const attentionDot = attentionButton.querySelector(".attention-dot");
  expect(attentionDot).toBeVisible();
  expect(attentionDot).toHaveAttribute("aria-hidden", "true");
  expect(attentionButton).toHaveAccessibleDescription("Needs attention");
  expect(screen.getByRole("button", { name: "Select Terminal" }))
    .not.toHaveAccessibleDescription("Needs attention");
});

test("orders terminal rows by attention, lifecycle priority, and last update", () => {
  const makeSession = (
    id: string,
    name: string,
    agentStatus: string | undefined,
    updatedAt: string,
    needsAttention = false,
  ): Session => ({
    ...sessions[0],
    id,
    name,
    agentStatus,
    agentTitle: "",
    updatedAt,
    needsAttention: needsAttention || undefined,
  });
  const ordered = [
    makeSession("old-terminal", "Terminal", undefined, "2026-08-10T00:00:00Z"),
    makeSession("old-waiting", "Old waiting", "waiting", "2026-08-10T00:01:00Z"),
    makeSession("new-waiting", "New waiting", "waiting", "2026-08-10T00:09:00Z"),
    makeSession("old-running", "Old running", "running", "2026-08-10T00:02:00Z"),
    makeSession("new-running", "New running", "running", "2026-08-10T00:08:00Z"),
    makeSession("old-blocked", "Old blocked", "blocked", "2026-08-10T00:03:00Z"),
    makeSession("new-blocked", "New blocked", "blocked", "2026-08-10T00:07:00Z"),
    makeSession(
      "old-attention",
      "Old attention",
      "waiting",
      "2026-08-10T00:04:00Z",
      true,
    ),
    makeSession(
      "new-attention",
      "New attention",
      "waiting",
      "2026-08-10T00:06:00Z",
      true,
    ),
  ];
  render(
    <SessionNavigation
      sessions={ordered}
      selectedIDs={[]}
      onSelect={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
    />,
  );

  const labels = screen
    .getByLabelText("Terminal sessions")
    .querySelectorAll<HTMLButtonElement>(".session-select");
  expect([...labels].map((button) => button.getAttribute("aria-label"))).toEqual([
    "Select New attention",
    "Select Old attention",
    "Select New blocked",
    "Select Old blocked",
    "Select New running",
    "Select Old running",
    "Select New waiting",
    "Select Old waiting",
    "Select Terminal",
  ]);
});

test("groups linked worktrees under their main Git directory", async () => {
  const onCreate = vi.fn();
  const user = userEvent.setup();
  const worktreeSessions: Session[] = [
    {
      ...sessions[0],
      id: "worktree-one",
      cwd: "/repo/.worktrees/one",
      repoRoot: "/repo",
    },
    {
      ...sessions[1],
      id: "worktree-two",
      cwd: "/repo/.worktrees/two",
      repoRoot: "/repo",
    },
  ];

  render(
    <SessionNavigation
      sessions={worktreeSessions}
      selectedIDs={[]}
      onSelect={() => undefined}
      onCreate={onCreate}
      onDelete={() => undefined}
    />,
  );

  expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
    "/repo",
  ]);

  await user.click(screen.getByRole("button", { name: "Create terminal in /repo" }));
  expect(onCreate).toHaveBeenCalledWith("/repo");
});

test("labels rows with agent titles, process names, and fallback names", () => {
  const labeled = [
    {
      ...sessions[0],
      id: "title",
      cwd: "/workspace/labels",
      agentTitle: "Review changes",
      processName: "codex",
    },
    {
      ...sessions[1],
      id: "process",
      cwd: "/workspace/labels",
      agentTitle: "   ",
      processName: "ps",
    },
    {
      ...sessions[2],
      id: "fallback",
      cwd: "/workspace/labels",
      name: "Fallback terminal",
      processName: "",
    },
  ];
  render(
    <SessionNavigation
      sessions={labeled}
      selectedIDs={[]}
      onSelect={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
    />,
  );

  expect(screen.getByText("Review changes")).toBeInTheDocument();
  expect(screen.getByText("ps")).toBeInTheDocument();
  expect(screen.getByText("Fallback terminal")).toBeInTheDocument();
  expect(screen.queryByRole("img", { name: "Claude" })).not.toBeInTheDocument();
  expect(screen.queryByRole("img", { name: "Codex" })).not.toBeInTheDocument();
});

test("prefers a custom terminal name over dynamic agent labels", () => {
  render(
    <SessionNavigation
      sessions={[{
        ...sessions[0],
        id: "renamed",
        name: "Personal terminal",
        customName: true,
        agentTitle: "Current task",
        processName: "codex",
      }]}
      selectedIDs={[]}
      onSelect={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
    />,
  );

  expect(screen.getByText("Personal terminal")).toBeInTheDocument();
  expect(screen.queryByText("Current task")).not.toBeInTheDocument();
});

test("creates a terminal from the cwd heading", async () => {
  const onCreate = vi.fn();
  const user = userEvent.setup();
  render(
    <SessionNavigation
      sessions={sessions}
      selectedIDs={["one"]}
      onSelect={() => undefined}
      onCreate={onCreate}
      onDelete={() => undefined}
    />,
  );

  await user.click(
    screen.getByRole("button", { name: "Create terminal in ~/work/euphony" }),
  );
  expect(onCreate).toHaveBeenCalledWith("/Users/ryotarai/work/euphony");
});

test("uses the canonical macOS temporary-directory label", async () => {
  const onCreate = vi.fn();
  const user = userEvent.setup();
  render(
    <SessionNavigation
      sessions={[{ ...sessions[0], cwd: "/private/tmp" }]}
      selectedIDs={[]}
      onSelect={() => undefined}
      onCreate={onCreate}
      onDelete={() => undefined}
    />,
  );

  await user.click(
    screen.getByRole("button", { name: "Create terminal in /tmp" }),
  );
  expect(onCreate).toHaveBeenCalledWith("/tmp");
});

test("forwards Alt-clicks, but not Shift-clicks, on terminal checkboxes as pin requests", () => {
  const onSelect = vi.fn();
  render(
    <SessionNavigation
      sessions={sessions}
      selectedIDs={["one"]}
      onSelect={onSelect}
      onCreate={() => undefined}
      onDelete={() => undefined}
    />,
  );

  const terminalCheckbox = screen.getByRole("checkbox", {
    name: "Include Terminal in split",
  });
  expect(terminalCheckbox).toHaveAttribute("title", "Option-click to pin");

  fireEvent.click(terminalCheckbox, { altKey: true });
  expect(onSelect).toHaveBeenCalledWith("three", true, true);

  onSelect.mockClear();
  fireEvent.click(terminalCheckbox, { shiftKey: true });
  expect(onSelect).toHaveBeenCalledWith("three", true, false);
});

test("marks pinned terminal checkboxes and explains direct removal", () => {
  render(
    <SessionNavigation
      sessions={sessions}
      selectedIDs={["one", "three"]}
      pinnedIDs={["three"]}
      onSelect={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
    />,
  );

  expect(
    screen.getByRole("checkbox", { name: "Include Terminal in split" }),
  ).toHaveAttribute("data-pinned", "true");
  expect(screen.getByTitle("Pinned — click to remove")).toBeVisible();
});

test("collapses and restores the desktop sidebar", async () => {
  const onSettingsChange = vi.fn();
  const user = userEvent.setup();
  render(
    <SessionNavigation
      sessions={sessions}
      selectedIDs={["one"]}
      onSelect={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
      settings={settings}
      onSettingsChange={onSettingsChange}
    />,
  );

  await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(onSettingsChange).toHaveBeenCalledWith({ ...settings, sidebarCollapsed: true });

  fireEvent.keyDown(window, { key: "b", metaKey: true });
  expect(screen.getByRole("button", { name: "Collapse sidebar" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(onSettingsChange).toHaveBeenLastCalledWith({
    ...settings,
    sidebarCollapsed: false,
  });

  fireEvent.keyDown(window, { key: "b", ctrlKey: true });
  expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
});

test("uses a compact 256px sidebar by default", () => {
  render(
    <SessionNavigation
      sessions={sessions}
      selectedIDs={["one"]}
      onSelect={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
    />,
  );

  expect(
    screen.getByLabelText("Terminal sessions").closest('[data-slot="sidebar-wrapper"]'),
  ).toHaveStyle({ "--sidebar-width": "256px" });
});

test("resizes the desktop sidebar by dragging its separator", () => {
  const onSettingsChange = vi.fn();
  render(
    <SessionNavigation
      sessions={sessions}
      selectedIDs={["one"]}
      onSelect={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
      settings={settings}
      onSettingsChange={onSettingsChange}
    />,
  );

  const separator = screen.getByRole("separator", { name: "Resize sidebar" });
  fireEvent.pointerDown(separator, { clientX: 304, pointerId: 1 });
  fireEvent.pointerMove(document, { clientX: 229.96875, pointerId: 1 });
  fireEvent.pointerUp(document, { clientX: 229.96875, pointerId: 1 });

  expect(separator).toHaveAttribute("aria-valuenow", "230");
  expect(onSettingsChange).toHaveBeenCalledWith({ ...settings, sidebarWidth: 230 });
});

test("opens settings from the desktop sidebar", async () => {
  const onOpenSettings = vi.fn();
  const user = userEvent.setup();
  render(
    <SessionNavigation
      sessions={sessions}
      selectedIDs={["one"]}
      onSelect={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
      settings={settings}
      onOpenSettings={onOpenSettings}
    />,
  );

  await user.click(screen.getByRole("button", { name: "Open settings" }));
  expect(onOpenSettings).toHaveBeenCalledOnce();
});
