import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionNavigation } from "./SessionNavigation";
import type { Session } from "../types";

const sessions: Session[] = [
  {
    id: "one",
    name: "Codex",
    state: "running",
    createdAt: "2026-07-28T00:00:00Z",
  },
  {
    id: "two",
    name: "Claude",
    state: "exited",
    createdAt: "2026-07-28T00:01:00Z",
    exitCode: 0,
  },
];

test("opens and closes the mobile drawer with keyboard focus restoration", async () => {
  const user = userEvent.setup();
  render(
    <SessionNavigation
      sessions={sessions}
      selectedID="one"
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
  const onSelect = vi.fn();
  const user = userEvent.setup();
  render(
    <SessionNavigation
      sessions={sessions}
      selectedID="one"
      onSelect={onSelect}
      onCreate={() => undefined}
      onDelete={() => undefined}
    />,
  );

  await user.click(screen.getByRole("button", { name: "Open terminal menu" }));
  const drawer = screen.getByRole("dialog", { name: "Terminal menu" });
  await user.click(within(drawer).getByRole("button", { name: "Select Claude" }));

  expect(onSelect).toHaveBeenCalledWith("two");
  expect(screen.queryByRole("dialog", { name: "Terminal menu" })).not.toBeInTheDocument();
});
