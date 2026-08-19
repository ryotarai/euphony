export type SessionState = "starting" | "running" | "exited" | "failed";

export interface Project {
  id: string;
  path: string;
  createdAt: string;
}

export interface Session {
  id: string;
  name: string;
  state: SessionState;
  cwd: string;
  projectId?: string;
  repoRoot?: string;
  agent?: string;
  agentStatus?: string;
  needsAttention?: boolean;
  agentTitle?: string;
  processName?: string;
  customName?: boolean;
  createdAt: string;
  updatedAt?: string;
  exitedAt?: string;
  exitCode?: number;
  message?: string;
}

export interface AllSession {
  id: string;
  terminalId?: string;
  agent?: "codex" | "claude";
  sessionId?: string;
  title: string;
  purpose?: string;
  summary?: string;
  cwd: string;
  project?: string;
  updatedAt: string;
  state: "open" | "resume";
}

export interface AllSessionResumeResult {
  terminal: Session;
  selection: SelectionSnapshot;
}

export type KanbanStatus = "running" | "waiting" | "blocked" | "archived";
export type KanbanSessionStatus = KanbanStatus;

export interface KanbanSession extends AllSession {
  agent: "codex" | "claude";
  status: KanbanStatus;
  archived: boolean;
}

export type AgentSummaryProvider = "openai" | "codex" | "claude";
export type CodingAgent = "codex" | "claude";
export type AgentSummaryOpenAIEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type AgentSummaryPriority = "high" | "medium" | "low";

export interface AgentSummaryOption {
  id?: string;
  label: string;
  input?: string;
}

export interface AgentSummary {
  terminalId: string;
  provider: AgentSummaryProvider;
  status: "running" | "waiting" | "blocked";
  purpose?: string;
  summary: string;
  action?: string;
  priority?: AgentSummaryPriority;
  options?: AgentSummaryOption[];
  generatedAt: string;
  unread: boolean;
  done?: boolean;
  error?: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export type TerminalCursorStyle = "bar" | "block" | "underline";

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
  terminalLineHeight: number;
  terminalCursorStyle: TerminalCursorStyle;
  terminalCursorBlink: boolean;
  terminalScrollSensitivity: number;
  terminalOptionAsAlt: boolean;
  codingAgent: CodingAgent;
  agentSummaryProvider: AgentSummaryProvider;
  agentSummaryOpenAIEffort?: AgentSummaryOpenAIEffort;
  agentSummaryPrompt: string;
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
  | "tool_group"
  | "image"
  | "video";

export interface AgentLogEntry {
  id: string;
  kind: AgentLogEntryKind;
  role?: "user" | "assistant";
  title?: string;
  content?: string;
  url?: string;
  mimeType?: string;
  alt?: string;
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
