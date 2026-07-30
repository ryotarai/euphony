import { fireEvent, render, screen } from "@testing-library/react";
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
      tabShortcut="Meta+L"
      agentLogFontSize={17}
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
  expect(screen.getByRole("region", { name: "Agent log" })).toHaveStyle({
    "--agent-log-font-size": "17px",
  });

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
        tabShortcut="Meta+L"
        onDeselect={() => undefined}
        renderTerminal={() => <div>first terminal</div>}
      />
      <TerminalPane
        session={{ ...session, id: "terminal-2", name: "Terminal two" }}
        api={api}
        active={false}
        layoutVersion={1}
        tabShortcut="Meta+L"
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

test("shows attention in the pane rail only for flagged sessions", () => {
  const api = {
    getAgentLog: vi.fn().mockResolvedValue({ log: null, etag: "" }),
  } as unknown as ApiClient;
  render(
    <>
      <TerminalPane
        session={{ ...session, needsAttention: true }}
        api={api}
        active
        layoutVersion={2}
        tabShortcut="Meta+L"
        onDeselect={() => undefined}
        renderTerminal={() => <div>attention terminal</div>}
      />
      <TerminalPane
        session={{ ...session, id: "terminal-2", name: "Terminal two" }}
        api={api}
        active={false}
        layoutVersion={2}
        tabShortcut="Meta+L"
        onDeselect={() => undefined}
        renderTerminal={() => <div>regular terminal</div>}
      />
    </>,
  );

  const attentionStatus = screen.getByRole("status", {
    name: "Needs attention",
  });
  const attentionDot = attentionStatus.querySelector(".attention-dot");
  expect(attentionStatus).toHaveClass("pane-attention-indicator");
  expect(attentionDot).toBeVisible();
  expect(attentionDot).toHaveAttribute("aria-hidden", "true");
  expect(
    screen.getAllByRole("status", { name: "Needs attention" }),
  ).toHaveLength(1);
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
      tabShortcut="Meta+L"
      onDeselect={() => undefined}
      renderTerminal={() => <div>terminal</div>}
    />,
  );

  await user.click(screen.getByRole("tab", { name: "Agent log" }));
  expect(getAgentLog).toHaveBeenCalledWith("terminal-1", undefined);
});
test("toggles the active pane source with its configured shortcut", () => {
  const api = {
    getAgentLog: vi.fn().mockResolvedValue({ log: null, etag: "" }),
  } as unknown as ApiClient;
  render(
    <TerminalPane
      session={session}
      api={api}
      active
      layoutVersion={1}
      tabShortcut="Meta+L"
      onDeselect={() => undefined}
      renderTerminal={() => <div aria-label="live terminal">terminal</div>}
    />,
  );

  fireEvent.keyDown(window, { key: "l", metaKey: true });
  expect(screen.getByRole("tab", { name: "Agent log" })).toHaveAttribute("data-active");

  fireEvent.keyDown(window, { key: "l", metaKey: true });
  expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute("data-active");
});

test("uses a custom shortcut only on the active pane", () => {
  const api = {
    getAgentLog: vi.fn().mockResolvedValue({ log: null, etag: "" }),
  } as unknown as ApiClient;
  render(
    <>
      <TerminalPane
        session={session}
        api={api}
        active
        layoutVersion={1}
        tabShortcut="Ctrl+J"
        onDeselect={() => undefined}
        renderTerminal={() => <div>active terminal</div>}
      />
      <TerminalPane
        session={{ ...session, id: "terminal-2" }}
        api={api}
        active={false}
        layoutVersion={1}
        tabShortcut="Ctrl+J"
        onDeselect={() => undefined}
        renderTerminal={() => <div>inactive terminal</div>}
      />
    </>,
  );

  fireEvent.keyDown(window, { key: "l", metaKey: true });
  expect(screen.getAllByRole("tab", { name: "Terminal" })[0]).toHaveAttribute("data-active");

  fireEvent.keyDown(window, { key: "j", ctrlKey: true });
  expect(screen.getAllByRole("tab", { name: "Agent log" })[0]).toHaveAttribute("data-active");
  expect(screen.getAllByRole("tab", { name: "Terminal" })[1]).toHaveAttribute("data-active");
});

test("does not toggle while a regular input is being edited", () => {
  const api = {
    getAgentLog: vi.fn().mockResolvedValue({ log: null, etag: "" }),
  } as unknown as ApiClient;
  render(
    <>
      <input aria-label="Regular input" />
      <TerminalPane
        session={session}
        api={api}
        active
        layoutVersion={1}
        tabShortcut="Meta+L"
        onDeselect={() => undefined}
        renderTerminal={() => <div>terminal</div>}
      />
    </>,
  );

  const input = screen.getByRole("textbox", { name: "Regular input" });
  input.focus();
  fireEvent.keyDown(input, { key: "l", metaKey: true });

  expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute("data-active");
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
      tabShortcut="Meta+L"
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
