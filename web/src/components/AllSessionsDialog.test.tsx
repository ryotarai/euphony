import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { AllSessionsDialog } from "./AllSessionsDialog";
import type { AllSession } from "../types";

const newest: AllSession = {
  id: "newest",
  terminalId: "terminal-newest",
  agent: "codex",
  sessionId: "codex-newest",
  title: "Newest session",
  purpose: "Review the latest changes",
  summary: "The newest summary",
  cwd: "/workspace/newest",
  project: "Euphony",
  updatedAt: "2026-08-13T12:00:00Z",
  state: "open",
};

const older: AllSession = {
  id: "older",
  agent: "claude",
  sessionId: "claude-older",
  title: "Older session",
  purpose: "Tidy the release notes",
  summary: "The older summary",
  cwd: "/workspace/older",
  project: "Website",
  updatedAt: "2026-08-12T12:00:00Z",
  state: "resume",
};

function renderDialog(
  sessions: AllSession[] = [older, newest],
  overrides: Partial<ComponentProps<typeof AllSessionsDialog>> = {},
) {
  const onOpenChange = vi.fn();
  const onSelect = vi.fn();
  render(
    <AllSessionsDialog
      open
      sessions={sessions}
      loading={false}
      error=""
      onOpenChange={onOpenChange}
      onSelect={onSelect}
      {...overrides}
    />,
  );
  return { onOpenChange, onSelect };
}

test("orders rows newest first and exposes open and resume actions", () => {
  renderDialog();

  const list = screen.getByRole("list", { name: "All sessions" });
  const rows = within(list).getAllByRole("button");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent("Newest session");
  expect(rows[1]).toHaveTextContent("Older session");
  expect(rows[0]).toHaveAccessibleName(/Open terminal/);
  expect(rows[1]).toHaveAccessibleName(/Resume session/);
  expect(screen.getByRole("dialog", { name: "All sessions" })).toHaveClass(
    "all-sessions-dialog",
  );
});

test("marks archived rows as restorable", () => {
  const archived: AllSession = {
    ...newest,
    id: "archived",
    archived: true,
  };
  renderDialog([archived]);

  const row = within(screen.getByRole("list", { name: "All sessions" })).getByRole("button");
  expect(row).toHaveAccessibleName(/Restore terminal/);
  expect(row).toHaveTextContent("Restore terminal");
});

test("filters incrementally across title, purpose, summary, cwd, project, and agent", async () => {
  const searchable: AllSession = {
    ...newest,
    id: "searchable",
    title: "Ship the terminal",
    purpose: "Reconcile the selection",
    summary: "Bounded history preview",
    cwd: "/workspaces/euphony",
    project: "Desktop client",
    agent: "claude",
  };
  const user = userEvent.setup();
  renderDialog([searchable]);
  const search = screen.getByRole("searchbox", { name: "Search all sessions" });
  const row = () => within(screen.getByRole("list", { name: "All sessions" })).getByRole("button");

  for (const query of [
    "ship the terminal",
    "reconcile",
    "bounded history",
    "/workspaces",
    "desktop client",
    "claude",
  ]) {
    await user.clear(search);
    await user.type(search, query);
    expect(row()).toHaveTextContent("Ship the terminal");
  }
});

test("keeps rows keyboard-focusable and invokes the selection callback", async () => {
  const user = userEvent.setup();
  const { onSelect } = renderDialog();
  const row = within(screen.getByRole("list", { name: "All sessions" })).getAllByRole("button")[1];

  row.focus();
  expect(row).toHaveFocus();
  await user.keyboard("{Enter}");

  expect(onSelect).toHaveBeenCalledWith(older);
});

test("distinguishes loading, request errors, and both empty states", async () => {
  const user = userEvent.setup();
  const { rerender } = render(
    <AllSessionsDialog
      open
      sessions={[]}
      loading
      error=""
      onOpenChange={() => undefined}
      onSelect={() => undefined}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Loading sessions");

  rerender(
    <AllSessionsDialog
      open
      sessions={[]}
      loading={false}
      error="History service unavailable"
      onOpenChange={() => undefined}
      onSelect={() => undefined}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("History service unavailable");

  rerender(
    <AllSessionsDialog
      open
      sessions={[]}
      loading={false}
      error=""
      onOpenChange={() => undefined}
      onSelect={() => undefined}
    />,
  );
  expect(screen.getByText("No sessions found")).toBeVisible();

  rerender(
    <AllSessionsDialog
      open
      sessions={[newest]}
      loading={false}
      error=""
      onOpenChange={() => undefined}
      onSelect={() => undefined}
    />,
  );
  const search = screen.getByRole("searchbox", { name: "Search all sessions" });
  // A non-matching query is an empty result, not an API error.
  await user.type(search, "no such session");
  expect(screen.getByText("No sessions match your search")).toBeVisible();
});
