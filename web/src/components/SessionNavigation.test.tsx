import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionNavigation } from "./SessionNavigation";
import type { Session, Settings } from "../types";

const settings: Settings = {
  prefix: "Ctrl+B",
  sidebarWidth: 304,
  sidebarCollapsed: false,
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

test("opens and closes the mobile drawer with keyboard focus restoration", async () => {
  const user = userEvent.setup();
  render(
    <SessionNavigation
      sessions={sessions}
      selectedIDs={["one"]}
      statusFilters={[]}
      onSelect={() => undefined}
      onStatusFilter={() => undefined}
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
  const onSelect = vi.fn();
  const user = userEvent.setup();
  render(
    <SessionNavigation
      sessions={sessions}
      selectedIDs={["one"]}
      statusFilters={[]}
      onSelect={onSelect}
      onStatusFilter={() => undefined}
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

test("groups terminals by activity and exposes cwd, agent title, and status filters", async () => {
  const onStatusFilter = vi.fn();
  const onStatusSelect = vi.fn();
  const onSelect = vi.fn();
  const user = userEvent.setup();
  render(
    <SessionNavigation
      sessions={sessions}
      selectedIDs={["one"]}
      statusFilters={[]}
      onSelect={onSelect}
      onStatusFilter={onStatusFilter}
      onStatusSelect={onStatusSelect}
      onCreate={() => undefined}
      onDelete={() => undefined}
    />,
  );

  expect(screen.getByRole("heading", { name: "Running" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Exited" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Terminal" })).toBeVisible();
  expect(screen.getByText("~/work/euphony")).toBeVisible();
  expect(screen.getByText("Implement v0.2")).toBeVisible();
  const codexButton = screen.getByRole("button", { name: "Select Codex" });
  const terminalButton = screen.getByRole("button", { name: "Select Terminal" });
  expect(within(codexButton).queryByText("Codex")).not.toBeInTheDocument();
  expect(within(terminalButton).queryByText("Terminal")).not.toBeInTheDocument();
  expect(within(codexButton).getByRole("img", { name: "Codex" })).toBeVisible();
  expect(
    within(screen.getByRole("button", { name: "Select Claude" })).getByRole("img", {
      name: "Claude",
    }),
  ).toBeVisible();
  expect(within(terminalButton).queryByRole("img")).not.toBeInTheDocument();

  await user.click(screen.getByRole("checkbox", { name: "Show all Running terminals" }));
  expect(onStatusFilter).toHaveBeenCalledWith("running", true);

  await user.click(screen.getByRole("button", { name: "Show only Running terminals" }));
  expect(onStatusSelect).toHaveBeenCalledWith("running");

  expect(screen.getByRole("checkbox", { name: "Include Codex in split" })).toBeChecked();
  const terminalCheckbox = screen.getByRole("checkbox", { name: "Include Terminal in split" });
  expect(terminalCheckbox).not.toBeChecked();
  await user.click(terminalCheckbox);
  expect(onSelect).toHaveBeenCalledWith("three", true);
});

test("groups a linked worktree under its main repository and orders attention first", () => {
  const grouped: Session[] = [
    { ...sessions[0], id: "running", repoRoot: "/workspace/project" },
    {
      ...sessions[0],
      id: "attention",
      name: "Needs review",
      cwd: "/workspace/project/tmp/worktrees/fix",
      repoRoot: "/workspace/project",
      agentStatus: "attention",
    },
    {
      ...sessions[0],
      id: "waiting",
      name: "Waiting",
      repoRoot: "/workspace/project",
      agentStatus: "waiting",
    },
  ];
  render(
    <SessionNavigation
      sessions={grouped}
      selectedIDs={["running"]}
      statusFilters={[]}
      onSelect={() => undefined}
      onStatusFilter={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
    />,
  );

  expect(screen.getByRole("heading", { name: "/workspace/project" })).toBeVisible();
  const statusNames = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
  expect(statusNames).toEqual([
    "/workspace/project",
    "Need attention",
    "Running",
    "Waiting",
  ]);
});

test("collapses and restores the desktop sidebar", async () => {
  const onSettingsChange = vi.fn();
  const user = userEvent.setup();
  render(
    <SessionNavigation
      sessions={sessions}
      selectedIDs={["one"]}
      statusFilters={[]}
      onSelect={() => undefined}
      onStatusFilter={() => undefined}
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
});

test("uses a compact 256px sidebar by default", () => {
  render(
    <SessionNavigation
      sessions={sessions}
      selectedIDs={["one"]}
      statusFilters={[]}
      onSelect={() => undefined}
      onStatusFilter={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
    />,
  );

  expect(screen.getByLabelText("Terminal sessions").parentElement).toHaveStyle({ width: "256px" });
});

test("resizes the desktop sidebar by dragging its separator", () => {
  const onSettingsChange = vi.fn();
  render(
    <SessionNavigation
      sessions={sessions}
      selectedIDs={["one"]}
      statusFilters={[]}
      onSelect={() => undefined}
      onStatusFilter={() => undefined}
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
      statusFilters={[]}
      onSelect={() => undefined}
      onStatusFilter={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
      settings={settings}
      onOpenSettings={onOpenSettings}
    />,
  );

  await user.click(screen.getByRole("button", { name: "Open settings" }));
  expect(onOpenSettings).toHaveBeenCalledOnce();
});
