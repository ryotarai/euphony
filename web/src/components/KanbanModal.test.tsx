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
  expect(screen.getByText("Connect the event stream")).toBeVisible();
  expect(screen.getByText("Polish the onboarding copy")).toBeVisible();
  expect(screen.getByRole("button", { name: "Archive Connect the event stream" })).toBeVisible();
});

test("uses an agent purpose as the card title instead of a generic terminal title", () => {
  renderModal({
    sessions: [{
      ...sessions[0],
      title: "Terminal",
      purpose: "Kanbanビュー実装",
    }],
  });

  expect(screen.getByRole("heading", { name: "Kanbanビュー実装", level: 3 })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Terminal", level: 3 })).not.toBeInTheDocument();
  expect(screen.queryByText("Kanbanビュー実装", { selector: "p.kanban-card-purpose" }))
    .not.toBeInTheDocument();
});

test("opens the selected agent session when a card is clicked", async () => {
  const user = userEvent.setup();
  const onOpenSession = vi.fn();
  renderModal({ onOpenSession });

  await user.click(screen.getByText("Connect the event stream"));

  expect(onOpenSession).toHaveBeenCalledWith(sessions[0]);
});

test("shows the session information card while an agent card is hovered", async () => {
  renderModal();

  const card = screen.getByTestId("kanban-card-running-1");
  fireEvent.pointerEnter(card, { clientX: 120, clientY: 180 });

  const info = await screen.findByRole("region", { name: "Session information" });
  expect(info).toHaveAttribute("data-session-id", "running-1");
  expect(within(info).getByRole("heading", { name: "Connect the event stream", level: 2 })).toBeVisible();
  expect(within(info).getByText("Implementing the next transport step.")).toBeVisible();

  fireEvent.pointerLeave(card);
  await waitFor(() => expect(screen.queryByRole("region", { name: "Session information" })).not.toBeInTheDocument());
});

test("filters cards by project without changing their status columns", async () => {
  const user = userEvent.setup();
  const projectSessions = sessions.map((session, index) => ({
    ...session,
    project: index % 2 === 0 ? "/workspace/euphony" : "/workspace/release",
  }));
  renderModal({
    sessions: projectSessions,
    projects: [
      { id: "euphony", path: "/workspace/euphony", createdAt: "2026-08-01T00:00:00Z" },
      { id: "release", path: "/workspace/release", createdAt: "2026-08-02T00:00:00Z" },
    ],
  });

  const filter = screen.getByRole("combobox", { name: "Filter by project" });
  await user.selectOptions(filter, "/workspace/release");

  expect(screen.getByRole("region", { name: "Waiting" })).toHaveTextContent(
    "Waiting for a decision",
  );
  expect(screen.getByRole("region", { name: "Running" })).not.toHaveTextContent(
    "Build the relay",
  );
});

test("archives a card through the accessible fallback action", async () => {
  const user = userEvent.setup();
  const { onArchiveSession } = renderModal();

  const archiveButton = screen.getByRole("button", { name: "Archive Connect the event stream" });
  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: "Filter by project" })).toHaveFocus();
  });
  archiveButton.focus();
  await user.keyboard("{Enter}");

  await waitFor(() => expect(onArchiveSession).toHaveBeenCalledWith(sessions[0]));
  await waitFor(() => {
    expect(screen.getByRole("region", { name: "Archived" }))
      .toHaveTextContent("Connect the event stream");
  });
  expect(screen.getByRole("region", { name: "Running" }))
    .not.toHaveTextContent("Connect the event stream");
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

  await user.click(screen.getByRole("button", { name: "Restore Waiting for a decision" }));

  await waitFor(() => expect(onRestoreSession).toHaveBeenCalledWith(archivedWaiting));
  expect(screen.getByRole("region", { name: "Waiting" }))
    .toHaveTextContent("Waiting for a decision");
  expect(screen.getByRole("region", { name: "Running" }))
    .not.toHaveTextContent("Waiting for a decision");
});
