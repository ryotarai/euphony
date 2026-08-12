import type {
  AgentLogResult,
  AgentLogRequest,
  AgentTranscript,
  AgentSummary,
  AnnotationComment,
  AnnotationResult,
  AnnotationSession,
  CodingAgent,
  APIEvent,
  ApiErrorBody,
  Project,
  ReplaceSelectionRequest,
  SelectionSnapshot,
  Session,
  Settings,
  Task,
  TaskCreateInput,
  TaskRefinement,
  TaskStartInput,
  TaskUpdateInput,
  GitChangesSnapshot,
  WorkspaceDirectory,
  WorkspaceFile,
  WorkspaceSearchResult,
} from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class ApiClient {
  constructor(private readonly token: string) {}

  listSessions(): Promise<Session[]> {
    return this.request("/api/sessions");
  }

  listProjects(): Promise<Project[]> {
    return this.request("/api/projects");
  }

  createProject(path: string): Promise<Project> {
    return this.request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
  }

  async pickProjectDirectory(): Promise<string | null> {
    const result = await this.request<{ path: string } | undefined>(
      "/api/projects/pick-directory",
      { method: "POST", body: JSON.stringify({}) },
    );
    return result?.path ?? null;
  }

  listAgentSummaries(): Promise<AgentSummary[]> {
    return this.request("/api/agent-summaries");
  }

  refreshAgentSummaries(): Promise<{ queued: number }> {
    return this.request("/api/agent-summaries/refresh", {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  markAgentSummaryRead(id: string): Promise<AgentSummary> {
    return this.request(`/api/agent-summaries/${encodeURIComponent(id)}/read`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  markAgentSummaryDone(id: string): Promise<AgentSummary> {
    return this.request(`/api/agent-summaries/${encodeURIComponent(id)}/done`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  executeAgentSummaryOption(
    id: string,
    optionID: string,
    screenText = "",
  ): Promise<AgentSummary> {
    return this.request(
      `/api/agent-summaries/${encodeURIComponent(id)}/options/${encodeURIComponent(optionID)}/execute`,
      {
        method: "POST",
        body: JSON.stringify(screenText === "" ? {} : { screenText }),
      },
    );
  }

  listTasks(): Promise<Task[]> {
    return this.request("/api/tasks");
  }

  createTask(input: TaskCreateInput): Promise<Task> {
    return this.request("/api/tasks", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  updateTask(id: string, input: TaskUpdateInput): Promise<Task> {
    return this.request(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  deleteTask(id: string): Promise<void> {
    return this.request(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  startTaskAgent(id: string, input: TaskStartInput): Promise<Task> {
    return this.request(`/api/tasks/${encodeURIComponent(id)}/start`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  promptTaskAgent(id: string, prompt: string): Promise<Task> {
    return this.request(`/api/tasks/${encodeURIComponent(id)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt }),
    });
  }

  refineTask(id: string): Promise<TaskRefinement> {
    return this.request(`/api/tasks/${encodeURIComponent(id)}/refine`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  createSession(name: string, cwd?: string): Promise<Session> {
    return this.request("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ name, ...(cwd ? { cwd } : {}) }),
    });
  }

  createTerminal(
    name: string,
    cwd: string | undefined,
    selectionMode: "none" | "add" | "replace",
    projectId?: string,
    command?: CodingAgent,
  ): Promise<{ terminal: Session; selection: SelectionSnapshot }> {
    return this.v1Request("/api/v1/terminals", {
      method: "POST",
      body: JSON.stringify({
        name,
        ...(cwd ? { cwd } : {}),
        selectionMode,
        ...(projectId ? { projectId } : {}),
        ...(command ? { command } : {}),
      }),
    });
  }

  startAgent(
    terminalID: string,
    kind: "codex" | "claude",
    args: string[] = [],
    timeoutMs = 30_000,
  ): Promise<unknown> {
    return this.v1Request(`/api/v1/agents/${encodeURIComponent(terminalID)}/start`, {
      method: "POST",
      body: JSON.stringify({ kind, args, timeoutMs }),
    });
  }

  async deleteSession(id: string): Promise<void> {
    await this.request(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  deleteTerminal(id: string): Promise<{ id: string; selection: SelectionSnapshot }> {
    return this.v1Request(`/api/v1/terminals/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  renameTerminal(id: string, name: string): Promise<Session> {
    return this.v1Request<{ terminal: Session }>(
      `/api/v1/terminals/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ name }),
      },
    ).then((result) => result.terminal);
  }

  getCurrentAnnotation(terminalID: string): Promise<AnnotationSession | null> {
    return this.v1Request<{ annotation: AnnotationSession | null }>(
      `/api/v1/terminals/${encodeURIComponent(terminalID)}/annotation`,
    ).then((result) => result.annotation);
  }

  completeAnnotation(
    annotationID: string,
    comments: AnnotationComment[],
  ): Promise<AnnotationResult> {
    return this.v1Request(
      `/api/v1/annotations/${encodeURIComponent(annotationID)}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ comments }),
      },
    );
  }

  getSelection(): Promise<SelectionSnapshot> {
    return this.v1Request("/api/v1/selection");
  }

  replaceSelection(request: ReplaceSelectionRequest): Promise<SelectionSnapshot> {
    return this.v1Request("/api/v1/selection", {
      method: "PUT",
      body: JSON.stringify(request),
    });
  }

  async subscribeEvents(
    signal: AbortSignal,
    onEvent: (event: APIEvent) => void,
  ): Promise<void> {
    const response = await fetch("/api/v1/events", {
      signal,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/x-ndjson",
      },
    });
    if (!response.ok) {
      throw await this.v1ApiError(response);
    }
    if (!response.body) {
      throw new ApiError(
        response.status,
        "streaming_unsupported",
        "The event response has no readable stream.",
      );
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        onEvent(JSON.parse(line) as APIEvent);
      }
      if (done) {
        if (pending.trim()) {
          onEvent(JSON.parse(pending) as APIEvent);
        }
        return;
      }
    }
  }

  acknowledgeAttention(id: string): Promise<Session> {
    return this.request(
      `/api/sessions/${encodeURIComponent(id)}/acknowledge-attention`,
      { method: "POST" },
    );
  }

  createTicket(id: string): Promise<{ ticket: string }> {
    return this.request(`/api/sessions/${encodeURIComponent(id)}/tickets`, { method: "POST" });
  }

  async getAgentLog(
    id: string,
    request: AgentLogRequest = {},
  ): Promise<AgentLogResult> {
    const query = new URLSearchParams();
    if (request.before) query.set("before", request.before);
    if (request.after) query.set("after", request.after);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(id)}/agent-log${suffix}`,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(request.etag ? { "If-None-Match": request.etag } : {}),
        },
      },
    );
    if (response.status === 304) {
      return {
        log: null,
        etag: response.headers.get("ETag") ?? request.etag ?? "",
      };
    }
    if (!response.ok) {
      throw await this.apiError(response);
    }
    return {
      log: (await response.json()) as AgentTranscript,
      etag: response.headers.get("ETag") ?? "",
    };
  }

  getGitChanges(id: string, path?: string): Promise<GitChangesSnapshot> {
    const query = new URLSearchParams();
    if (path) query.set("path", path);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request(
      `/api/sessions/${encodeURIComponent(id)}/git-changes${suffix}`,
    );
  }

  getWorkspaceDirectory(id: string, path?: string): Promise<WorkspaceDirectory> {
    const query = new URLSearchParams();
    if (path) query.set("path", path);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request(
      `/api/sessions/${encodeURIComponent(id)}/workspace${suffix}`,
    );
  }

  searchWorkspace(id: string, query: string): Promise<WorkspaceSearchResult> {
    const search = new URLSearchParams({ query });
    return this.request(
      `/api/sessions/${encodeURIComponent(id)}/workspace/search?${search.toString()}`,
    );
  }

  getWorkspaceFile(id: string, path: string): Promise<WorkspaceFile> {
    const query = new URLSearchParams({ path });
    return this.request(
      `/api/sessions/${encodeURIComponent(id)}/workspace/file?${query.toString()}`,
    );
  }

  getSettings(): Promise<Settings> {
    return this.request("/api/settings");
  }

  updateSettings(settings: Settings): Promise<Settings> {
    return this.request("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(settings),
    });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw await this.apiError(response);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  private async v1Request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw await this.v1ApiError(response);
    }
    const envelope = await response.json() as {
      ok: boolean;
      result?: T;
      error?: ApiErrorBody;
    };
    if (!response.ok || !envelope.ok || envelope.result === undefined) {
      const error = envelope.error ?? {
        code: "request_failed",
        message: "The request failed.",
      };
      throw new ApiError(response.status, error.code, error.message);
    }
    return envelope.result;
  }

  private async v1ApiError(response: Response): Promise<ApiError> {
    try {
      const envelope = await response.json() as {
        error?: ApiErrorBody;
      };
      if (envelope.error) {
        return new ApiError(
          response.status,
          envelope.error.code,
          envelope.error.message,
        );
      }
    } catch {
      // Use the stable fallback for non-JSON proxies.
    }
    return new ApiError(
      response.status,
      "request_failed",
      "The request failed.",
    );
  }

  private async apiError(response: Response): Promise<ApiError> {
    let body: ApiErrorBody = { code: "request_failed", message: "The request failed." };
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      // Keep the stable fallback for non-JSON proxy and network responses.
    }
    return new ApiError(response.status, body.code, body.message);
  }
}
