import {
  ArchiveIcon,
  BotIcon,
  Clock3Icon,
  FolderIcon,
  GripVerticalIcon,
  OctagonAlertIcon,
  PauseCircleIcon,
  Undo2Icon,
} from "lucide-react";
import {
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { defaultKanbanShortcut } from "../settings";
import { formatShortcut } from "../keybindings";
import { SessionInfoCard } from "./SessionInfoPane";
import type {
  AgentSummary,
  KanbanSession,
  KanbanStatus,
  Project,
  Session,
} from "../types";

const sessionInfoHoverDelayMs = 500;
const sessionInfoCardGap = 12;
const sessionInfoViewportPadding = 12;
export const kanbanAllProjectsFilter = "__all__";
const unassignedProjectFilter = "__unassigned__";

const kanbanColumns = [
  {
    status: "running",
    label: "Running",
    description: "Agents making progress now",
  },
  {
    status: "waiting",
    label: "Waiting",
    description: "Agents waiting for input",
  },
  {
    status: "blocked",
    label: "Blocked",
    description: "Agents that need attention",
  },
  {
    status: "archived",
    label: "Archived",
    description: "Sessions you set aside",
  },
] as const satisfies ReadonlyArray<{
  status: KanbanStatus;
  label: string;
  description: string;
}>;

export interface KanbanDialogProps {
  open: boolean;
  sessions: KanbanSession[];
  projects?: Project[];
  projectFilter?: string;
  shortcut?: string;
  loading?: boolean;
  error?: string;
  onOpenChange(open: boolean): void;
  onProjectFilterChange?(projectFilter: string): void;
  onOpenSession?(session: KanbanSession): void | Promise<void>;
  onArchiveSession(session: KanbanSession): void | Promise<void>;
  onRestoreSession?(session: KanbanSession): void | Promise<void>;
}

function displayAgent(agent: KanbanSession["agent"]): string {
  return agent[0].toUpperCase() + agent.slice(1);
}

function displayPath(path: string): string {
  return path
    .replace(/^\/Users\/[^/]+(?=\/|$)/, "~")
    .replace(/^\/home\/[^/]+(?=\/|$)/, "~");
}

function formatUpdatedAt(updatedAt: string): string {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return "Unknown update";
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 60) return "Just now";
  const elapsedMinutes = Math.round(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;
  return `${Math.round(elapsedHours / 24)}d ago`;
}

function infoSessionForKanban(session: KanbanSession, status: KanbanStatus): Session {
  const archived = status === "archived";
  return {
    id: session.id,
    name: session.title,
    state: archived ? "exited" : "running",
    cwd: session.cwd,
    archived,
    agent: session.agent,
    agentStatus: archived ? "exited" : status,
    agentTitle: session.title,
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
  };
}

function infoSummaryForKanban(
  session: KanbanSession,
  status: KanbanStatus,
): AgentSummary {
  const summaryStatus = status === "archived" ? "waiting" : status;
  const action = status === "running"
    ? "In progress."
    : status === "waiting"
      ? "Waiting for input."
      : status === "blocked"
        ? "Needs attention."
        : "Archived.";
  return {
    terminalId: session.id,
    provider: session.agent,
    status: summaryStatus,
    purpose: session.purpose,
    summary: session.summary ?? "",
    action,
    generatedAt: session.updatedAt,
    unread: false,
  };
}

function StatusIcon({ status }: { status: KanbanStatus }) {
  if (status === "running") return <Clock3Icon aria-hidden="true" />;
  if (status === "waiting") return <PauseCircleIcon aria-hidden="true" />;
  if (status === "blocked") return <OctagonAlertIcon aria-hidden="true" />;
  return <ArchiveIcon aria-hidden="true" />;
}

function sessionStatus(
  session: KanbanSession,
  archivedIDs: ReadonlySet<string>,
  restoredIDs: ReadonlySet<string>,
): KanbanStatus {
  if (archivedIDs.has(session.id)) return "archived";
  if (session.archived) {
    return restoredIDs.has(session.id)
      ? session.status === "archived" ? "running" : session.status
      : "archived";
  }
  if (session.status === "archived") return restoredIDs.has(session.id) ? "running" : "archived";
  return session.status;
}

function sessionIdentitySets(sessions: KanbanSession[]) {
  const sessionIDs = new Set<string>();
  const archivedIDs = new Set<string>();
  for (const session of sessions) {
    sessionIDs.add(session.id);
    if (session.archived || session.status === "archived") archivedIDs.add(session.id);
  }
  return { sessionIDs, archivedIDs };
}

interface KanbanSessionInfoAnchor {
  x: number;
  y: number;
  modalWidth: number;
  modalHeight: number;
}

function useKanbanSessionInfo({
  open,
  sessionsByID,
  archivedIDs,
  restoredIDs,
}: {
  open: boolean;
  sessionsByID: ReadonlyMap<string, KanbanSession>;
  archivedIDs: ReadonlySet<string>;
  restoredIDs: ReadonlySet<string>;
}) {
  const [sessionInfoHover, setSessionInfoHover] = useState<{
    sessionID: string;
    x: number;
    y: number;
    modalWidth: number;
    modalHeight: number;
  } | null>(null);
  const [sessionInfoCardPosition, setSessionInfoCardPosition] = useState({
    left: sessionInfoViewportPadding,
    top: sessionInfoViewportPadding,
  });
  const sessionInfoTimerRef = useRef<number | null>(null);
  const sessionInfoPendingIDRef = useRef<string | null>(null);
  const sessionInfoCardRef = useRef<HTMLElement | null>(null);

  const clearSessionInfoTimer = useCallback(() => {
    if (sessionInfoTimerRef.current === null) return;
    window.clearTimeout(sessionInfoTimerRef.current);
    sessionInfoTimerRef.current = null;
  }, []);

  const cancelSessionInfo = useCallback(() => {
    clearSessionInfoTimer();
    sessionInfoPendingIDRef.current = null;
    setSessionInfoHover(null);
  }, [clearSessionInfoTimer]);

  const scheduleSessionInfo = useCallback((
    session: KanbanSession,
    anchor: KanbanSessionInfoAnchor,
  ) => {
    clearSessionInfoTimer();
    sessionInfoPendingIDRef.current = session.id;
    setSessionInfoHover(null);
    sessionInfoTimerRef.current = window.setTimeout(() => {
      sessionInfoTimerRef.current = null;
      if (sessionInfoPendingIDRef.current !== session.id) return;
      if (!sessionsByID.has(session.id)) {
        sessionInfoPendingIDRef.current = null;
        return;
      }
      setSessionInfoHover({ sessionID: session.id, ...anchor });
    }, sessionInfoHoverDelayMs);
  }, [clearSessionInfoTimer, sessionsByID]);

  const onCardPointerEnter = useCallback((
    session: KanbanSession,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    const modal = event.currentTarget.closest<HTMLElement>(".kanban-modal");
    const rect = modal?.getBoundingClientRect();
    scheduleSessionInfo(session, {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
      modalWidth: rect?.width ?? window.innerWidth,
      modalHeight: rect?.height ?? window.innerHeight,
    });
  }, [scheduleSessionInfo]);

  const onCardFocus = useCallback((
    session: KanbanSession,
    event: ReactFocusEvent<HTMLElement>,
  ) => {
    const modal = event.currentTarget.closest<HTMLElement>(".kanban-modal");
    const modalRect = modal?.getBoundingClientRect();
    const rect = event.currentTarget.getBoundingClientRect();
    scheduleSessionInfo(session, {
      x: rect.right - (modalRect?.left ?? 0),
      y: rect.top - (modalRect?.top ?? 0),
      modalWidth: modalRect?.width ?? window.innerWidth,
      modalHeight: modalRect?.height ?? window.innerHeight,
    });
  }, [scheduleSessionInfo]);

  const onCardBlur = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    cancelSessionInfo();
  }, [cancelSessionInfo]);

  useLayoutEffect(() => {
    if (!sessionInfoHover || !sessionsByID.has(sessionInfoHover.sessionID)) return;
    const rect = sessionInfoCardRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 0;
    const height = rect?.height ?? 0;
    const maxLeft = Math.max(
      sessionInfoViewportPadding,
      sessionInfoHover.modalWidth - width - sessionInfoViewportPadding,
    );
    const maxTop = Math.max(
      sessionInfoViewportPadding,
      sessionInfoHover.modalHeight - height - sessionInfoViewportPadding,
    );
    const left = Math.min(
      maxLeft,
      Math.max(sessionInfoViewportPadding, sessionInfoHover.x + sessionInfoCardGap),
    );
    const top = Math.min(
      maxTop,
      Math.max(sessionInfoViewportPadding, sessionInfoHover.y + sessionInfoCardGap),
    );
    setSessionInfoCardPosition((current) =>
      current.left === left && current.top === top ? current : { left, top },
    );
  }, [sessionInfoHover, sessionsByID]);

  useEffect(() => {
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelSessionInfo();
    };
    window.addEventListener("keydown", cancelOnEscape, true);
    return () => window.removeEventListener("keydown", cancelOnEscape, true);
  }, [cancelSessionInfo]);

  useEffect(() => {
    if (!open) cancelSessionInfo();
    return cancelSessionInfo;
  }, [cancelSessionInfo, open]);

  const hoveredSession = sessionInfoHover
    ? sessionsByID.get(sessionInfoHover.sessionID)
    : undefined;
  const hoveredStatus = hoveredSession
    ? sessionStatus(hoveredSession, archivedIDs, restoredIDs)
    : undefined;

  return {
    sessionInfoCardRef,
    sessionInfoCardPosition,
    hoveredSession,
    hoveredStatus,
    onCardPointerEnter,
    onCardPointerLeave: cancelSessionInfo,
    onCardFocus,
    onCardBlur,
  };
}

interface KanbanCardProps {
  session: KanbanSession;
  status: KanbanStatus;
  isArchiving: boolean;
  onOpenSession?(session: KanbanSession): void | Promise<void>;
  onArchiveSession(session: KanbanSession): void | Promise<void>;
  onRestoreSession(session: KanbanSession): void | Promise<void>;
  onCardPointerEnter(
    session: KanbanSession,
    event: ReactPointerEvent<HTMLElement>,
  ): void;
  onCardPointerLeave(): void;
  onCardFocus(session: KanbanSession, event: ReactFocusEvent<HTMLElement>): void;
  onCardBlur(event: ReactFocusEvent<HTMLElement>): void;
  onDragStart(session: KanbanSession, event: React.DragEvent<HTMLElement>): void;
  onDragEnd(): void;
}

function KanbanCard({
  session,
  status,
  isArchiving,
  onOpenSession,
  onArchiveSession,
  onRestoreSession,
  onCardPointerEnter,
  onCardPointerLeave,
  onCardFocus,
  onCardBlur,
  onDragStart,
  onDragEnd,
}: KanbanCardProps) {
  const canArchive = status !== "archived";

  return (
    <article
      className="kanban-card"
      data-testid={`kanban-card-${session.id}`}
      data-status={status}
      role={onOpenSession ? "button" : undefined}
      tabIndex={onOpenSession ? 0 : undefined}
      draggable={canArchive && !isArchiving}
      aria-label={`${session.title}, ${displayAgent(session.agent)} session`}
      onClick={onOpenSession ? () => void onOpenSession(session) : undefined}
      onKeyDown={onOpenSession ? (event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        void onOpenSession(session);
      } : undefined}
      onPointerEnter={(event) => onCardPointerEnter(session, event)}
      onPointerLeave={onCardPointerLeave}
      onFocus={(event) => onCardFocus(session, event)}
      onBlur={onCardBlur}
      onDragStart={canArchive && !isArchiving ? (event) => onDragStart(session, event) : undefined}
      onDragEnd={canArchive && !isArchiving ? onDragEnd : undefined}
    >
      <div className="kanban-card-topline">
        <span className="kanban-card-agent">
          {session.agent === "codex" ? (
            <BotIcon aria-hidden="true" />
          ) : (
            <FolderIcon aria-hidden="true" />
          )}
          {displayAgent(session.agent)}
        </span>
        <div className="kanban-card-controls">
          {canArchive && <GripVerticalIcon aria-hidden="true" className="kanban-card-grip" />}
          {canArchive ? (
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className="kanban-card-action"
              aria-label={`Archive ${session.title}`}
              title={`Archive ${session.title}`}
              onClick={(event) => {
                event.stopPropagation();
                void onArchiveSession(session);
              }}
              disabled={isArchiving}
            >
              <ArchiveIcon aria-hidden="true" />
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className="kanban-card-action"
              aria-label={`Restore ${session.title}`}
              title={`Restore ${session.title}`}
              onClick={(event) => {
                event.stopPropagation();
                void onRestoreSession(session);
              }}
              disabled={isArchiving}
            >
              <Undo2Icon aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
      <h3>{session.title}</h3>
      {session.purpose && <p className="kanban-card-purpose">{session.purpose}</p>}
      {session.summary && <p className="kanban-card-summary">{session.summary}</p>}
      <div className="kanban-card-metadata">
        <span title={session.cwd}>{displayPath(session.cwd)}</span>
        <span>
          <Clock3Icon aria-hidden="true" />
          <time dateTime={session.updatedAt}>{formatUpdatedAt(session.updatedAt)}</time>
        </span>
      </div>
    </article>
  );
}

interface KanbanColumnProps {
  column: (typeof kanbanColumns)[number];
  sessions: KanbanSession[];
  dropActive: boolean;
  draggedSessionID: string | null;
  archivingIDs: ReadonlySet<string>;
  onArchivedDragOver(event: React.DragEvent<HTMLElement>): void;
  onArchivedDragLeave(event: React.DragEvent<HTMLElement>): void;
  onArchivedDrop(event: React.DragEvent<HTMLElement>): void;
  onDragStart(session: KanbanSession, event: React.DragEvent<HTMLElement>): void;
  onDragEnd(): void;
  onOpenSession?(session: KanbanSession): void | Promise<void>;
  onArchiveSession(session: KanbanSession): void | Promise<void>;
  onRestoreSession(session: KanbanSession): void | Promise<void>;
  onCardPointerEnter(
    session: KanbanSession,
    event: ReactPointerEvent<HTMLElement>,
  ): void;
  onCardPointerLeave(): void;
  onCardFocus(session: KanbanSession, event: ReactFocusEvent<HTMLElement>): void;
  onCardBlur(event: ReactFocusEvent<HTMLElement>): void;
}

function KanbanColumn({
  column,
  sessions,
  dropActive,
  draggedSessionID,
  archivingIDs,
  onArchivedDragOver,
  onArchivedDragLeave,
  onArchivedDrop,
  onDragStart,
  onDragEnd,
  onOpenSession,
  onArchiveSession,
  onRestoreSession,
  onCardPointerEnter,
  onCardPointerLeave,
  onCardFocus,
  onCardBlur,
}: KanbanColumnProps) {
  const isArchived = column.status === "archived";

  return (
    <section
      className="kanban-column"
      data-status={column.status}
      data-drop-active={isArchived && dropActive ? "true" : undefined}
      aria-labelledby={`kanban-column-${column.status}`}
      onDragOver={isArchived ? onArchivedDragOver : undefined}
      onDragLeave={isArchived ? onArchivedDragLeave : undefined}
      onDrop={isArchived ? onArchivedDrop : undefined}
    >
      <header className="kanban-column-header">
        <div>
          <h2 id={`kanban-column-${column.status}`}>
            <StatusIcon status={column.status} />
            {column.label}
          </h2>
          <p>{column.description}</p>
        </div>
        <span className="kanban-column-count" aria-label={`${sessions.length} sessions`}>
          {sessions.length}
        </span>
      </header>
      <ul className="kanban-card-list" aria-label={`${column.label} sessions`}>
        {sessions.map((session) => (
          <li key={session.id}>
            <KanbanCard
              session={session}
              status={column.status}
              isArchiving={archivingIDs.has(session.id)}
              onOpenSession={onOpenSession}
              onArchiveSession={onArchiveSession}
              onRestoreSession={onRestoreSession}
              onCardPointerEnter={onCardPointerEnter}
              onCardPointerLeave={onCardPointerLeave}
              onCardFocus={onCardFocus}
              onCardBlur={onCardBlur}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            />
          </li>
        ))}
      </ul>
      {sessions.length === 0 && (
        <p className="kanban-column-empty">
          {isArchived ? "Drop a card here to archive it." : "Nothing here yet."}
        </p>
      )}
      {isArchived && draggedSessionID && (
        <p className="kanban-drop-hint" aria-live="polite">
          Release to archive
        </p>
      )}
    </section>
  );
}

export function KanbanDialog({
  open,
  sessions,
  projects,
  projectFilter,
  shortcut = defaultKanbanShortcut,
  loading = false,
  error = "",
  onOpenChange,
  onProjectFilterChange,
  onOpenSession,
  onArchiveSession,
  onRestoreSession,
}: KanbanDialogProps) {
  const [localArchivedIDs, setLocalArchivedIDs] = useState<Set<string>>(
    () => new Set(),
  );
  const [restoredIDs, setRestoredIDs] = useState<Set<string>>(() => new Set());
  const [archivingIDs, setArchivingIDs] = useState<Set<string>>(() => new Set());
  const [draggedSessionID, setDraggedSessionID] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const [localProjectFilter, setLocalProjectFilter] = useState(kanbanAllProjectsFilter);
  const activeProjectFilter = projectFilter ?? localProjectFilter;

  const persistedSessionIDs = useMemo(() => sessionIdentitySets(sessions), [sessions]);
  const archivedIDs = useMemo(() => {
    const next = new Set<string>();
    for (const sessionID of localArchivedIDs) {
      if (persistedSessionIDs.sessionIDs.has(sessionID)) next.add(sessionID);
    }
    for (const sessionID of persistedSessionIDs.archivedIDs) {
      if (!restoredIDs.has(sessionID)) next.add(sessionID);
    }
    return next;
  }, [localArchivedIDs, persistedSessionIDs, restoredIDs]);

  const sessionsByID = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const {
    sessionInfoCardRef,
    sessionInfoCardPosition,
    hoveredSession,
    hoveredStatus,
    onCardPointerEnter,
    onCardPointerLeave,
    onCardFocus,
    onCardBlur,
  } = useKanbanSessionInfo({ open, sessionsByID, archivedIDs, restoredIDs });

  const projectOptions = useMemo(() => {
    const options = (projects ?? []).map((project) => ({
      value: project.path,
      label: project.path,
    }));
    if (sessions.some((session) => !session.project)) {
      options.push({ value: unassignedProjectFilter, label: "Unassigned" });
    }
    return options;
  }, [projects, sessions]);

  const visibleSessions = useMemo(() => {
    if (activeProjectFilter === kanbanAllProjectsFilter) return sessions;
    if (activeProjectFilter === unassignedProjectFilter) {
      return sessions.filter((session) => !session.project);
    }
    return sessions.filter((session) => session.project === activeProjectFilter);
  }, [activeProjectFilter, sessions]);

  const archiveSession = useCallback(async (session: KanbanSession) => {
    if (archivedIDs.has(session.id)) return;
    if (archivingIDs.has(session.id)) return;
    setArchiveError("");
    setArchivingIDs((current) => new Set(current).add(session.id));
    try {
      await onArchiveSession(session);
      setLocalArchivedIDs((current) => new Set(current).add(session.id));
      setRestoredIDs((current) => {
        const next = new Set(current);
        next.delete(session.id);
        return next;
      });
    } catch (error) {
      setArchiveError(
        error instanceof Error ? error.message : "The session could not be archived.",
      );
    } finally {
      setArchivingIDs((current) => {
        const next = new Set(current);
        next.delete(session.id);
        return next;
      });
    }
  }, [archivedIDs, archivingIDs, onArchiveSession]);

  const restoreSession = useCallback(async (session: KanbanSession) => {
    if (!archivedIDs.has(session.id) && !session.archived && session.status !== "archived") return;
    if (!onRestoreSession) return;
    if (archivingIDs.has(session.id)) return;
    setArchiveError("");
    setArchivingIDs((current) => new Set(current).add(session.id));
    try {
      await onRestoreSession?.(session);
      setLocalArchivedIDs((current) => {
        const next = new Set(current);
        next.delete(session.id);
        return next;
      });
      setRestoredIDs((current) => new Set(current).add(session.id));
    } catch (error) {
      setArchiveError(
        error instanceof Error ? error.message : "The session could not be restored.",
      );
    } finally {
      setArchivingIDs((current) => {
        const next = new Set(current);
        next.delete(session.id);
        return next;
      });
    }
  }, [archivingIDs, archivedIDs, onRestoreSession]);

  const archiveByID = useCallback((sessionID: string | null) => {
    if (!sessionID) return;
    const session = sessionsByID.get(sessionID);
    if (session) void archiveSession(session);
  }, [archiveSession, sessionsByID]);

  const handleDragStart = useCallback((
    session: KanbanSession,
    event: React.DragEvent<HTMLElement>,
  ) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", session.id);
    setDraggedSessionID(session.id);
    setArchiveError("");
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedSessionID(null);
    setDropActive(false);
  }, []);

  const handleArchivedDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropActive(true);
  }, []);

  const handleArchivedDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropActive(false);
  }, []);

  const handleArchivedDrop = useCallback((event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    const sessionID = event.dataTransfer.getData("text/plain") || draggedSessionID;
    setDropActive(false);
    setDraggedSessionID(null);
    archiveByID(sessionID);
  }, [archiveByID, draggedSessionID]);

  const openCardSession = useCallback((session: KanbanSession) => {
    if (onOpenSession) void onOpenSession(session);
  }, [onOpenSession]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="kanban-modal">
        <DialogHeader className="kanban-header">
          <div className="kanban-heading-row">
            <div>
              <p className="kanban-eyebrow">Work surface</p>
              <DialogTitle>Kanban</DialogTitle>
            </div>
            <div className="kanban-header-controls">
              <label className="kanban-project-filter">
                <span>Project</span>
                <select
                  aria-label="Filter by project"
                  value={activeProjectFilter}
                  onChange={(event) => {
                    const nextFilter = event.target.value;
                    if (projectFilter === undefined) setLocalProjectFilter(nextFilter);
                    onProjectFilterChange?.(nextFilter);
                  }}
                >
                  <option value={kanbanAllProjectsFilter}>All projects</option>
                  {projectOptions.map((project) => (
                    <option key={project.value} value={project.value}>
                      {project.label}
                    </option>
                  ))}
                </select>
              </label>
              <span className="kanban-shortcut-hint" aria-label={`Keyboard shortcut ${formatShortcut(shortcut)}`}>
                {formatShortcut(shortcut)}
              </span>
            </div>
          </div>
          <DialogDescription className="kanban-description">
            Keep agent sessions in view, then archive the ones you are done with.
          </DialogDescription>
        </DialogHeader>

        {(error || archiveError) && (
          <div className="kanban-error" role="alert">
            {error || archiveError}
          </div>
        )}
        {loading && (
          <div className="kanban-loading" role="status">
            Loading agent sessions…
          </div>
        )}

        <div
          className="kanban-columns"
          aria-label="Agent session board"
          aria-busy={loading || undefined}
        >
          {kanbanColumns.map((column) => (
            <KanbanColumn
              key={column.status}
              column={column}
              sessions={visibleSessions.filter(
                (session) => sessionStatus(session, archivedIDs, restoredIDs) === column.status,
              )}
              dropActive={dropActive}
              draggedSessionID={draggedSessionID}
              archivingIDs={archivingIDs}
              onArchivedDragOver={handleArchivedDragOver}
              onArchivedDragLeave={handleArchivedDragLeave}
              onArchivedDrop={handleArchivedDrop}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onOpenSession={onOpenSession ? openCardSession : undefined}
              onArchiveSession={archiveSession}
              onRestoreSession={restoreSession}
              onCardPointerEnter={onCardPointerEnter}
              onCardPointerLeave={onCardPointerLeave}
              onCardFocus={onCardFocus}
              onCardBlur={onCardBlur}
            />
          ))}
        </div>
        {hoveredSession && hoveredStatus && (
          <SessionInfoCard
            ref={sessionInfoCardRef}
            session={infoSessionForKanban(hoveredSession, hoveredStatus)}
            summary={infoSummaryForKanban(hoveredSession, hoveredStatus)}
            style={{
              position: "absolute",
              left: `${sessionInfoCardPosition.left}px`,
              top: `${sessionInfoCardPosition.top}px`,
              zIndex: 60,
              pointerEvents: "none",
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export { KanbanDialog as KanbanModal };
