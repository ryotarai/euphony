import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

test("opens a secondary source with Command-click without changing the primary source", async () => {
  const activeStates: boolean[] = [];
  const sourceVisibilities: boolean[] = [];
  render(
    <TerminalPane
      session={session}
      api={paneAPI()}
      active
      layoutVersion={1}
      tabShortcut="Meta+L"
      onDeselect={() => undefined}
      renderTerminal={(_layoutVersion, terminalActive, sourceVisible) => {
        activeStates.push(terminalActive);
        sourceVisibilities.push(sourceVisible);
        return <div aria-label="live terminal">terminal</div>;
      }}
    />,
  );

  const terminalTab = screen.getByRole("tab", { name: "Terminal" });
  const filesTab = screen.getByRole("tab", { name: "Files" });
  fireEvent.click(filesTab, { metaKey: true });

  expect(terminalTab).toHaveAttribute("data-active");
  expect(filesTab).toHaveAttribute("data-split-active", "true");
  expect(filesTab).toHaveAccessibleDescription("Visible in split");
  expect(screen.getByLabelText("live terminal")).toBeVisible();
  expect(await screen.findByRole("region", { name: "Workspace files" }))
    .toBeVisible();
  expect(screen.getByRole("region", { name: "Workspace files split view" }))
    .toBeVisible();
  expect(screen.queryByRole("tabpanel", { name: "Files" }))
    .not.toBeInTheDocument();
  expect(screen.getByRole("separator", { name: "Resize source split" }))
    .toHaveAttribute("aria-valuenow", "50");
  expect(activeStates.at(-1)).toBe(false);
  expect(sourceVisibilities.at(-1)).toBe(true);
  expect(screen.queryByText("Terminal + Workspace files")).not.toBeInTheDocument();
});

test("bumps the terminal layout after closing a source split", async () => {
  const layoutVersions: number[] = [];
  render(
    <TerminalPane
      session={session}
      api={paneAPI()}
      active
      layoutVersion={1}
      tabShortcut="Meta+L"
      onDeselect={() => undefined}
      renderTerminal={(layoutVersion) => {
        layoutVersions.push(layoutVersion);
        return <div aria-label="live terminal">terminal</div>;
      }}
    />,
  );

  const filesTab = screen.getByRole("tab", { name: "Files" });
  fireEvent.click(filesTab, { metaKey: true });
  expect(filesTab).toHaveAttribute("data-split-active", "true");
  expect(layoutVersions.at(-1)).toBe(1);

  fireEvent.click(filesTab, { metaKey: true });
  await waitFor(() => expect(layoutVersions.at(-1)).toBe(2));
});

test("reports Terminal as visible without activating it on the secondary side", async () => {
  const user = userEvent.setup();
  const activeStates: boolean[] = [];
  const sourceVisibilities: boolean[] = [];
  render(
    <TerminalPane
      session={session}
      api={paneAPI()}
      active
      layoutVersion={1}
      tabShortcut="Meta+L"
      onDeselect={() => undefined}
      renderTerminal={(_layoutVersion, terminalActive, sourceVisible) => {
        activeStates.push(terminalActive);
        sourceVisibilities.push(sourceVisible);
        return <div aria-label="live terminal">terminal</div>;
      }}
    />,
  );

  await user.click(screen.getByRole("tab", { name: "Files" }));
  fireEvent.click(screen.getByRole("tab", { name: "Terminal" }), {
    metaKey: true,
  });

  expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("data-active");
  expect(screen.getByRole("tab", { name: "Terminal" }))
    .toHaveAttribute("data-split-active", "true");
  expect(screen.getByLabelText("live terminal")).toBeVisible();
  expect(activeStates.at(-1)).toBe(false);
  expect(sourceVisibilities.at(-1)).toBe(true);
});

test("opens a keyboard-accessible secondary source with Command-Enter", () => {
  render(
    <TerminalPane
      session={session}
      api={paneAPI()}
      active
      layoutVersion={1}
      tabShortcut="Meta+L"
      onDeselect={() => undefined}
      renderTerminal={() => <div>terminal</div>}
    />,
  );

  const filesTab = screen.getByRole("tab", { name: "Files" });
  filesTab.focus();
  fireEvent.keyDown(filesTab, { key: "Enter", metaKey: true });

  expect(filesTab).toHaveAttribute("data-split-active", "true");
  expect(screen.getByRole("separator", { name: "Resize source split" }))
    .toBeVisible();
});

test("does not activate Terminal when Command-click closes its split", async () => {
  const user = userEvent.setup();
  const activeStates: boolean[] = [];
  render(
    <TerminalPane
      session={session}
      api={paneAPI()}
      active
      layoutVersion={1}
      tabShortcut="Meta+L"
      onDeselect={() => undefined}
      renderTerminal={(_layoutVersion, terminalActive) => {
        activeStates.push(terminalActive);
        return <div>terminal</div>;
      }}
    />,
  );

  const terminalTab = screen.getByRole("tab", { name: "Terminal" });
  const filesTab = screen.getByRole("tab", { name: "Files" });
  fireEvent.click(filesTab, { metaKey: true });
  expect(activeStates.at(-1)).toBe(false);

  fireEvent.click(filesTab, { metaKey: true });
  expect(activeStates.at(-1)).toBe(false);

  await user.click(terminalTab);
  expect(activeStates.at(-1)).toBe(true);
});

test("replaces, closes, and clears a secondary source without unmounting views", async () => {
  const user = userEvent.setup();
  render(
    <TerminalPane
      session={session}
      api={paneAPI()}
      active
      layoutVersion={1}
      tabShortcut="Meta+L"
      onDeselect={() => undefined}
      renderTerminal={() => <div aria-label="live terminal">terminal</div>}
    />,
  );

  const logTab = screen.getByRole("tab", { name: "Agent log" });
  const changesTab = screen.getByRole("tab", { name: "Changes" });
  fireEvent.click(logTab, { metaKey: true });
  fireEvent.click(changesTab, { metaKey: true });

  expect(logTab).not.toHaveAttribute("data-split-active");
  expect(changesTab).toHaveAttribute("data-split-active", "true");
  expect(screen.getByRole("region", { name: "Git changes" })).toBeVisible();
  expect(document.querySelector(".agent-log-view")).toBeInTheDocument();
  expect(document.querySelector(".agent-log-view")).not.toBeVisible();

  fireEvent.click(changesTab, { metaKey: true });
  expect(screen.queryByRole("separator", { name: "Resize source split" }))
    .not.toBeInTheDocument();
  expect(screen.getByLabelText("live terminal")).toBeVisible();

  fireEvent.click(logTab, { metaKey: true });
  await user.click(logTab);
  expect(logTab).toHaveAttribute("data-active");
  expect(logTab).not.toHaveAttribute("data-split-active");
  expect(screen.queryByRole("separator", { name: "Resize source split" }))
    .not.toBeInTheDocument();
});

test("resizes a source split by dragging or using the separator keyboard controls", () => {
  render(
    <TerminalPane
      session={session}
      api={paneAPI()}
      active
      layoutVersion={1}
      tabShortcut="Meta+L"
      onDeselect={() => undefined}
      renderTerminal={() => <div>terminal</div>}
    />,
  );

  fireEvent.click(screen.getByRole("tab", { name: "Files" }), {
    metaKey: true,
  });
  const stage = document.querySelector(".terminal-source-stage");
  vi.spyOn(stage!, "getBoundingClientRect").mockReturnValue({
    bottom: 600,
    height: 500,
    left: 100,
    right: 1100,
    top: 100,
    width: 1000,
    x: 100,
    y: 100,
    toJSON: () => ({}),
  });
  const separator = screen.getByRole("separator", {
    name: "Resize source split",
  });

  fireEvent.pointerDown(separator, { clientX: 600 });
  fireEvent.pointerMove(document, { clientX: 750 });
  expect(separator).toHaveAttribute("aria-valuenow", "65");
  expect(stage).toHaveStyle({ "--pane-primary-size": "65%" });

  fireEvent.pointerMove(document, { clientX: 1200 });
  expect(separator).toHaveAttribute("aria-valuenow", "80");
  fireEvent.pointerUp(document, { clientX: 1200 });

  fireEvent.keyDown(separator, { key: "ArrowLeft" });
  expect(separator).toHaveAttribute("aria-valuenow", "75");
  fireEvent.keyDown(separator, { key: "Home" });
  expect(separator).toHaveAttribute("aria-valuenow", "20");
  fireEvent.keyDown(separator, { key: "End" });
  expect(separator).toHaveAttribute("aria-valuenow", "80");

  fireEvent.pointerDown(separator, { clientX: 900, pointerId: 7 });
  fireEvent.pointerMove(document, { clientX: 500, pointerId: 8 });
  expect(separator).toHaveAttribute("aria-valuenow", "80");
  fireEvent.pointerCancel(document, { clientX: 0, pointerId: 7 });
  expect(separator).toHaveAttribute("aria-valuenow", "80");
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

test("does not render a selection checkbox in the pane rail", () => {
  render(
    <TerminalPane
      session={session}
      api={paneAPI()}
      active
      layoutVersion={1}
      tabShortcut="Meta+L"
      onDeselect={() => undefined}
      renderTerminal={() => <div>terminal</div>}
    />,
  );

  expect(
    screen.queryByRole("checkbox", { name: "Deselect Terminal one" }),
  ).not.toBeInTheDocument();
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

test("repairs a split when its primary annotation is completed", async () => {
  const user = userEvent.setup();
  const completeAnnotation = vi.fn().mockResolvedValue({
    annotationId: "annotation-1",
    comments: [],
  });
  render(
    <TerminalPane
      session={session}
      api={paneAPI({
        getCurrentAnnotation: vi.fn().mockResolvedValue({
          id: "annotation-1",
          terminalId: "terminal-1",
          filename: "review.md",
          format: "markdown",
          content: "# Review",
          createdAt: "2026-07-30T00:00:00Z",
        }),
        completeAnnotation,
      })}
      active
      layoutVersion={1}
      annotationRevision={0}
      tabShortcut="Meta+L"
      onDeselect={() => undefined}
      renderTerminal={() => <div>terminal</div>}
    />,
  );

  expect(await screen.findByRole("tab", { name: "Annotation" }))
    .toHaveAttribute("data-active");
  fireEvent.click(screen.getByRole("tab", { name: "Files" }), {
    metaKey: true,
  });
  await user.click(screen.getByRole("button", { name: "Send comments" }));

  await waitFor(() => expect(completeAnnotation).toHaveBeenCalledOnce());
  expect(screen.queryByRole("tab", { name: "Annotation" }))
    .not.toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Terminal" }))
    .toHaveAttribute("data-active");
  expect(screen.getByRole("tab", { name: "Files" }))
    .toHaveAttribute("data-split-active", "true");
});

test("closes a split when its secondary annotation is completed", async () => {
  const user = userEvent.setup();
  render(
    <TerminalPane
      session={session}
      api={paneAPI({
        getCurrentAnnotation: vi.fn().mockResolvedValue({
          id: "annotation-1",
          terminalId: "terminal-1",
          filename: "review.md",
          format: "markdown",
          content: "# Review",
          createdAt: "2026-07-30T00:00:00Z",
        }),
      })}
      active
      layoutVersion={1}
      annotationRevision={0}
      tabShortcut="Meta+L"
      onDeselect={() => undefined}
      renderTerminal={() => <div>terminal</div>}
    />,
  );

  const annotationTab = await screen.findByRole("tab", {
    name: "Annotation",
  });
  await user.click(screen.getByRole("tab", { name: "Terminal" }));
  fireEvent.click(annotationTab, { metaKey: true });
  await user.click(screen.getByRole("button", { name: "Send comments" }));

  await waitFor(() => expect(
    screen.queryByRole("tab", { name: "Annotation" }),
  ).not.toBeInTheDocument());
  expect(screen.getByRole("tab", { name: "Terminal" }))
    .toHaveAttribute("data-active");
  expect(screen.queryByRole("separator", { name: "Resize source split" }))
    .not.toBeInTheDocument();
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
