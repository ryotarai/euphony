import type {
  AgentLogResult,
  AgentTranscript,
  ApiErrorBody,
  ReplaceSelectionRequest,
  SelectionSnapshot,
  Session,
  Settings,
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

  getSelection(): Promise<SelectionSnapshot> {
    return this.v1Request("/api/v1/selection");
  }

  replaceSelection(request: ReplaceSelectionRequest): Promise<SelectionSnapshot> {
    return this.v1Request("/api/v1/selection", {
      method: "PUT",
      body: JSON.stringify(request),
    });
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

  async getAgentLog(id: string, etag?: string): Promise<AgentLogResult> {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(id)}/agent-log`,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(etag ? { "If-None-Match": etag } : {}),
        },
      },
    );
    if (response.status === 304) {
      return { log: null, etag: response.headers.get("ETag") ?? etag ?? "" };
    }
    if (!response.ok) {
      throw await this.apiError(response);
    }
    return {
      log: (await response.json()) as AgentTranscript,
      etag: response.headers.get("ETag") ?? "",
    };
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
