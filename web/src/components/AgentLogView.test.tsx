import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, useRef } from "react";
import { afterEach, beforeEach, vi } from "vitest";
import type { ApiClient } from "../api";
import type { AgentTranscript, Session } from "../types";
import { AgentLogView } from "./AgentLogView";

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: mermaidMocks,
}));

beforeEach(() => {
  mermaidMocks.initialize.mockClear();
  mermaidMocks.render.mockReset().mockResolvedValue({
    svg: '<svg role="img" aria-label="Plan to build diagram"></svg>',
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const session: Session = {
  id: "terminal-1",
  name: "Terminal one",
  state: "running",
  cwd: "/repo",
  agent: "codex",
  createdAt: "2026-07-30T01:00:00Z",
};

const initialLog: AgentTranscript = {
  agent: "codex",
  sessionId: "session-1",
  startCursor: "100",
  endCursor: "200",
  nextCursor: "100",
  entries: [
    {
      id: "1-0",
      kind: "message",
      role: "assistant",
      timestamp: "2026-07-30T01:02:03Z",
      content: "# Result\n\n- one\n- two\n\n| Check | Result |\n| --- | --- |\n| Tests | Pass |\n\n`go test ./...`\n\n```typescript\nconst answer = 42;\n```\n\n<script>alert('no')</script>",
    },
    {
      id: "2-0",
      kind: "tool_group",
      toolCalls: 3,
    },
  ],
};

test("applies the configured agent log font size", () => {
  const api = {
    getAgentLog: vi.fn().mockResolvedValue({ log: initialLog, etag: 'W/"first"' }),
  } as unknown as ApiClient;

  render(<AgentLogView session={session} api={api} active={false} fontSize={17} />);

  const agentLogRegion = screen.getByRole("region", { name: "Agent log" });
  expect(agentLogRegion).toHaveStyle({
    "--agent-log-font-size": "17px",
  });
  expect(agentLogRegion).not.toHaveAttribute("role", "region");
});

test("does not mount an animated loading skeleton while inactive", () => {
  const api = { getAgentLog: vi.fn() } as unknown as ApiClient;

  render(<AgentLogView session={session} api={api} active={false} />);

  expect(screen.queryByLabelText("Loading agent log")).not.toBeInTheDocument();
  expect(api.getAgentLog).not.toHaveBeenCalled();
});

test("renders normalized transcript as safe semantic HTML", async () => {
  const api = {
    getAgentLog: vi.fn().mockResolvedValue({ log: initialLog, etag: 'W/"first"' }),
  } as unknown as ApiClient;
  render(<AgentLogView session={session} api={api} active />);

  expect(await screen.findByRole("heading", { name: "Result" })).toBeInTheDocument();
  expect(screen.getByRole("list")).toHaveTextContent(/one\s+two/);
  const table = screen.getByRole("table");
  expect(within(table).getByRole("columnheader", { name: "Check" })).toBeVisible();
  expect(within(table).getByRole("columnheader", { name: "Result" })).toBeVisible();
  expect(within(table).getByRole("cell", { name: "Tests" })).toBeVisible();
  expect(within(table).getByRole("cell", { name: "Pass" })).toBeVisible();
  expect(screen.getByText("go test ./...")).toBeInstanceOf(HTMLElement);
  expect(screen.getByText("const answer = 42;")).toHaveClass("language-typescript");
  expect(screen.getByText("<script>alert('no')</script>")).toBeInTheDocument();
  expect(document.querySelector("script")).toBeNull();
  expect(screen.getByText("3 tool calls")).toBeInTheDocument();
  expect(screen.getByText("3 tool calls").closest("details")).toBeInTheDocument();
});

test("renders normalized image and video entries with accessible media controls", async () => {
  const mediaLog = {
    agent: "codex",
    sessionId: "session-media",
    entries: [
      {
        id: "image-1",
        kind: "image",
        role: "user",
        url: "https://example.com/screenshot.png",
        mimeType: "image/png",
        alt: "Build screenshot",
      },
      {
        id: "video-1",
        kind: "video",
        role: "assistant",
        url: "https://example.com/recording.mp4",
        mimeType: "video/mp4",
        alt: "Build recording",
      },
    ],
  } as unknown as AgentTranscript;
  const api = {
    getAgentLog: vi.fn().mockResolvedValue({ log: mediaLog, etag: 'W/"media"' }),
  } as unknown as ApiClient;

  render(<AgentLogView session={session} api={api} active />);

  const image = await screen.findByRole("img", { name: "Build screenshot" });
  expect(image).toHaveAttribute("src", "https://example.com/screenshot.png");
  expect(image).toHaveClass("agent-log-media");

  const video = document.querySelector("video");
  expect(video).toBeInTheDocument();
  expect(video).toHaveAttribute("aria-label", "Build recording");
  expect(video).toHaveAttribute("controls");
  expect(video).toHaveAttribute("preload", "metadata");
  expect(video).toHaveClass("agent-log-media");
  expect(video?.querySelector("source")).toHaveAttribute(
    "src",
    "https://example.com/recording.mp4",
  );
  expect(video?.querySelector("source")).toHaveAttribute("type", "video/mp4");
});

test("omits Codex runtime-injected user entries while preserving ordinary and assistant content", async () => {
  const filteredLog = {
    agent: "codex",
    sessionId: "session-filtered",
    entries: [
      {
        id: "environment-context",
        kind: "message",
        role: "user",
        content: "<environment_context>injected environment</environment_context>",
      },
      {
        id: "agents-instructions",
        kind: "message",
        role: "user",
        content: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>injected instructions</INSTRUCTIONS>",
      },
      {
        id: "ordinary-user",
        kind: "message",
        role: "user",
        content: "Visible user request",
      },
      {
        id: "assistant-content",
        kind: "message",
        role: "assistant",
        content: "Assistant mentions <environment_context>ordinary content</environment_context>",
      },
    ],
  } as unknown as AgentTranscript;
  const api = {
    getAgentLog: vi.fn().mockResolvedValue({ log: filteredLog, etag: 'W/"filtered"' }),
  } as unknown as ApiClient;

  render(<AgentLogView session={session} api={api} active />);

  expect(await screen.findByText("Visible user request")).toBeInTheDocument();
  expect(screen.getByText(/Assistant mentions/)).toBeInTheDocument();
  expect(screen.queryByText(/injected environment/)).not.toBeInTheDocument();
  expect(screen.queryByText(/injected instructions/)).not.toBeInTheDocument();
});

test("reuses one time formatter for timestamped entries", async () => {
  const OriginalDateTimeFormat = Intl.DateTimeFormat;
  class CountingDateTimeFormat {
    constructor(locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
      return new OriginalDateTimeFormat(locales, options);
    }
  }
  const dateTimeFormat = vi
    .spyOn(Intl, "DateTimeFormat")
    .mockImplementation(CountingDateTimeFormat as unknown as typeof Intl.DateTimeFormat);
  const timestampedLog: AgentTranscript = {
    ...initialLog,
    entries: [
      {
        id: "timestamp-1",
        kind: "message",
        role: "assistant",
        timestamp: "2026-07-30T01:02:03Z",
        content: "First timestamped entry",
      },
      {
        id: "timestamp-2",
        kind: "message",
        role: "assistant",
        timestamp: "2026-07-30T01:02:04Z",
        content: "Second timestamped entry",
      },
    ],
  };
  const api = {
    getAgentLog: vi.fn().mockResolvedValue({ log: timestampedLog, etag: 'W/"time"' }),
  } as unknown as ApiClient;

  render(<AgentLogView session={session} api={api} active />);

  expect(await screen.findByText("First timestamped entry")).toBeInTheDocument();
  expect(screen.getByText("Second timestamped entry")).toBeInTheDocument();
  expect(dateTimeFormat).not.toHaveBeenCalled();
});

test("expands tool activity and pairs each call with its matching result", async () => {
  const user = userEvent.setup();
  const pairedLog: AgentTranscript = {
    ...initialLog,
    entries: [
      {
        id: "tools-1",
        kind: "tool_group",
        toolCalls: 2,
        entries: [
          {
            id: "call-1",
            kind: "tool",
            callId: "call-1",
            title: "exec_command",
            content: "secret command 1",
          },
          {
            id: "call-2",
            kind: "tool",
            callId: "call-2",
            title: "read_file",
            content: "secret command 2",
          },
          {
            id: "result-2",
            kind: "tool_result",
            callId: "call-2",
            title: "read_file",
            content: "secret result 2",
          },
          {
            id: "result-1",
            kind: "tool_result",
            callId: "call-1",
            title: "exec_command",
            content: "secret result 1",
          },
        ],
      },
    ],
  };
  const api = {
    getAgentLog: vi.fn().mockResolvedValue({
      log: pairedLog,
      etag: 'W/"paired"',
    }),
  } as unknown as ApiClient;

  render(<AgentLogView session={session} api={api} active />);

  const disclosure = await screen.findByText("2 tool calls");
  expect(disclosure.closest("details")).not.toHaveAttribute("open");
  expect(screen.queryByText("secret command 1")).not.toBeVisible();

  await user.click(disclosure);

  const firstExecution = screen.getByRole("article", { name: /exec_command/ });
  const secondExecution = screen.getByRole("article", { name: /read_file/ });
  expect(within(firstExecution).getByText("secret command 1")).toBeVisible();
  expect(within(firstExecution).getByText("secret result 1")).toBeVisible();
  expect(within(firstExecution).queryByText("secret result 2")).not.toBeInTheDocument();
  expect(within(secondExecution).getByText("secret command 2")).toBeVisible();
  expect(within(secondExecution).getByText("secret result 2")).toBeVisible();
});

test("pairs multiple unkeyed results with the earliest unmatched calls without rescanning executions", async () => {
  const originalFind = Array.prototype.find;
  let executionSearches = 0;
  vi.spyOn(Array.prototype, "find").mockImplementation(function (
    this: unknown[],
    predicate: (value: unknown, index: number, obj: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    const values = this;
    if (
      values.some(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          !("kind" in value) &&
          ("call" in value || "result" in value),
      )
    ) {
      executionSearches++;
    }
    return originalFind.call(values, predicate, thisArg);
  });
  const user = userEvent.setup();
  const unkeyedLog: AgentTranscript = {
    ...initialLog,
    entries: [
      {
        id: "tools-unkeyed",
        kind: "tool_group",
        toolCalls: 3,
        entries: [
          { id: "call-a", kind: "tool", title: "first_tool", content: "call A" },
          { id: "call-b", kind: "tool", title: "second_tool", content: "call B" },
          { id: "call-c", kind: "tool", title: "third_tool", content: "call C" },
          { id: "result-a", kind: "tool_result", content: "result A" },
          { id: "result-b", kind: "tool_result", content: "result B" },
          { id: "result-c", kind: "tool_result", content: "result C" },
        ],
      },
    ],
  };
  const api = {
    getAgentLog: vi.fn().mockResolvedValue({
      log: unkeyedLog,
      etag: 'W/"unkeyed"',
    }),
  } as unknown as ApiClient;

  render(<AgentLogView session={session} api={api} active />);
  await user.click(await screen.findByText("3 tool calls"));

  expect(
    within(screen.getByRole("article", { name: /first_tool/ })).getByText("result A"),
  ).toBeVisible();
  expect(
    within(screen.getByRole("article", { name: /second_tool/ })).getByText("result B"),
  ).toBeVisible();
  expect(
    within(screen.getByRole("article", { name: /third_tool/ })).getByText("result C"),
  ).toBeVisible();
  expect(executionSearches).toBe(0);
});

test("renders Mermaid fenced code as a diagram", async () => {
  const mermaidLog: AgentTranscript = {
    ...initialLog,
    entries: [
      {
        id: "mermaid-1",
        kind: "message",
        role: "assistant",
        content: [
          "```mermaid",
          "flowchart LR",
          "  Plan --> Build",
          "```",
        ].join("\n"),
      },
    ],
  };
  const api = {
    getAgentLog: vi.fn().mockResolvedValue({ log: mermaidLog, etag: 'W/"mermaid"' }),
  } as unknown as ApiClient;

  render(<AgentLogView session={session} api={api} active />);

  const diagram = await screen.findByRole("figure", { name: "Mermaid diagram" });
  await waitFor(() => {
    expect(diagram.querySelector("svg")).toBeInTheDocument();
  });
  expect(diagram.querySelector("code.language-mermaid")).toBeNull();
});

test("preserves Mermaid source when the diagram cannot be rendered", async () => {
  mermaidMocks.render.mockRejectedValueOnce(new Error("Invalid diagram"));
  const invalidMermaidLog: AgentTranscript = {
    ...initialLog,
    entries: [
      {
        id: "mermaid-invalid",
        kind: "message",
        role: "assistant",
        content: "```mermaid\nflowchart definitely-invalid\n```",
      },
    ],
  };
  const api = {
    getAgentLog: vi.fn().mockResolvedValue({
      log: invalidMermaidLog,
      etag: 'W/"invalid-mermaid"',
    }),
  } as unknown as ApiClient;

  render(<AgentLogView session={session} api={api} active />);

  const diagram = await screen.findByRole("figure", { name: "Mermaid diagram" });
  expect(within(diagram).getByText(/flowchart definitely-invalid/)).toBeVisible();
  expect(
    await within(diagram).findByText("Diagram could not be rendered."),
  ).toBeVisible();
});

test("polls with the previous etag only while active", async () => {
  vi.useFakeTimers();
  const getAgentLog = vi
    .fn()
    .mockResolvedValueOnce({ log: initialLog, etag: 'W/"first"' })
    .mockResolvedValueOnce({ log: null, etag: 'W/"first"' });
  const api = { getAgentLog } as unknown as ApiClient;
  const { rerender } = render(<AgentLogView session={session} api={api} active />);
  await act(async () => Promise.resolve());
  expect(getAgentLog).toHaveBeenCalledWith("terminal-1", undefined);

  await act(async () => {
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
  });
  expect(getAgentLog).toHaveBeenLastCalledWith("terminal-1", {
    after: "200",
    etag: 'W/"first"',
  });

  rerender(<AgentLogView session={session} api={api} active={false} />);
  await act(async () => {
    vi.advanceTimersByTime(2000);
    await Promise.resolve();
  });
  expect(getAgentLog).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});

test("loads older entries from the top and preserves the reading position", async () => {
  const user = userEvent.setup();
  const olderLog: AgentTranscript = {
    agent: "codex",
    sessionId: "session-1",
    startCursor: "0",
    endCursor: "100",
    entries: [
      { id: "0-0", kind: "message", role: "assistant", content: "Oldest message" },
      { id: "50-0", kind: "tool_group", toolCalls: 2 },
    ],
  };
  let scrollHeight = 1000;
  const getAgentLog = vi
    .fn()
    .mockResolvedValueOnce({ log: initialLog, etag: 'W/"first"' })
    .mockImplementationOnce(async () => {
      scrollHeight = 1600;
      return { log: olderLog, etag: 'W/"first"' };
    });
  const api = { getAgentLog } as unknown as ApiClient;
  render(<AgentLogView session={session} api={api} active />);
  await screen.findByRole("heading", { name: "Result" });
  const viewport = screen.getByLabelText("Agent log", {
    selector: '[data-slot="message-scroller-viewport"]',
  });
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  fireEvent.scroll(viewport, { target: { scrollTop: 250 } });
  let scrollTop = viewport.scrollTop;
  const scrollAssignments: number[] = [];
  Object.defineProperty(viewport, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
      scrollAssignments.push(value);
    },
  });
  const animationFrames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    animationFrames.push(callback);
    return animationFrames.length;
  });

  await user.click(screen.getByRole("button", { name: "Load more" }));

  expect(await screen.findByText("Oldest message")).toBeInTheDocument();
  expect(screen.getByText("2 tool calls")).toBeInTheDocument();
  expect(getAgentLog).toHaveBeenNthCalledWith(2, "terminal-1", {
    before: "100",
  });
  expect(animationFrames.length).toBeGreaterThan(0);
  const firstFrame = animationFrames.splice(0);
  act(() => firstFrame.forEach((callback) => callback(0)));
  expect(scrollAssignments).not.toContain(850);
  expect(animationFrames.length).toBeGreaterThan(0);
  const secondFrame = animationFrames.splice(0);
  act(() => secondFrame.forEach((callback) => callback(16)));
  expect(viewport.scrollTop).toBe(850);
  expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
});

test("does not reuse a scroll anchor after an older page from another transcript", async () => {
  vi.useFakeTimers();
  const mismatchedOlderLog: AgentTranscript = {
    agent: "codex",
    sessionId: "session-other",
    startCursor: "0",
    endCursor: "100",
    entries: [
      { id: "other-0", kind: "message", role: "assistant", content: "Other transcript" },
    ],
  };
  const refreshedLog: AgentTranscript = {
    agent: "codex",
    sessionId: "session-1",
    startCursor: "50",
    endCursor: "250",
    entries: [
      { id: "refreshed-0", kind: "message", role: "assistant", content: "Refreshed log" },
    ],
  };
  const getAgentLog = vi
    .fn()
    .mockResolvedValueOnce({ log: initialLog, etag: 'W/"first"' })
    .mockResolvedValueOnce({ log: mismatchedOlderLog, etag: 'W/"other"' })
    .mockResolvedValueOnce({ log: refreshedLog, etag: 'W/"refreshed"' });
  const api = { getAgentLog } as unknown as ApiClient;
  render(<AgentLogView session={session} api={api} active />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByRole("heading", { name: "Result" })).toBeInTheDocument();

  const viewport = screen.getByLabelText("Agent log", {
    selector: '[data-slot="message-scroller-viewport"]',
  });
  let scrollTop = 250;
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    get: () => 1000,
  });
  const scrollAssignments: number[] = [];
  Object.defineProperty(viewport, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
      scrollAssignments.push(value);
    },
  });
  const animationFrames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    animationFrames.push(callback);
    return animationFrames.length;
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await Promise.resolve();
  });
  await act(async () => {
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
  });

  expect(screen.getByText("Refreshed log")).toBeInTheDocument();
  while (animationFrames.length > 0) {
    const frame = animationFrames.splice(0);
    act(() => frame.forEach((callback) => callback(0)));
  }
  expect(scrollAssignments).not.toContain(250);
});

test("offers older history when the newest page has no displayable entries", async () => {
  const user = userEvent.setup();
  const emptyNewest: AgentTranscript = {
    agent: "codex",
    sessionId: "session-1",
    startCursor: "100",
    endCursor: "200",
    nextCursor: "100",
    entries: [],
  };
  const olderLog: AgentTranscript = {
    agent: "codex",
    sessionId: "session-1",
    startCursor: "0",
    endCursor: "100",
    entries: [
      { id: "0-0", kind: "message", role: "assistant", content: "Older message" },
    ],
  };
  const getAgentLog = vi
    .fn()
    .mockResolvedValueOnce({ log: emptyNewest, etag: 'W/"first"' })
    .mockResolvedValueOnce({ log: olderLog, etag: 'W/"first"' });
  const api = { getAgentLog } as unknown as ApiClient;
  render(<AgentLogView session={session} api={api} active />);

  await user.click(await screen.findByRole("button", { name: "Load more" }));

  expect(await screen.findByText("Older message")).toBeInTheDocument();
  expect(screen.queryByText("Transcript is empty")).not.toBeInTheDocument();
});

test("discards an older-page response after the terminal changes", async () => {
  const user = userEvent.setup();
  let resolveOlder: ((value: {
    log: AgentTranscript;
    etag: string;
  }) => void) | undefined;
  const pendingOlder = new Promise<{
    log: AgentTranscript;
    etag: string;
  }>((resolve) => {
    resolveOlder = resolve;
  });
  const replacementLog: AgentTranscript = {
    agent: "claude",
    sessionId: "session-2",
    startCursor: "0",
    endCursor: "50",
    entries: [
      { id: "0-0", kind: "message", role: "assistant", content: "Replacement session" },
    ],
  };
  const staleOlder: AgentTranscript = {
    agent: "codex",
    sessionId: "session-1",
    startCursor: "0",
    endCursor: "100",
    entries: [
      { id: "0-0", kind: "message", role: "assistant", content: "Stale older page" },
    ],
  };
  const getAgentLog = vi
    .fn()
    .mockResolvedValueOnce({ log: initialLog, etag: 'W/"first"' })
    .mockReturnValueOnce(pendingOlder)
    .mockResolvedValueOnce({ log: replacementLog, etag: 'W/"replacement"' });
  const api = { getAgentLog } as unknown as ApiClient;
  const { rerender } = render(
    <AgentLogView session={session} api={api} active />,
  );
  await screen.findByRole("heading", { name: "Result" });
  await user.click(screen.getByRole("button", { name: "Load more" }));

  rerender(
    <AgentLogView
      session={{ ...session, id: "terminal-2", agent: "claude" }}
      api={api}
      active
    />,
  );
  expect(await screen.findByText("Replacement session")).toBeInTheDocument();

  await act(async () => {
    resolveOlder?.({ log: staleOlder, etag: 'W/"stale"' });
    await pendingOlder;
  });

  expect(screen.getByText("Replacement session")).toBeInTheDocument();
  expect(screen.queryByText("Stale older page")).not.toBeInTheDocument();
});

test("discards an older-page response after the linked transcript changes", async () => {
  vi.useFakeTimers();
  let resolveOlder: ((value: {
    log: AgentTranscript;
    etag: string;
  }) => void) | undefined;
  const pendingOlder = new Promise<{
    log: AgentTranscript;
    etag: string;
  }>((resolve) => {
    resolveOlder = resolve;
  });
  const replacementLog: AgentTranscript = {
    agent: "codex",
    sessionId: "session-2",
    startCursor: "0",
    endCursor: "50",
    entries: [
      { id: "0-0", kind: "message", role: "assistant", content: "New transcript" },
    ],
  };
  const staleOlder: AgentTranscript = {
    agent: "codex",
    sessionId: "session-1",
    startCursor: "0",
    endCursor: "100",
    entries: [
      { id: "0-0", kind: "message", role: "assistant", content: "Old transcript history" },
    ],
  };
  const getAgentLog = vi
    .fn()
    .mockResolvedValueOnce({ log: initialLog, etag: 'W/"first"' })
    .mockReturnValueOnce(pendingOlder)
    .mockResolvedValueOnce({ log: replacementLog, etag: 'W/"replacement"' });
  const api = { getAgentLog } as unknown as ApiClient;
  render(<AgentLogView session={session} api={api} active />);
  await act(async () => Promise.resolve());
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));

  await act(async () => {
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
  });
  expect(screen.getByText("New transcript")).toBeInTheDocument();

  await act(async () => {
    resolveOlder?.({ log: staleOlder, etag: 'W/"stale"' });
    await pendingOlder;
  });

  expect(screen.getByText("New transcript")).toBeInTheDocument();
  expect(screen.queryByText("Old transcript history")).not.toBeInTheDocument();
  vi.useRealTimers();
});

test("appends only records after the observed live edge", async () => {
  vi.useFakeTimers();
  const appendedLog: AgentTranscript = {
    agent: "codex",
    sessionId: "session-1",
    startCursor: "200",
    endCursor: "240",
    entries: [
      { id: "200-0", kind: "tool_group", toolCalls: 2 },
      { id: "220-0", kind: "message", role: "assistant", content: "Newest message" },
    ],
  };
  const getAgentLog = vi
    .fn()
    .mockResolvedValueOnce({ log: initialLog, etag: 'W/"first"' })
    .mockResolvedValueOnce({ log: appendedLog, etag: 'W/"second"' });
  const api = { getAgentLog } as unknown as ApiClient;
  render(<AgentLogView session={session} api={api} active />);
  await act(async () => Promise.resolve());

  await act(async () => {
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
  });

  expect(getAgentLog).toHaveBeenLastCalledWith("terminal-1", {
    after: "200",
    etag: 'W/"first"',
  });
  expect(screen.getByText("Newest message")).toBeInTheDocument();
  expect(screen.getByText("5 tool calls")).toBeInTheDocument();
  vi.useRealTimers();
});

test("pairs a call with its result after adjacent live pages merge", async () => {
  vi.useFakeTimers();
  const firstPage: AgentTranscript = {
    agent: "codex",
    sessionId: "session-1",
    startCursor: "100",
    endCursor: "200",
    entries: [
      {
        id: "call-group",
        kind: "tool_group",
        toolCalls: 1,
        entries: [
          {
            id: "call-page-1",
            kind: "tool",
            callId: "page-boundary-call",
            title: "exec_command",
            content: "page one command",
          },
        ],
      },
    ],
  };
  const secondPage: AgentTranscript = {
    agent: "codex",
    sessionId: "session-1",
    startCursor: "200",
    endCursor: "240",
    entries: [
      {
        id: "result-group",
        kind: "tool_group",
        entries: [
          {
            id: "result-page-2",
            kind: "tool_result",
            callId: "page-boundary-call",
            title: "exec_command",
            content: "page two result",
          },
        ],
      },
    ],
  };
  const getAgentLog = vi
    .fn()
    .mockResolvedValueOnce({ log: firstPage, etag: 'W/"first"' })
    .mockResolvedValueOnce({ log: secondPage, etag: 'W/"second"' });
  const api = { getAgentLog } as unknown as ApiClient;
  render(<AgentLogView session={session} api={api} active />);
  await act(async () => Promise.resolve());

  await act(async () => {
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
  });

  fireEvent.click(screen.getByText("1 tool call"));
  const execution = screen.getByRole("article", { name: /exec_command/ });
  expect(within(execution).getByText("page one command")).toBeVisible();
  expect(within(execution).getByText("page two result")).toBeVisible();
  vi.useRealTimers();
});

test("replaces the transcript when a linked agent session changes", async () => {
  const secondLog: AgentTranscript = {
    agent: "claude",
    sessionId: "session-2",
    entries: [{ id: "1-0", kind: "message", role: "assistant", content: "Newest session" }],
  };
  const getAgentLog = vi
    .fn()
    .mockResolvedValueOnce({ log: initialLog, etag: 'W/"first"' })
    .mockResolvedValueOnce({ log: secondLog, etag: 'W/"second"' });
  const api = { getAgentLog } as unknown as ApiClient;
  const { rerender } = render(<AgentLogView session={session} api={api} active />);
  expect(await screen.findByRole("heading", { name: "Result" })).toBeInTheDocument();

  rerender(<AgentLogView session={{ ...session, agent: "claude" }} api={api} active />);
  expect(await screen.findByText("Newest session")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Result" })).not.toBeInTheDocument();
});

test("does not commit the previous transcript while switching session identity", async () => {
  const getAgentLog = vi
    .fn()
    .mockResolvedValue({ log: initialLog, etag: 'W/"first"' });
  const api = { getAgentLog } as unknown as ApiClient;
  let textDuringCommit = "";

  function SessionSwitchProbe({
    session: currentSession,
    active: isActive,
  }: {
    session: Session;
    active: boolean;
  }) {
    const containerRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
      if (currentSession.agent === "claude") {
        textDuringCommit = containerRef.current?.textContent ?? "";
      }
    }, [currentSession.agent]);
    return (
      <div ref={containerRef}>
        <AgentLogView session={currentSession} api={api} active={isActive} />
      </div>
    );
  }

  const { rerender } = render(<SessionSwitchProbe session={session} active />);
  expect(await screen.findByRole("heading", { name: "Result" })).toBeInTheDocument();

  rerender(
    <SessionSwitchProbe
      session={{ ...session, agent: "claude" }}
      active={false}
    />,
  );

  expect(textDuringCommit).not.toContain("Result");
});

test("explains unavailable logs and retries automatically", async () => {
  const api = {
    getAgentLog: vi.fn().mockRejectedValue({
      status: 404,
      code: "agent_log_not_found",
      message: "The linked agent log is not available yet.",
    }),
  } as unknown as ApiClient;
  render(<AgentLogView session={{ ...session, agent: undefined }} api={api} active />);

  await waitFor(() => {
    expect(screen.getByText("Agent log will appear when Claude or Codex starts here.")).toBeInTheDocument();
  });
});

test("distinguishes a linked transcript that has not appeared yet", async () => {
  const api = {
    getAgentLog: vi.fn().mockRejectedValue({
      status: 404,
      code: "agent_log_not_found",
      message: "The linked agent log is not available yet.",
    }),
  } as unknown as ApiClient;
  render(<AgentLogView session={{ ...session, agent: "claude" }} api={api} active />);

  expect(
    await screen.findByText("Waiting for the linked Claude transcript…"),
  ).toBeInTheDocument();
});

test("shows an explicit empty state for an empty transcript", async () => {
  const api = {
    getAgentLog: vi.fn().mockResolvedValue({
      log: { ...initialLog, entries: null, nextCursor: undefined },
      etag: 'W/"empty"',
    }),
  } as unknown as ApiClient;
  render(<AgentLogView session={session} api={api} active />);

  expect(await screen.findByText("Transcript is empty")).toBeInTheDocument();
  expect(screen.getByText("Waiting for the first agent event…")).toBeInTheDocument();
});

test("keeps the current log visible while a refresh is failing", async () => {
  vi.useFakeTimers();
  const getAgentLog = vi
    .fn()
    .mockResolvedValueOnce({ log: initialLog, etag: 'W/"first"' })
    .mockRejectedValueOnce(new Error("Temporary failure"));
  const api = { getAgentLog } as unknown as ApiClient;
  render(<AgentLogView session={session} api={api} active />);
  await act(async () => Promise.resolve());

  await act(async () => {
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
  });

  expect(screen.getByRole("heading", { name: "Result" })).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Refresh interrupted. Retrying automatically.",
  );
  vi.useRealTimers();
});
