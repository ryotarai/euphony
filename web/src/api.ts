import type {
  AgentLogResult,
  AgentLogRequest,
  AgentTranscript,
  AnnotationComment,
  AnnotationResult,
  AnnotationSession,
  APIEvent,
  ApiErrorBody,
  ReplaceSelectionRequest,
  SelectionSnapshot,
  Session,
  Settings,
  GitChangesSnapshot,
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
  ): Promise<{ terminal: Session; selection: SelectionSnapshot }> {
    return this.v1Request("/api/v1/terminals", {
      method: "POST",
      body: JSON.stringify({
        name,
        ...(cwd ? { cwd } : {}),
        selectionMode,
      }),
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
