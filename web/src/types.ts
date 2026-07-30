export type SessionState = "starting" | "running" | "exited" | "failed";

export interface Session {
  id: string;
  name: string;
  state: SessionState;
  cwd: string;
  repoRoot?: string;
  agent?: string;
  agentStatus?: string;
  needsAttention?: boolean;
  agentTitle?: string;
  createdAt: string;
  exitedAt?: string;
  exitCode?: number;
  message?: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
}

export interface Settings {
  prefix: string;
  paneTabShortcut: string;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  interfaceFontSize: number;
  terminalFontSize: number;
  agentLogFontSize: number;
  terminalHistoryLimit: number;
  autoSelectAttention: boolean;
}

export interface CwdSelectionFilter {
  status: string;
  cwd: string;
}

export interface SelectionFilters {
  statuses: string[];
  cwds: CwdSelectionFilter[];
}

export interface SelectionSnapshot {
  terminalIds: string[];
  manualTerminalIds: string[];
  pinnedTerminalIds: string[];
  focusedTerminalId?: string;
  filters: SelectionFilters;
  pinnedFilters?: SelectionFilters;
  revision: number;
}

export interface ReplaceSelectionRequest {
  manualTerminalIds: string[];
  pinnedTerminalIds: string[];
  focusedTerminalId?: string;
  filters: SelectionFilters;
  pinnedFilters?: SelectionFilters;
  expectedRevision?: number;
}

export interface APIEvent<T = unknown> {
  sequence: number;
  occurredAt: string;
  type: string;
  data: T;
}

export type AgentLogEntryKind = "message" | "thinking" | "tool" | "tool_result";

export interface AgentLogEntry {
  id: string;
  kind: AgentLogEntryKind;
  role?: "user" | "assistant";
  title?: string;
  content?: string;
  timestamp?: string;
}

export interface AgentTranscript {
  agent: "claude" | "codex";
  sessionId: string;
  entries: AgentLogEntry[];
}

export interface AgentLogResult {
  log: AgentTranscript | null;
  etag: string;
}
