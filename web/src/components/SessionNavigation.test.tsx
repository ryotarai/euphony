import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionNavigation } from "./SessionNavigation";
import type { Session } from "../types";

const sessions: Session[] = [
  {
    id: "one",
    name: "Codex",
    state: "running",
    cwd: "/workspace/euphony",
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
  const user = userEvent.setup();
  render(
    <SessionNavigation
      sessions={sessions}
      selectedIDs={["one"]}
      statusFilters={[]}
      onSelect={() => undefined}
      onStatusFilter={onStatusFilter}
      onCreate={() => undefined}
      onDelete={() => undefined}
    />,
  );

  expect(screen.getByRole("heading", { name: "Running" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Exited" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Terminal" })).toBeVisible();
  expect(screen.getByText("/workspace/euphony")).toBeVisible();
  expect(screen.getByText("Implement v0.2")).toBeVisible();

  await user.click(screen.getByRole("checkbox", { name: "Show all Running terminals" }));
  expect(onStatusFilter).toHaveBeenCalledWith("running", true);
});
