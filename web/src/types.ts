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
  terminalFontFamily: string;
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

export type AnnotationFormat = "markdown" | "html";
export type AnnotationCommentKind = "selection" | "global";

export interface AnnotationSession {
  id: string;
  terminalId: string;
  filename: string;
  format: AnnotationFormat;
  content: string;
  createdAt: string;
}

export interface AnnotationComment {
  kind: AnnotationCommentKind;
  body: string;
  quote?: string;
  startOffset?: number;
  endOffset?: number;
}

export interface AnnotationResult {
  annotationId: string;
  comments: AnnotationComment[];
}

export type AgentLogEntryKind =
  | "message"
  | "thinking"
  | "tool"
  | "tool_result"
  | "tool_group";

export interface AgentLogEntry {
  id: string;
  kind: AgentLogEntryKind;
  role?: "user" | "assistant";
  title?: string;
  content?: string;
  callId?: string;
  toolCalls?: number;
  entries?: AgentLogEntry[];
  timestamp?: string;
}

export interface AgentTranscript {
  agent: "claude" | "codex";
  sessionId: string;
  entries: AgentLogEntry[];
  startCursor?: string;
  endCursor?: string;
  nextCursor?: string;
}

export interface AgentLogRequest {
  etag?: string;
  before?: string;
  after?: string;
}

export interface AgentLogResult {
  log: AgentTranscript | null;
  etag: string;
}

export type GitChangeStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked";

export interface GitDiffLine {
  kind: "context" | "addition" | "deletion" | "meta";
  oldLine?: number;
  newLine?: number;
  content: string;
}

export interface GitDiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: GitDiffLine[];
}

export interface GitChangedFile {
  path: string;
  previousPath?: string;
  status: GitChangeStatus;
  additions: number;
  deletions: number;
  binary?: boolean;
  truncated?: boolean;
  statsTruncated?: boolean;
  patchLoaded?: boolean;
  hunks: GitDiffHunk[];
}

export interface GitChangesSnapshot {
  repoRoot: string;
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  additions: number;
  deletions: number;
  truncated?: boolean;
  statsTruncated?: boolean;
  files: GitChangedFile[];
}

export type WorkspaceEntryKind = "directory" | "file" | "symlink" | "other";

export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: WorkspaceEntryKind;
  size?: number;
}

export interface WorkspaceDirectory {
  root: string;
  path: string;
  entries: WorkspaceEntry[];
  truncated?: boolean;
}

export interface WorkspaceSearchResult {
  root: string;
  query: string;
  matches: WorkspaceEntry[];
  truncated?: boolean;
}

export interface WorkspaceFile {
  root: string;
  name: string;
  path: string;
  size: number;
  content?: string;
  binary?: boolean;
  truncated?: boolean;
}
