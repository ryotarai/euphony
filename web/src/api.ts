import type { ApiErrorBody, Session } from "./types";

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

  createSession(name: string): Promise<Session> {
    return this.request("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  async deleteSession(id: string): Promise<void> {
    await this.request(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  createTicket(id: string): Promise<{ ticket: string }> {
    return this.request(`/api/sessions/${encodeURIComponent(id)}/tickets`, { method: "POST" });
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
      let body: ApiErrorBody = { code: "request_failed", message: "The request failed." };
      try {
        body = (await response.json()) as ApiErrorBody;
      } catch {
        // Keep the stable fallback for non-JSON proxy and network responses.
      }
      throw new ApiError(response.status, body.code, body.message);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }
}

