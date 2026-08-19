import {
  ArchiveIcon,
  BotIcon,
  CheckCircle2Icon,
  Clock3Icon,
  FolderIcon,
  GripVerticalIcon,
  OctagonAlertIcon,
  PauseCircleIcon,
  Undo2Icon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { KanbanSession, KanbanStatus } from "../types";

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
  loading?: boolean;
  error?: string;
  onOpenChange(open: boolean): void;
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

export function KanbanDialog({
  open,
  sessions,
  loading = false,
  error = "",
  onOpenChange,
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="kanban-modal">
        <DialogHeader className="kanban-header">
          <div className="kanban-heading-row">
            <div>
              <p className="kanban-eyebrow">Work surface</p>
              <DialogTitle>Kanban</DialogTitle>
            </div>
            <span className="kanban-shortcut-hint" aria-label="Keyboard shortcut Command Shift K">
              ⌘⇧K
            </span>
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
          {kanbanColumns.map((column) => {
            const columnSessions = sessions.filter(
              (session) => sessionStatus(session, archivedIDs, restoredIDs) === column.status,
            );
            const isArchived = column.status === "archived";
            return (
              <section
                key={column.status}
                className="kanban-column"
                data-status={column.status}
                data-drop-active={isArchived && dropActive ? "true" : undefined}
                aria-labelledby={`kanban-column-${column.status}`}
                onDragOver={isArchived ? handleArchivedDragOver : undefined}
                onDragLeave={isArchived ? handleArchivedDragLeave : undefined}
                onDrop={isArchived ? handleArchivedDrop : undefined}
              >
                <header className="kanban-column-header">
                  <div>
                    <h2 id={`kanban-column-${column.status}`}>
                      <StatusIcon status={column.status} />
                      {column.label}
                    </h2>
                    <p>{column.description}</p>
                  </div>
                  <span className="kanban-column-count" aria-label={`${columnSessions.length} sessions`}>
                    {columnSessions.length}
                  </span>
                </header>
                <ul className="kanban-card-list" aria-label={`${column.label} sessions`}>
                  {columnSessions.map((session) => {
                    const isArchiving = archivingIDs.has(session.id);
                    const canArchive = !isArchived;
                    return (
                      <li key={session.id}>
                        <article
                          className="kanban-card"
                          data-testid={`kanban-card-${session.id}`}
                          data-status={column.status}
                          draggable={canArchive && !isArchiving}
                          aria-label={`${session.title}, ${displayAgent(session.agent)} session`}
                          onDragStart={canArchive && !isArchiving ? (event) => handleDragStart(session, event) : undefined}
                          onDragEnd={canArchive && !isArchiving ? handleDragEnd : undefined}
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
                            {canArchive && <GripVerticalIcon aria-hidden="true" className="kanban-card-grip" />}
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
                          {canArchive ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="kanban-card-action"
                              onClick={() => void archiveSession(session)}
                              disabled={isArchiving}
                            >
                              <ArchiveIcon aria-hidden="true" />
                              Archive {session.title}
                            </Button>
                          ) : isArchived ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="kanban-card-action"
                              onClick={() => void restoreSession(session)}
                              disabled={isArchiving}
                            >
                              <Undo2Icon aria-hidden="true" />
                              Restore {session.title}
                            </Button>
                          ) : (
                            <span className="kanban-card-archived">
                              <CheckCircle2Icon aria-hidden="true" />
                              Archived
                            </span>
                          )}
                        </article>
                      </li>
                    );
                  })}
                </ul>
                {columnSessions.length === 0 && (
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
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export { KanbanDialog as KanbanModal };
