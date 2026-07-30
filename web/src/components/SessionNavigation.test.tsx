import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionNavigation } from "./SessionNavigation";
import type { Session, Settings } from "../types";

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

test("composes terminal navigation from the shadcn sidebar without a monogram", () => {
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

  const navigation = screen.getByLabelText("Terminal sessions");
  expect(navigation.closest('[data-slot="sidebar"]')).toBeInTheDocument();
  expect(screen.queryByText("EU")).not.toBeInTheDocument();
});

test("opens and closes the mobile drawer with keyboard focus restoration", async () => {
  useMobileViewport();
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
  useMobileViewport();
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

test("groups terminals by status then cwd and exposes group selection controls", async () => {
  const onStatusFilter = vi.fn();
  const onStatusSelect = vi.fn();
  const onCwdFilter = vi.fn();
  const onCwdSelect = vi.fn();
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
      cwdFilters={["running\u0000/Users/ryotarai/work/euphony"]}
      onCwdFilter={onCwdFilter}
      onCwdSelect={onCwdSelect}
      onCreate={() => undefined}
      onDelete={() => undefined}
    />,
  );

  const runningHeading = screen.getByRole("heading", { name: "Running" });
  const cwdHeading = screen.getByRole("heading", { name: "~/work/euphony" });
  const codexButton = screen.getByRole("button", { name: "Select Codex" });
  expect(runningHeading).toBeVisible();
  expect(screen.getByRole("heading", { name: "Exited" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Terminal" })).toBeVisible();
  expect(
    runningHeading.compareDocumentPosition(cwdHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    cwdHeading.compareDocumentPosition(codexButton) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.getByText("Implement v0.2")).toBeVisible();
  const terminalButton = screen.getByRole("button", { name: "Select Terminal" });
  expect(within(codexButton).queryByText("Codex")).not.toBeInTheDocument();
  expect(within(terminalButton).getByText("Terminal")).toBeVisible();
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

  const cwdCheckbox = screen.getByRole("checkbox", {
    name: "Include all terminals in ~/work/euphony",
  });
  expect(cwdCheckbox).toBeChecked();
  await user.click(cwdCheckbox);
  expect(onCwdFilter).toHaveBeenCalledWith(
    "running",
    "/Users/ryotarai/work/euphony",
    false,
  );

  await user.click(
    screen.getByRole("button", {
      name: "Show only Running terminals in ~/work/euphony",
    }),
  );
  expect(onCwdSelect).toHaveBeenCalledWith(
    "running",
    "/Users/ryotarai/work/euphony",
  );

  expect(screen.getByRole("checkbox", { name: "Include Codex in split" })).toBeChecked();
  expect(
    screen.getByRole("checkbox", { name: "Include Codex in split" }).closest("ul"),
  ).toHaveClass("cwd-terminal-list");
  const terminalCheckbox = screen.getByRole("checkbox", { name: "Include Terminal in split" });
  expect(terminalCheckbox).not.toBeChecked();
  await user.click(terminalCheckbox);
  expect(onSelect).toHaveBeenCalledWith("three", true);
});

test("inherits status selection into cwd controls and marks partial selection", () => {
  const runningElsewhere: Session = {
    ...sessions[0],
    id: "four",
    name: "Other",
    cwd: "/tmp",
  };
  const { rerender } = render(
    <SessionNavigation
      sessions={[sessions[0], runningElsewhere]}
      selectedIDs={["one", "four"]}
      statusFilters={["running"]}
      cwdFilters={[]}
      onSelect={() => undefined}
      onStatusFilter={() => undefined}
      onCwdFilter={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
    />,
  );

  expect(
    screen.getByRole("checkbox", {
      name: "Include all terminals in ~/work/euphony",
    }),
  ).toBeChecked();
  expect(
    screen.getByRole("checkbox", { name: "Include all terminals in /tmp" }),
  ).toBeChecked();

  rerender(
    <SessionNavigation
      sessions={[sessions[0], runningElsewhere]}
      selectedIDs={["one"]}
      statusFilters={[]}
      cwdFilters={["running\u0000/Users/ryotarai/work/euphony"]}
      onSelect={() => undefined}
      onStatusFilter={() => undefined}
      onCwdFilter={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
    />,
  );

  expect(
    screen.getByRole("checkbox", { name: "Show all Running terminals" }),
  ).toHaveAttribute("aria-checked", "mixed");
  expect(
    screen.getByRole("checkbox", {
      name: "Include all terminals in ~/work/euphony",
    }),
  ).toBeChecked();
  expect(
    screen.getByRole("checkbox", { name: "Include all terminals in /tmp" }),
  ).not.toBeChecked();
});

test("groups terminals by their exact cwd within each ordered status", () => {
  const grouped: Session[] = [
    { ...sessions[0], id: "running", repoRoot: "/workspace/project" },
    {
      ...sessions[0],
      id: "attention",
      name: "Needs review",
      cwd: "/workspace/project/tmp/worktrees/fix",
      repoRoot: "/workspace/project",
      agentStatus: "waiting",
      needsAttention: true,
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

  const statusNames = screen.getAllByRole("heading").map((heading) => heading.textContent);
  expect(statusNames).toEqual([
    "Need attention",
    "/workspace/project/tmp/worktrees/fix",
    "Running",
    "~/work/euphony",
    "Waiting",
    "~/work/euphony",
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
