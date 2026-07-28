export type SessionState = "starting" | "running" | "exited" | "failed";

export interface Session {
  id: string;
  name: string;
  state: SessionState;
  createdAt: string;
  exitedAt?: string;
  exitCode?: number;
  message?: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
}

