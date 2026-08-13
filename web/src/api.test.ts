import { ApiClient } from "./api";
import type {
  AgentSummary,
  AllSession,
  AnnotationSession,
  Project,
  SelectionSnapshot,
} from "./types";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

test("reads and replaces the shared v1 selection envelope", async () => {
  const selection: SelectionSnapshot = {
    terminalIds: ["terminal-1"],
    manualTerminalIds: ["terminal-1"],
    pinnedTerminalIds: [],
    focusedTerminalId: "terminal-1",
    filters: { statuses: [], cwds: [] },
    revision: 4,
  };
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() => jsonResponse({ ok: true, result: selection }))
    .mockImplementationOnce(() =>
      jsonResponse({ ok: true, result: { ...selection, revision: 5 } }),
    );
  const api = new ApiClient("token");

  expect(await api.getSelection()).toEqual(selection);
  expect(await api.replaceSelection({
    manualTerminalIds: ["terminal-1"],
    pinnedTerminalIds: [],
    focusedTerminalId: "terminal-1",
    filters: { statuses: [], cwds: [] },
    expectedRevision: 4,
  })).toEqual({ ...selection, revision: 5 });
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "/api/v1/selection",
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({
        manualTerminalIds: ["terminal-1"],
        pinnedTerminalIds: [],
        focusedTerminalId: "terminal-1",
        filters: { statuses: [], cwds: [] },
        expectedRevision: 4,
      }),
    }),
  );
});

test("lists all sessions and resumes a history session with replacement selection", async () => {
  const allSession: AllSession = {
    id: "history-1",
    agent: "codex",
    sessionId: "session/one",
    title: "Investigate the relay",
    cwd: "/repo",
    updatedAt: "2026-08-13T00:00:00Z",
    state: "resume",
  };
  const selection: SelectionSnapshot = {
    terminalIds: ["terminal-1"],
    manualTerminalIds: ["terminal-1"],
    pinnedTerminalIds: [],
    focusedTerminalId: "terminal-1",
    filters: { statuses: [], cwds: [] },
    revision: 5,
  };
  const terminal = {
    id: "terminal-1",
    name: "Codex",
    state: "running" as const,
    cwd: "/repo",
    createdAt: "2026-08-13T00:00:01Z",
  };
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() => jsonResponse([allSession]))
    .mockImplementationOnce(() =>
      jsonResponse({ terminal, selection }),
    );
  const api = new ApiClient("token");

  expect(await api.listAllSessions()).toEqual([allSession]);
  expect(await api.resumeAllSession("codex", "session/one")).toEqual({
    terminal,
    selection,
  });
  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    "/api/all-sessions",
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "/api/all-sessions/codex/session%2Fone/resume",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ selectionMode: "replace" }),
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    }),
  );
});

test("turns a non-JSON v1 error response into an API error", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("upstream failure", {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    }),
  );
  const api = new ApiClient("token");

  await expect(api.getSelection()).rejects.toMatchObject({
    status: 502,
    code: "request_failed",
    message: "The request failed.",
  });
});

test("marks an agent summary as read and returns the normalized summary", async () => {
  const summary: AgentSummary = {
    terminalId: "terminal/one",
    provider: "codex",
    status: "waiting",
    summary: "The agent is waiting for input.",
    generatedAt: "2026-08-05T00:00:00Z",
    unread: false,
  };
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() => jsonResponse(summary));
  const api = new ApiClient("token");

  expect(await api.markAgentSummaryRead(summary.terminalId)).toEqual(summary);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/agent-summaries/terminal%2Fone/read",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({}),
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    }),
  );
});

test("marks an agent summary as done and returns the normalized summary", async () => {
  const summary: AgentSummary = {
    terminalId: "terminal/one",
    provider: "codex",
    status: "waiting",
    summary: "The agent is waiting for input.",
    action: "Approve the requested access.",
    priority: "high",
    generatedAt: "2026-08-05T00:00:00Z",
    unread: false,
    done: true,
  };
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() => jsonResponse(summary));
  const api = new ApiClient("token");

  expect(await api.markAgentSummaryDone(summary.terminalId)).toEqual(summary);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/agent-summaries/terminal%2Fone/done",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({}),
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    }),
  );
});

test("executes a structured agent summary option by its normalized ID", async () => {
  const summary: AgentSummary = {
    terminalId: "terminal/one",
    provider: "openai",
    status: "waiting",
    summary: "The agent is waiting for input.",
    action: "Approve the requested access.",
    priority: "high",
    options: [{ id: "option-1", label: "Allow access" }],
    generatedAt: "2026-08-05T00:00:00Z",
    unread: false,
    done: true,
  };
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() => jsonResponse(summary));
  const api = new ApiClient("token");

  expect(await api.executeAgentSummaryOption(summary.terminalId, "option-1", "rendered-screen"))
    .toEqual(summary);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/agent-summaries/terminal%2Fone/options/option-1/execute",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ screenText: "rendered-screen" }),
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    }),
  );
});

test("queues a refresh for all agent summaries", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() => jsonResponse({ queued: 3 }, 202));
  const api = new ApiClient("token");

  expect(await api.refreshAgentSummaries()).toEqual({ queued: 3 });
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/agent-summaries/refresh",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({}),
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    }),
  );
});

test("lists persisted projects", async () => {
  const projects: Project[] = [
    {
      id: "project-1",
      path: "/repo",
      createdAt: "2026-08-12T00:00:00Z",
    },
  ];
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() => jsonResponse(projects));
  const api = new ApiClient("token");

  expect(await api.listProjects()).toEqual(projects);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/projects",
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    }),
  );
});

test("creates a project from its directory path", async () => {
  const project: Project = {
    id: "project-1",
    path: "/repo",
    createdAt: "2026-08-12T00:00:00Z",
  };
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() => jsonResponse(project, 201));
  const api = new ApiClient("token");

  expect(await api.createProject("/repo")).toEqual(project);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/projects",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ path: "/repo" }),
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    }),
  );
});

test("opens the native project directory picker", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() => jsonResponse({ path: "/workspace/selected" }));
  const api = new ApiClient("token");

  expect(await api.pickProjectDirectory()).toBe("/workspace/selected");
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/projects/pick-directory",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    }),
  );
});

test("starts an agent through the v1 endpoint", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() => jsonResponse({
      ok: true,
      result: { agent: { id: "terminal-1", kind: "codex" } },
    }));
  const api = new ApiClient("token");

  await api.startAgent("terminal-1", "codex");

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/v1/agents/terminal-1/start",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ kind: "codex", args: [], timeoutMs: 30000 }),
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    }),
  );
});

test("creates and deletes terminals through v1 with returned selection", async () => {
  const selection: SelectionSnapshot = {
    terminalIds: ["terminal-1"],
    manualTerminalIds: ["terminal-1"],
    pinnedTerminalIds: [],
    focusedTerminalId: "terminal-1",
    filters: { statuses: [], cwds: [] },
    revision: 2,
  };
  const terminal = {
    id: "terminal-1",
    name: "Terminal",
    state: "running" as const,
    cwd: "/repo",
    createdAt: "2026-07-30T00:00:00Z",
  };
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() =>
      jsonResponse({ ok: true, result: { terminal, selection } }, 201),
    )
    .mockImplementationOnce(() =>
      jsonResponse({ ok: true, result: { id: terminal.id, selection } }),
    );
  const api = new ApiClient("token");

  expect(await api.createTerminal("Terminal", "/repo", "replace")).toEqual({
    terminal,
    selection,
  });
  expect(await api.deleteTerminal(terminal.id)).toEqual({
    id: terminal.id,
    selection,
  });
  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    "/api/v1/terminals",
    expect.objectContaining({
      body: JSON.stringify({
        name: "Terminal",
        cwd: "/repo",
        selectionMode: "replace",
      }),
    }),
  );
});

test("includes a project ID when creating a project terminal", async () => {
  const selection: SelectionSnapshot = {
    terminalIds: ["terminal-1"],
    manualTerminalIds: ["terminal-1"],
    pinnedTerminalIds: [],
    focusedTerminalId: "terminal-1",
    filters: { statuses: [], cwds: [] },
    revision: 2,
  };
  const terminal = {
    id: "terminal-1",
    name: "Terminal",
    state: "running" as const,
    cwd: "/repo",
    createdAt: "2026-07-30T00:00:00Z",
  };
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() =>
      jsonResponse({ ok: true, result: { terminal, selection } }, 201),
    );
  const api = new ApiClient("token");

  await api.createTerminal("Terminal", undefined, "replace", "project-1");

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/v1/terminals",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        name: "Terminal",
        selectionMode: "replace",
        projectId: "project-1",
      }),
    }),
  );
});

test("renames a terminal through v1 and unwraps the returned terminal", async () => {
  const terminal = {
    id: "terminal/one",
    name: "Renamed terminal",
    customName: true,
    state: "running" as const,
    cwd: "/repo",
    createdAt: "2026-07-30T00:00:00Z",
  };
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() =>
      jsonResponse({ ok: true, result: { terminal } }),
    );
  const api = new ApiClient("token");

  expect(await api.renameTerminal(terminal.id, terminal.name)).toEqual(terminal);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/v1/terminals/terminal%2Fone",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed terminal" }),
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    }),
  );
});

test("parses split NDJSON event chunks without losing records", async () => {
  const encoder = new TextEncoder();
  vi.spyOn(globalThis, "fetch").mockImplementationOnce(() =>
    Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          '{"sequence":1,"occurredAt":"2026-07-30T00:00:00Z","type":"terminal.created",',
        ));
        controller.enqueue(encoder.encode(
          '"data":{"id":"terminal-1"}}\n{"sequence":2,"occurredAt":"2026-07-30T00:00:01Z",',
        ));
        controller.enqueue(encoder.encode(
          '"type":"selection.changed","data":{"revision":2}}\n',
        ));
        controller.close();
      },
    }), {
      headers: { "Content-Type": "application/x-ndjson" },
    })),
  );
  const api = new ApiClient("token");
  const events: string[] = [];

  await api.subscribeEvents(new AbortController().signal, (event) => {
    events.push(event.type);
  });

  expect(events).toEqual(["terminal.created", "selection.changed"]);
});
test("reads and completes a terminal annotation through v1", async () => {
  const annotation: AnnotationSession = {
    id: "annotation-1",
    terminalId: "terminal-1",
    filename: "review.md",
    format: "markdown",
    content: "# Review",
    createdAt: "2026-07-30T00:00:00Z",
  };
  const comments = [
    {
      kind: "selection" as const,
      body: "Clarify this.",
      quote: "Review",
      startOffset: 2,
      endOffset: 8,
    },
  ];
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() =>
      jsonResponse({ ok: true, result: { annotation } }),
    )
    .mockImplementationOnce(() =>
      jsonResponse({
        ok: true,
        result: { annotationId: annotation.id, comments },
      }),
    );
  const api = new ApiClient("token");

  expect(await api.getCurrentAnnotation("terminal-1")).toEqual(annotation);
  expect(await api.completeAnnotation(annotation.id, comments)).toEqual({
    annotationId: annotation.id,
    comments,
  });
  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    "/api/v1/terminals/terminal-1/annotation",
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "/api/v1/annotations/annotation-1/complete",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ comments }),
    }),
  );
});

test("requests older and appended agent log pages with cursors", async () => {
  const transcript = {
    agent: "codex",
    sessionId: "session-1",
    entries: [],
    startCursor: "100",
    endCursor: "200",
    nextCursor: "100",
  };
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify(transcript), {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: 'W/"older"' },
    }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      ...transcript,
      startCursor: "200",
      endCursor: "220",
      nextCursor: undefined,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: 'W/"newer"' },
    }));
  const api = new ApiClient("token");

  await api.getAgentLog("terminal/one", { before: "100" });
  await api.getAgentLog("terminal/one", {
    after: "200",
    etag: 'W/"older"',
  });

  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    "/api/sessions/terminal%2Fone/agent-log?before=100",
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "/api/sessions/terminal%2Fone/agent-log?after=200",
    expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: "Bearer token",
        "If-None-Match": 'W/"older"',
      }),
    }),
  );
});

test("requests Git change summaries and selected file patches", async () => {
  const snapshot = {
    repoRoot: "/repo",
    branch: "main",
    ahead: 0,
    behind: 0,
    additions: 2,
    deletions: 1,
    files: [],
  };
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockImplementation(() => jsonResponse(snapshot));
  const api = new ApiClient("token");

  await api.getGitChanges("terminal/one");
  await api.getGitChanges("terminal/one", "src/file name.ts");

  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    "/api/sessions/terminal%2Fone/git-changes",
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "/api/sessions/terminal%2Fone/git-changes?path=src%2Ffile+name.ts",
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    }),
  );
});

test("lists, searches, and reads terminal workspace paths", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockImplementation(() => jsonResponse({}));
  const api = new ApiClient("token");

  await api.getWorkspaceDirectory("terminal/one");
  await api.getWorkspaceDirectory("terminal/one", "docs/design notes");
  await api.searchWorkspace("terminal/one", "user guide");
  await api.getWorkspaceFile("terminal/one", "docs/User Guide.md");

  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    "/api/sessions/terminal%2Fone/workspace",
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "/api/sessions/terminal%2Fone/workspace?path=docs%2Fdesign+notes",
    expect.anything(),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    "/api/sessions/terminal%2Fone/workspace/search?query=user+guide",
    expect.anything(),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    4,
    "/api/sessions/terminal%2Fone/workspace/file?path=docs%2FUser+Guide.md",
    expect.anything(),
  );
});
