import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { KanbanDialog } from "./KanbanDialog";
import type { KanbanSession } from "../types";

const sessions: KanbanSession[] = [
  {
    id: "running-1",
    terminalId: "terminal-running-1",
    agent: "codex",
    title: "Build the relay",
    purpose: "Connect the event stream",
    summary: "Implementing the next transport step.",
    cwd: "/workspace/euphony",
    updatedAt: "2026-08-19T08:00:00Z",
    status: "running",
    state: "open",
    archived: false,
  },
  {
    id: "waiting-1",
    terminalId: "terminal-waiting-1",
    agent: "claude",
    title: "Review the release notes",
    purpose: "Waiting for a decision",
    cwd: "/workspace/release",
    updatedAt: "2026-08-19T07:00:00Z",
    status: "waiting",
    state: "resume",
    archived: false,
  },
  {
    id: "blocked-1",
    terminalId: "terminal-blocked-1",
    agent: "codex",
    title: "Investigate the flaky test",
    cwd: "/workspace/tests",
    updatedAt: "2026-08-19T06:00:00Z",
    status: "blocked",
    state: "resume",
    archived: false,
  },
  {
    id: "archived-1",
    terminalId: "terminal-archived-1",
    agent: "claude",
    title: "Polish the onboarding copy",
    cwd: "/workspace/onboarding",
    updatedAt: "2026-08-18T06:00:00Z",
    status: "archived",
    archived: true,
    state: "resume",
  },
];

function renderModal(
  overrides: Partial<ComponentProps<typeof KanbanDialog>> = {},
) {
  const onOpenChange = vi.fn();
  const onArchiveSession = vi.fn().mockResolvedValue(undefined);
  render(
    <KanbanDialog
      open
      sessions={sessions}
      onOpenChange={onOpenChange}
      onArchiveSession={onArchiveSession}
      {...overrides}
    />,
  );
  return { onOpenChange, onArchiveSession };
}

test("renders four predictable status columns with compact agent cards", () => {
  renderModal();

  expect(screen.getByRole("dialog", { name: "Kanban" })).toHaveClass("kanban-modal");
  for (const column of ["Running", "Waiting", "Blocked", "Archived"]) {
    expect(screen.getByRole("region", { name: column })).toBeVisible();
  }
  expect(screen.getByText("Build the relay")).toBeVisible();
  expect(screen.getByText("Connect the event stream")).toBeVisible();
  expect(screen.getByText("Polish the onboarding copy")).toBeVisible();
  expect(screen.getByRole("button", { name: "Archive Build the relay" })).toBeVisible();
});

test("archives a card through the accessible fallback action", async () => {
  const user = userEvent.setup();
  const { onArchiveSession } = renderModal();

  const archiveButton = screen.getByRole("button", { name: "Archive Build the relay" });
  archiveButton.focus();
  await user.keyboard("{Enter}");

  await waitFor(() => expect(onArchiveSession).toHaveBeenCalledWith(sessions[0]));
  await waitFor(() => {
    expect(screen.getByRole("region", { name: "Archived" }))
      .toHaveTextContent("Build the relay");
  });
  expect(screen.getByRole("region", { name: "Running" }))
    .not.toHaveTextContent("Build the relay");
});

test("archives a card when it is dropped into the Archived column", async () => {
  const { onArchiveSession } = renderModal();
  const card = screen.getByTestId("kanban-card-running-1");
  const archivedColumn = screen.getByRole("region", { name: "Archived" });
  const dataTransfer = {
    dropEffect: "move",
    effectAllowed: "move",
    getData: vi.fn().mockReturnValue("running-1"),
    setData: vi.fn(),
  };

  fireEvent.dragStart(card, { dataTransfer });
  fireEvent.dragOver(archivedColumn, { dataTransfer });
  fireEvent.drop(archivedColumn, { dataTransfer });

  await waitFor(() => expect(onArchiveSession).toHaveBeenCalledWith(sessions[0]));
});

test("restores an archived card through its accessible fallback action", async () => {
  const user = userEvent.setup();
  const onRestoreSession = vi.fn().mockResolvedValue(undefined);
  renderModal({ onRestoreSession });

  await user.click(screen.getByRole("button", { name: "Restore Polish the onboarding copy" }));

  await waitFor(() => expect(onRestoreSession).toHaveBeenCalledWith(sessions[3]));
  await waitFor(() => {
    expect(screen.getByRole("region", { name: "Running" }))
      .toHaveTextContent("Polish the onboarding copy");
  });
  expect(screen.getByRole("region", { name: "Archived" }))
    .not.toHaveTextContent("Polish the onboarding copy");
});

test("preserves an archived session's waiting state when it is restored", async () => {
  const user = userEvent.setup();
  const onRestoreSession = vi.fn().mockResolvedValue(undefined);
  const archivedWaiting = { ...sessions[1], id: "archived-waiting-1", archived: true };
  renderModal({ sessions: [archivedWaiting], onRestoreSession });

  await user.click(screen.getByRole("button", { name: "Restore Review the release notes" }));

  await waitFor(() => expect(onRestoreSession).toHaveBeenCalledWith(archivedWaiting));
  expect(screen.getByRole("region", { name: "Waiting" }))
    .toHaveTextContent("Review the release notes");
  expect(screen.getByRole("region", { name: "Running" }))
    .not.toHaveTextContent("Review the release notes");
});
