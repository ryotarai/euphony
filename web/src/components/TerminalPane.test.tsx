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

function paneAPI(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getAgentLog: vi.fn().mockResolvedValue({ log: null, etag: "" }),
    getGitChanges: vi.fn().mockResolvedValue({
      repoRoot: "/repo",
      branch: "main",
      ahead: 0,
      behind: 0,
      additions: 0,
      deletions: 0,
      files: [],
    }),
    getWorkspaceDirectory: vi.fn().mockResolvedValue({
      root: "/repo",
      path: "",
      entries: [],
    }),
    searchWorkspace: vi.fn().mockResolvedValue({
      root: "/repo",
      query: "",
      matches: [],
    }),
    getWorkspaceFile: vi.fn(),
    getCurrentAnnotation: vi.fn().mockResolvedValue(null),
    completeAnnotation: vi.fn().mockResolvedValue({
      annotationId: "annotation-1",
      comments: [],
    }),
    ...overrides,
  } as unknown as ApiClient;
}

test("switches pane sources while keeping the terminal mounted", async () => {
  const user = userEvent.setup();
  const layoutVersions: number[] = [];
  const sourceVisibilities: boolean[] = [];
  render(
    <TerminalPane
      session={session}
      api={paneAPI()}
      active
      layoutVersion={2}
      tabShortcut="Meta+L"
      agentLogFontSize={17}
      onDeselect={() => undefined}
      renderTerminal={(layoutVersion, _active, sourceVisible) => {
        layoutVersions.push(layoutVersion);
        sourceVisibilities.push(sourceVisible);
        return <div aria-label="live terminal">terminal</div>;
      }}
    />,
  );

  expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute("data-active");
  expect(screen.getByLabelText("live terminal")).toBeVisible();

  await user.click(screen.getByRole("tab", { name: "Agent log" }));
  expect(screen.getByRole("tab", { name: "Agent log" })).toHaveAttribute("data-active");
  expect(screen.getByLabelText("live terminal")).not.toBeVisible();
  expect(sourceVisibilities.at(-1)).toBe(false);
  expect(screen.getByRole("region", { name: "Agent log" })).toHaveStyle({
    "--agent-log-font-size": "17px",
  });

  await user.click(screen.getByRole("tab", { name: "Changes" }));
  expect(screen.getByRole("tab", { name: "Changes" })).toHaveAttribute("data-active");
  expect(await screen.findByRole("region", { name: "Git changes" })).toBeVisible();
  expect(screen.getByLabelText("live terminal")).not.toBeVisible();

  await user.click(screen.getByRole("tab", { name: "Files" }));
  expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("data-active");
  expect(await screen.findByRole("region", { name: "Workspace files" })).toBeVisible();
  expect(screen.getByLabelText("live terminal")).not.toBeVisible();

  await user.click(screen.getByRole("tab", { name: "Terminal" }));
  expect(screen.getByLabelText("live terminal")).toBeVisible();
  expect(layoutVersions.at(-1)).toBe(3);
  expect(sourceVisibilities.at(-1)).toBe(true);
});

test("keeps an independent selected source for each pane instance", async () => {
  const user = userEvent.setup();
  const api = paneAPI();
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
  const api = paneAPI();
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
      api={paneAPI({ getAgentLog })}
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
  const api = paneAPI();
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
  expect(screen.getByRole("tab", { name: "Changes" })).toHaveAttribute("data-active");

  fireEvent.keyDown(window, { key: "l", metaKey: true });
  expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("data-active");

  fireEvent.keyDown(window, { key: "l", metaKey: true });
  expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute("data-active");
});

test("uses a custom shortcut only on the active pane", () => {
  const api = paneAPI();
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
  const api = paneAPI();
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
      api={paneAPI()}
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

test("discovers a new annotation as a third tab and selects it", async () => {
  const user = userEvent.setup();
  const layoutVersions: number[] = [];
  const sourceVisibilities: boolean[] = [];
  const getCurrentAnnotation = vi.fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({
      id: "annotation-1",
      terminalId: "terminal-1",
      filename: "review.md",
      format: "markdown",
      content: "# Review",
      createdAt: "2026-07-30T00:00:00Z",
    });
  const api = paneAPI({ getCurrentAnnotation });
  const renderTerminal = (
    layoutVersion: number,
    _active: boolean,
    sourceVisible: boolean,
  ) => {
    layoutVersions.push(layoutVersion);
    sourceVisibilities.push(sourceVisible);
    return <div aria-label="live terminal">terminal</div>;
  };
  const { rerender } = render(
    <TerminalPane
      session={session}
      api={api}
      active
      layoutVersion={1}
      annotationRevision={0}
      tabShortcut="Meta+L"
      onDeselect={() => undefined}
      renderTerminal={renderTerminal}
    />,
  );
  expect(await screen.findByRole("tab", { name: "Terminal" })).toHaveAttribute("data-active");
  expect(screen.queryByRole("tab", { name: "Annotation" })).not.toBeInTheDocument();

  rerender(
    <TerminalPane
      session={session}
      api={api}
      active
      layoutVersion={1}
      annotationRevision={1}
      tabShortcut="Meta+L"
      onDeselect={() => undefined}
      renderTerminal={renderTerminal}
    />,
  );

  expect(await screen.findByRole("tab", { name: "Annotation" })).toHaveAttribute("data-active");
  expect(screen.getByRole("heading", { name: "Review" })).toBeVisible();
  expect(screen.getByLabelText("live terminal")).not.toBeVisible();
  expect(sourceVisibilities.at(-1)).toBe(false);
  expect(document.querySelector(".agent-log-view")).toBeInTheDocument();

  await user.click(screen.getByRole("tab", { name: "Terminal" }));
  expect(screen.getByLabelText("live terminal")).toBeVisible();
  expect(layoutVersions.at(-1)).toBe(2);
  expect(sourceVisibilities.at(-1)).toBe(true);
});

test("keeps a displayed annotation and offers retry after refresh failure", async () => {
  const user = userEvent.setup();
  const annotation = {
    id: "annotation-1",
    terminalId: "terminal-1",
    filename: "review.md",
    format: "markdown" as const,
    content: "# Review",
    createdAt: "2026-07-30T00:00:00Z",
  };
  const getCurrentAnnotation = vi.fn()
    .mockResolvedValueOnce(annotation)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(annotation);
  const api = paneAPI({ getCurrentAnnotation });
  const props = {
    session,
    api,
    active: true,
    layoutVersion: 1,
    tabShortcut: "Meta+L",
    onDeselect: () => undefined,
    renderTerminal: () => <div>terminal</div>,
  };
  const { rerender } = render(
    <TerminalPane {...props} annotationRevision={0} />,
  );
  expect(await screen.findByRole("tab", { name: "Annotation" })).toBeVisible();

  rerender(<TerminalPane {...props} annotationRevision={1} />);
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Review status could not be refreshed.",
  );
  await user.click(screen.getByRole("button", { name: "Retry" }));

  await screen.findByRole("heading", { name: "Review" });
  expect(screen.queryByText("Review status could not be refreshed."))
    .not.toBeInTheDocument();
  expect(getCurrentAnnotation).toHaveBeenCalledTimes(3);
});
