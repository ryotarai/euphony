import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import type { ApiClient } from "../api";
import type { Session } from "../types";
import { TerminalPane } from "./TerminalPane";

const session: Session = {
  id: "terminal-1",
  name: "Terminal one",
  state: "running",
  cwd: "/repo",
  agent: "claude",
  createdAt: "2026-07-30T01:00:00Z",
};

test("switches pane sources while keeping the terminal mounted", async () => {
  const user = userEvent.setup();
  const layoutVersions: number[] = [];
  render(
    <TerminalPane
      session={session}
      api={{ getAgentLog: vi.fn().mockResolvedValue({ log: null, etag: "" }) } as unknown as ApiClient}
      active
      layoutVersion={2}
      onDeselect={() => undefined}
      renderTerminal={(layoutVersion) => {
        layoutVersions.push(layoutVersion);
        return <div aria-label="live terminal">terminal</div>;
      }}
    />,
  );

  expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute("data-active");
  expect(screen.getByLabelText("live terminal")).toBeVisible();

  await user.click(screen.getByRole("tab", { name: "Agent log" }));
  expect(screen.getByRole("tab", { name: "Agent log" })).toHaveAttribute("data-active");
  expect(screen.getByLabelText("live terminal")).not.toBeVisible();
  expect(screen.getByRole("region", { name: "Agent log" })).toBeVisible();

  await user.click(screen.getByRole("tab", { name: "Terminal" }));
  expect(screen.getByLabelText("live terminal")).toBeVisible();
  expect(layoutVersions.at(-1)).toBe(3);
});

test("keeps an independent selected source for each pane instance", async () => {
  const user = userEvent.setup();
  const api = { getAgentLog: vi.fn().mockResolvedValue({ log: null, etag: "" }) } as unknown as ApiClient;
  render(
    <>
      <TerminalPane
        session={session}
        api={api}
        active
        layoutVersion={1}
        onDeselect={() => undefined}
        renderTerminal={() => <div>first terminal</div>}
      />
      <TerminalPane
        session={{ ...session, id: "terminal-2", name: "Terminal two" }}
        api={api}
        active={false}
        layoutVersion={1}
        onDeselect={() => undefined}
        renderTerminal={() => <div>second terminal</div>}
      />
    </>,
  );

  const logTabs = screen.getAllByRole("tab", { name: "Agent log" });
  await user.click(logTabs[0]);
  expect(logTabs[0]).toHaveAttribute("data-active");
  expect(screen.getAllByRole("tab", { name: "Terminal" })[1]).toHaveAttribute("data-active");
});

test("refreshes a visible log even when its pane is not focused", async () => {
  const user = userEvent.setup();
  const getAgentLog = vi.fn().mockResolvedValue({ log: null, etag: "" });
  render(
    <TerminalPane
      session={session}
      api={{ getAgentLog } as unknown as ApiClient}
      active={false}
      layoutVersion={1}
      onDeselect={() => undefined}
      renderTerminal={() => <div>terminal</div>}
    />,
  );

  await user.click(screen.getByRole("tab", { name: "Agent log" }));
  expect(getAgentLog).toHaveBeenCalledWith("terminal-1", undefined);
});

test("deselects the terminal from the pane rail", async () => {
  const user = userEvent.setup();
  const onDeselect = vi.fn();
  render(
    <TerminalPane
      session={session}
      api={{ getAgentLog: vi.fn().mockResolvedValue({ log: null, etag: "" }) } as unknown as ApiClient}
      active
      layoutVersion={1}
      onDeselect={onDeselect}
      renderTerminal={() => <div>terminal</div>}
    />,
  );

  const checkbox = screen.getByRole("checkbox", {
    name: "Deselect Terminal one",
  });
  expect(checkbox).toBeChecked();

  await user.click(checkbox);

  expect(onDeselect).toHaveBeenCalledOnce();
});
