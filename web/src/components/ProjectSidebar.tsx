import {
  BotIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  CirclePauseIcon,
  CircleXIcon,
  Clock3Icon,
  FolderPlusIcon,
  ArchiveIcon,
  GripVerticalIcon,
  LoaderCircleIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import type { FocusEvent, PointerEvent } from "react";
import type { AgentSummary, Project, Session } from "../types";
import { groupProjectSidebarSessions } from "../projectSidebarUtils";
import { filterSessions, isHumanActionRequired, normalizeSessionFilter } from "../sessionPresentation";
import { useSessionContextMenu } from "./SessionContextMenu";
import { SessionFilter } from "./SessionFilter";

export interface SessionInfoInteractionHandlers {
  onSessionPointerEnter?(session: Session, event: PointerEvent<HTMLElement>): void;
  onSessionPointerLeave?(sessionID: string): void;
  onSessionFocus?(session: Session, event: FocusEvent<HTMLElement>): void;
  onSessionBlur?(sessionID: string): void;
}

export interface ProjectSidebarProps extends SessionInfoInteractionHandlers {
  projects: Project[];
  sessions: Session[];
  agentSummaries: AgentSummary[];
  selectedID?: string | null;
  onSelectSession(sessionID: string): void;
  onSelectArchivedSession?(session: Session): void;
  onCreateTerminal?(projectID: string): void;
  onCreateAgent?(projectID: string): void;
  onAddProject?(): void;
  archivedVisible?: boolean;
  archivedLoading?: boolean;
  archivedError?: string;
  onShowArchived?(): void;
  onHideArchived?(): void;
  onArchive?(session: Session): void;
  onDelete?(session: Session): void;
  onRename?(session: Session): void;
  onReorderSessions?(orderedIDs: string[]): void;
  onReorderProjects?(orderedIDs: string[]): void;
}

type SessionSummary = AgentSummary | undefined;

function isAgentSession(session: Session) {
  return session.agent === "codex" || session.agent === "claude";
}

function statusLabel(status: string) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function activity(session: Session, summary: SessionSummary) {
  if (session.archived) return "archived";
  if (summary) return summary.status;
  if (session.agentStatus) return session.agentStatus;
  return session.state === "running" ? "terminal" : session.state;
}

function providerLabel(provider: string | undefined) {
  if (!provider) return "";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

const generatedTerminalName = "terminal";

function isGeneratedTerminal(session: Session) {
  return !session.customName && session.name.trim().toLocaleLowerCase() === generatedTerminalName;
}

function projectName(path: string) {
  const trimmed = path.trim().replace(/\/+$/u, "");
  return trimmed.split("/").filter(Boolean).at(-1) || trimmed || "Unassigned";
}

function isProjectActionTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("button"));
}

function sentence(value: string, fallback: string) {
  const text = value.trim() || fallback;
  return /[.!?。！？]$/u.test(text) ? text : `${text}.`;
}

function sessionIdentity(
  session: Session,
  summary: SessionSummary,
  terminalOrdinal?: number,
) {
  if (session.customName) return session.name;
  const provider = providerLabel(session.agent || summary?.provider);
  if (provider) return provider;
  if (isGeneratedTerminal(session)) return `Terminal ${terminalOrdinal ?? 1}`;
  return session.name;
}

function sessionPurpose(session: Session, summary: SessionSummary) {
  if (!isAgentSession(session)) return "";
  const identity = sessionIdentity(session, summary).trim().toLocaleLowerCase();
  const generatedPurpose = summary?.purpose?.trim();
  if (generatedPurpose && generatedPurpose.toLocaleLowerCase() !== identity) {
    return generatedPurpose;
  }
  const metadataPurpose = session.agentTitle?.trim() || session.processName?.trim();
  if (metadataPurpose && metadataPurpose.toLocaleLowerCase() !== identity) {
    return metadataPurpose;
  }
  return "";
}

function latestSummaries(summaries: AgentSummary[]) {
  const current = new Map<string, AgentSummary>();
  for (const summary of summaries) {
    if (summary.done) continue;
    const previous = current.get(summary.terminalId);
    if (!previous) {
      current.set(summary.terminalId, summary);
      continue;
    }
    const previousTime = Date.parse(previous.generatedAt);
    const nextTime = Date.parse(summary.generatedAt);
    if (
      (!Number.isFinite(previousTime) && Number.isFinite(nextTime)) ||
      (Number.isFinite(nextTime) && nextTime >= previousTime)
    ) {
      current.set(summary.terminalId, summary);
    }
  }
  return current;
}

function sessionStatusIcon(status: string) {
  const props = {
    "aria-label": statusLabel(status),
    className: `project-session-status-icon project-session-status-${status}`,
    role: "img" as const,
  };

  switch (status) {
    case "archived":
      return <ArchiveIcon {...props} />;
    case "running":
      return <LoaderCircleIcon {...props} />;
    case "blocked":
      return <CircleAlertIcon {...props} />;
    case "waiting":
      return <CirclePauseIcon {...props} />;
    case "terminal":
      return <SquareTerminalIcon {...props} />;
    case "starting":
      return <Clock3Icon {...props} />;
    case "exited":
      return <CircleCheckIcon {...props} />;
    case "failed":
      return <CircleXIcon {...props} />;
    default:
      return <CircleHelpIcon {...props} />;
  }
}

function ProjectActions({
  project,
  onCreateTerminal,
  onCreateAgent,
}: {
  project: Project;
  onCreateTerminal?(projectID: string): void;
  onCreateAgent?(projectID: string): void;
}) {
  if (!onCreateTerminal && !onCreateAgent) return null;

  return (
    <div className="project-sidebar-actions">
      {onCreateTerminal && (
        <button
          type="button"
          className="project-create-terminal"
          aria-label={`Create terminal in ${project.path}`}
          title={`Create terminal in ${project.path}`}
          onClick={(event) => {
            event.stopPropagation();
            onCreateTerminal(project.id);
          }}
        >
          <SquareTerminalIcon aria-hidden="true" />
          <span className="sr-only">Create terminal in {project.path}</span>
        </button>
      )}
      {onCreateAgent && (
        <button
          type="button"
          className="project-create-agent"
          aria-label={`Start agent in ${project.path}`}
          title={`Start agent in ${project.path}`}
          onClick={(event) => {
            event.stopPropagation();
            onCreateAgent(project.id);
          }}
        >
          <BotIcon aria-hidden="true" />
          <span className="sr-only">Start agent in {project.path}</span>
        </button>
      )}
    </div>
  );
}

function ProjectSessionRow({
  session,
  summary,
  terminalOrdinal,
  selected,
  onSelectSession,
  onSelectArchivedSession,
  onArchive,
  onDelete,
  onRename,
  canReorder,
  canMoveUp,
  canMoveDown,
  onMove,
  onDragStart,
  onDrop,
  onDragEnd,
  onSessionPointerEnter,
  onSessionPointerLeave,
  onSessionFocus,
  onSessionBlur,
}: {
  session: Session;
  summary: SessionSummary;
  terminalOrdinal?: number;
  selected: boolean;
  onSelectSession(sessionID: string): void;
  onSelectArchivedSession?(session: Session): void;
  onArchive?: (session: Session) => void;
  onDelete?: (session: Session) => void;
  onRename?: (session: Session) => void;
  canReorder?: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onMove?(direction: "up" | "down"): void;
  onDragStart?(session: Session): void;
  onDrop?(session: Session): void;
  onDragEnd?(): void;
} & SessionInfoInteractionHandlers) {
  const agentSession = isAgentSession(session);
  const effectiveSummary = agentSession ? summary : undefined;
  const status = activity(session, effectiveSummary);
  const identity = sessionIdentity(session, effectiveSummary, terminalOrdinal);
  const purpose = sessionPurpose(session, effectiveSummary);
  const action = effectiveSummary && isHumanActionRequired(effectiveSummary)
    ? effectiveSummary.action?.trim() ?? ""
    : "";
  const unread = effectiveSummary?.unread === true;
  const latestSummary = effectiveSummary?.summary?.trim() || "";
  const processName = !agentSession ? session.processName?.trim() || "" : "";
  const purposeText = session.customName
    ? identity
    : purpose || latestSummary || identity || "New session";
  const showSummary = Boolean(latestSummary && latestSummary !== purposeText);
  const showProcessName = Boolean(processName && processName !== purposeText);
  const requiredAction = action || "None";
  const accessibleDescriptionID = `project-session-details-${session.id}`;
  const accessibleDescription = [
    `Status: ${statusLabel(status)}.`,
    `Latest summary: ${sentence(latestSummary, "None")}`,
    `Required action: ${sentence(requiredAction, "None")}`,
    ...(processName ? [`Process: ${processName}.`] : []),
    unread ? "Unread." : "Read.",
    ...(session.needsAttention ? ["Needs attention."] : []),
  ].join(" ");
  const selectionDetails = [session.customName ? "" : purpose, action]
    .filter(Boolean)
    .join(" — ");
  const selectionLabel = `Select ${identity}${selectionDetails ? ` — ${selectionDetails}` : ""}`;
  const reorderActions = [
    ...(canMoveUp ? [{ label: "Move up", onSelect: () => onMove?.("up") }] : []),
    ...(canMoveDown ? [{ label: "Move down", onSelect: () => onMove?.("down") }] : []),
  ];
  const contextAction = session.archived
    ? undefined
    : agentSession
      ? onArchive
        ? () => onArchive(session)
        : undefined
      : onDelete
        ? () => onDelete(session)
        : undefined;
  const { onContextMenu, menu } = useSessionContextMenu(
    identity,
    contextAction,
    agentSession ? "Archive" : "Delete",
    [
      ...reorderActions,
      ...(onRename && !session.archived
        ? [{ label: "Rename", onSelect: () => onRename(session) }]
        : []),
    ],
  );

  return (
    <li
      className="project-session-row"
      draggable={canReorder}
      data-session-id={session.id}
      data-agent={agentSession ? "true" : undefined}
      data-attention={session.needsAttention ? "true" : undefined}
      data-state={status}
      data-unread={unread ? "true" : "false"}
      onContextMenu={onContextMenu}
      onPointerEnter={(event) => onSessionPointerEnter?.(session, event)}
      onPointerLeave={() => onSessionPointerLeave?.(session.id)}
      onDragStart={(event) => {
        if (!canReorder) return;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", session.id);
        onDragStart?.(session);
      }}
      onDragOver={(event) => {
        if (!canReorder) return;
        event.preventDefault();
      }}
      onDrop={(event) => {
        if (!canReorder) return;
        event.preventDefault();
        onDrop?.(session);
      }}
      onDragEnd={onDragEnd}
    >
      {canReorder && (
        <span
          className="project-session-drag-handle"
          aria-hidden="true"
          title="Drag to reorder"
        >
          <GripVerticalIcon />
        </span>
      )}
      <button
        type="button"
        className="project-session-select"
        aria-label={selectionLabel}
        aria-describedby={accessibleDescriptionID}
        aria-pressed={selected}
        aria-current={selected ? "true" : undefined}
        aria-keyshortcuts={canMoveUp || canMoveDown ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
        data-unread={unread ? "true" : "false"}
        onFocus={(event) => onSessionFocus?.(session, event)}
        onBlur={() => onSessionBlur?.(session.id)}
        onKeyDown={(event) => {
          if (!event.altKey) return;
          if (event.key === "ArrowUp" && canMoveUp) {
            event.preventDefault();
            onMove?.("up");
          } else if (event.key === "ArrowDown" && canMoveDown) {
            event.preventDefault();
            onMove?.("down");
          }
        }}
        onClick={() => {
          if (session.archived) onSelectArchivedSession?.(session);
          else onSelectSession(session.id);
        }}
      >
        {sessionStatusIcon(status)}
        {purposeText && (
          <span className="project-session-purpose" data-unread={unread ? "true" : "false"}>
            {purposeText}
          </span>
        )}
        {showSummary && (
          <span
            className="project-session-summary"
            data-unread={unread ? "true" : "false"}
          >
            {latestSummary}
          </span>
        )}
        {showProcessName && (
          <span
            className="project-session-summary project-session-process"
            data-unread={unread ? "true" : "false"}
          >
            {processName}
          </span>
        )}
        {action && (
          <span
            className="project-session-action"
            data-unread={unread ? "true" : "false"}
          >
            {action}
          </span>
        )}
        {session.needsAttention && <span className="attention-dot" aria-hidden="true" />}
      </button>
      <span id={accessibleDescriptionID} className="sr-only">
        {accessibleDescription}
      </span>
      {menu}
    </li>
  );
}

function ProjectGroup({
  project,
  sessions,
  summaries,
  terminalOrdinals,
  selectedID,
  onSelectSession,
  onSelectArchivedSession,
  onCreateTerminal,
  onCreateAgent,
  onArchive,
  onDelete,
  onRename,
  canReorderSessions,
  onSessionMove,
  onSessionDragStart,
  onSessionDrop,
  onSessionDragEnd,
  onProjectDragStart,
  onProjectDragOver,
  onProjectDrop,
  onProjectDragEnd,
  canMoveProjectUp,
  canMoveProjectDown,
  onProjectMove,
  onSessionPointerEnter,
  onSessionPointerLeave,
  onSessionFocus,
  onSessionBlur,
}: {
  project?: Project;
  sessions: Session[];
  summaries: Map<string, AgentSummary>;
  terminalOrdinals: Map<string, number>;
  selectedID?: string | null;
  onSelectSession(sessionID: string): void;
  onSelectArchivedSession?(session: Session): void;
  onCreateTerminal?(projectID: string): void;
  onCreateAgent?(projectID: string): void;
  onArchive?: (session: Session) => void;
  onDelete?: (session: Session) => void;
  onRename?: (session: Session) => void;
  canReorderSessions?: boolean;
  onSessionMove?(session: Session, direction: "up" | "down"): void;
  onSessionDragStart?(session: Session): void;
  onSessionDrop?(session: Session): void;
  onSessionDragEnd?(): void;
  onProjectDragStart?(project: Project): void;
  onProjectDragOver?(): void;
  onProjectDrop?(project: Project): void;
  onProjectDragEnd?(): void;
  canMoveProjectUp?: boolean;
  canMoveProjectDown?: boolean;
  onProjectMove?(direction: "up" | "down"): void;
} & SessionInfoInteractionHandlers) {
  const groupID = project?.id ?? "unassigned";
  const headingID = `project-sidebar-heading-${groupID}`;
  const label = project?.path ?? "Unassigned";
  const heading = project ? projectName(label) : label;
  const projectReorderActions = [
    ...(canMoveProjectUp
      ? [{ label: "Move project up", onSelect: () => onProjectMove?.("up") }]
      : []),
    ...(canMoveProjectDown
      ? [{ label: "Move project down", onSelect: () => onProjectMove?.("down") }]
      : []),
  ];
  const {
    onContextMenu: onProjectContextMenu,
    menu: projectMenu,
  } = useSessionContextMenu(heading, undefined, "Delete", projectReorderActions);
  const activeSessions = sessions.filter((session) => !session.archived);

  return (
    <section
      className={`project-sidebar-group${project ? "" : " project-sidebar-unassigned"}`}
      data-project-id={groupID}
      data-bounded={!project ? "true" : undefined}
      aria-labelledby={headingID}
    >
      <header
        className="project-sidebar-header"
        draggable={Boolean(project && onProjectDragStart)}
        tabIndex={projectReorderActions.length > 0 ? 0 : undefined}
        aria-keyshortcuts={projectReorderActions.length > 0
          ? "Alt+ArrowUp Alt+ArrowDown"
          : undefined}
        onContextMenu={(event) => {
          if (isProjectActionTarget(event.target)) return;
          onProjectContextMenu(event);
        }}
        onKeyDown={(event) => {
          if (isProjectActionTarget(event.target)) return;
          if (!event.altKey) return;
          if (event.key === "ArrowUp" && canMoveProjectUp) {
            event.preventDefault();
            onProjectMove?.("up");
          } else if (event.key === "ArrowDown" && canMoveProjectDown) {
            event.preventDefault();
            onProjectMove?.("down");
          }
        }}
        onDragStart={(event) => {
          if (isProjectActionTarget(event.target) || !project || !onProjectDragStart) return;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", project.id);
          onProjectDragStart(project);
        }}
        onDragOver={(event) => {
          if (isProjectActionTarget(event.target) || !project || !onProjectDragOver) return;
          event.preventDefault();
          onProjectDragOver();
        }}
        onDrop={(event) => {
          if (isProjectActionTarget(event.target) || !project || !onProjectDrop) return;
          event.preventDefault();
          onProjectDrop(project);
        }}
        onDragEnd={onProjectDragEnd}
      >
        <h2 className="project-sidebar-path" id={headingID} title={label}>{heading}</h2>
        {project && (onCreateTerminal || onCreateAgent) && (
          <ProjectActions
            project={project}
            onCreateTerminal={onCreateTerminal}
            onCreateAgent={onCreateAgent}
          />
        )}
      </header>
      {projectMenu}
      {sessions.length > 0 ? (
        <ul className="project-sidebar-session-list">
          {sessions.map((session) => {
            const activeIndex = activeSessions.findIndex((item) => item.id === session.id);
            const canMove = !session.archived && Boolean(canReorderSessions);
            return (
            <ProjectSessionRow
              key={session.id}
              session={session}
              summary={summaries.get(session.id)}
              terminalOrdinal={terminalOrdinals.get(session.id)}
              selected={selectedID === session.id}
              onSelectSession={onSelectSession}
              onSelectArchivedSession={onSelectArchivedSession}
              onArchive={onArchive}
              onDelete={onDelete}
              onRename={onRename}
              canReorder={canMove}
              canMoveUp={canMove && activeIndex > 0}
              canMoveDown={canMove && activeIndex >= 0 && activeIndex < activeSessions.length - 1}
              onMove={(direction) => onSessionMove?.(session, direction)}
              onDragStart={onSessionDragStart}
              onDrop={onSessionDrop}
              onDragEnd={onSessionDragEnd}
              onSessionPointerEnter={onSessionPointerEnter}
              onSessionPointerLeave={onSessionPointerLeave}
              onSessionFocus={onSessionFocus}
              onSessionBlur={onSessionBlur}
            />
            );
          })}
        </ul>
      ) : (
        <p className="project-sidebar-empty">No sessions yet.</p>
      )}
    </section>
  );
}

export function ProjectSidebar({
  projects,
  sessions,
  agentSummaries,
  selectedID,
  onSelectSession,
  onSelectArchivedSession,
  onCreateTerminal,
  onCreateAgent,
  onAddProject,
  archivedVisible = false,
  archivedLoading = false,
  archivedError = "",
  onShowArchived,
  onHideArchived,
  onArchive,
  onDelete,
  onRename,
  onReorderSessions,
  onReorderProjects,
  onSessionPointerEnter,
  onSessionPointerLeave,
  onSessionFocus,
  onSessionBlur,
}: ProjectSidebarProps) {
  const [localFilter, setLocalFilter] = useState("");
  const terminalOrdinalByIDRef = useRef(new Map<string, number>());
  const nextTerminalOrdinalByProjectRef = useRef(new Map<string, number>());
  const summaries = latestSummaries(agentSummaries);
  const terminalOrdinals = new Map<string, number>();
  for (const session of sessions) {
    if (!isGeneratedTerminal(session)) continue;
    const projectKey = session.projectId || "unassigned";
    const existing = terminalOrdinalByIDRef.current.get(session.id);
    const ordinal = existing ?? (() => {
      const next = (nextTerminalOrdinalByProjectRef.current.get(projectKey) ?? 0) + 1;
      nextTerminalOrdinalByProjectRef.current.set(projectKey, next);
      terminalOrdinalByIDRef.current.set(session.id, next);
      return next;
    })();
    terminalOrdinals.set(session.id, ordinal);
  }
  const sessionFilter = localFilter;
  const visibleSessions = filterSessions(
    sessions,
    summaries,
    sessionFilter,
    (session, summary) => sessionIdentity(session, summary, terminalOrdinals.get(session.id)),
  );
  const { grouped, orderedProjects, unassigned } = groupProjectSidebarSessions(
    projects,
    visibleSessions,
  );
  const normalizedFilter = normalizeSessionFilter(sessionFilter);
  const draggedSessionIDRef = useRef<string | null>(null);
  const draggedProjectIDRef = useRef<string | null>(null);
  const reorderEnabled = !normalizedFilter;

  const reorderSessionGroup = (groupID: string, targetID: string) => {
    const draggedSessionID = draggedSessionIDRef.current;
    if (!draggedSessionID || draggedSessionID === targetID || !reorderEnabled) return;
    const groupSessions = groupID === "unassigned"
      ? unassigned
      : grouped.get(groupID) ?? [];
    if (
      !groupSessions.some((session) => session.id === draggedSessionID && !session.archived)
      || !groupSessions.some((session) => session.id === targetID && !session.archived)
    ) return;
    const activeIDs: string[] = [];
    const groupActiveIDs = new Set<string>();
    for (const session of groupSessions) {
      if (session.archived) continue;
      activeIDs.push(session.id);
      groupActiveIDs.add(session.id);
    }
    const fromIndex = activeIDs.indexOf(draggedSessionID);
    const targetIndex = activeIDs.indexOf(targetID);
    if (fromIndex < 0 || targetIndex < 0) return;
    activeIDs.splice(fromIndex, 1);
    activeIDs.splice(targetIndex, 0, draggedSessionID);
    let replacementIndex = 0;
    const finalIDs: string[] = [];
    for (const session of sessions) {
      if (session.archived) continue;
      finalIDs.push(
        groupActiveIDs.has(session.id)
          ? activeIDs[replacementIndex++]
          : session.id,
      );
    }
    onReorderSessions?.(finalIDs);
  };

  const reorderSessionByOffset = (
    groupID: string,
    sessionID: string,
    offset: -1 | 1,
  ) => {
    if (!reorderEnabled) return;
    const groupSessions = groupID === "unassigned"
      ? unassigned
      : grouped.get(groupID) ?? [];
    const activeIDs = groupSessions
      .filter((session) => !session.archived)
      .map((session) => session.id);
    const fromIndex = activeIDs.indexOf(sessionID);
    const targetIndex = fromIndex + offset;
    if (fromIndex < 0 || targetIndex < 0 || targetIndex >= activeIDs.length) return;
    activeIDs.splice(fromIndex, 1);
    activeIDs.splice(targetIndex, 0, sessionID);
    const groupActiveIDs = new Set(
      groupSessions.filter((session) => !session.archived).map((session) => session.id),
    );
    let replacementIndex = 0;
    const finalIDs: string[] = [];
    for (const session of sessions) {
      if (session.archived) continue;
      finalIDs.push(
        groupActiveIDs.has(session.id)
          ? activeIDs[replacementIndex++]
          : session.id,
      );
    }
    onReorderSessions?.(finalIDs);
  };

  const beginSessionDrag = (session: Session) => {
    if (!reorderEnabled || session.archived) return;
    draggedSessionIDRef.current = session.id;
  };
  const endSessionDrag = () => {
    draggedSessionIDRef.current = null;
  };
  const beginProjectDrag = (project: Project) => {
    if (!reorderEnabled) return;
    draggedProjectIDRef.current = project.id;
  };
  const dropProject = (project: Project) => {
    const draggedProjectID = draggedProjectIDRef.current;
    if (!draggedProjectID || draggedProjectID === project.id || !reorderEnabled) return;
    const projectIDs = orderedProjects.map((item) => item.id);
    const fromIndex = projectIDs.indexOf(draggedProjectID);
    const targetIndex = projectIDs.indexOf(project.id);
    if (fromIndex < 0 || targetIndex < 0) return;
    projectIDs.splice(fromIndex, 1);
    projectIDs.splice(targetIndex, 0, draggedProjectID);
    onReorderProjects?.(projectIDs);
  };
  const reorderProjectByOffset = (projectID: string, offset: -1 | 1) => {
    if (!reorderEnabled) return;
    const projectIDs = orderedProjects.map((project) => project.id);
    const fromIndex = projectIDs.indexOf(projectID);
    const targetIndex = fromIndex + offset;
    if (fromIndex < 0 || targetIndex < 0 || targetIndex >= projectIDs.length) return;
    projectIDs.splice(fromIndex, 1);
    projectIDs.splice(targetIndex, 0, projectID);
    onReorderProjects?.(projectIDs);
  };
  const endProjectDrag = () => {
    draggedProjectIDRef.current = null;
  };

  const renderGroup = (project: Project | undefined, groupSessions: Session[]) => (
    <ProjectGroup
      key={project?.id ?? "unassigned"}
      project={project}
      sessions={groupSessions}
      summaries={summaries}
      terminalOrdinals={terminalOrdinals}
      selectedID={selectedID}
      onSelectSession={onSelectSession}
      onSelectArchivedSession={onSelectArchivedSession}
      onCreateTerminal={onCreateTerminal}
      onCreateAgent={onCreateAgent}
      onArchive={onArchive}
      onDelete={onDelete}
      onRename={onRename}
      canReorderSessions={reorderEnabled && Boolean(onReorderSessions)}
      onSessionMove={(session, direction) => reorderSessionByOffset(
        project?.id ?? "unassigned",
        session.id,
        direction === "up" ? -1 : 1,
      )}
      onSessionDragStart={beginSessionDrag}
      onSessionDrop={(session) => reorderSessionGroup(project?.id ?? "unassigned", session.id)}
      onSessionDragEnd={endSessionDrag}
      onProjectDragStart={project && reorderEnabled && onReorderProjects ? beginProjectDrag : undefined}
      onProjectDragOver={project && reorderEnabled && onReorderProjects ? () => {} : undefined}
      onProjectDrop={project && reorderEnabled && onReorderProjects ? dropProject : undefined}
      onProjectDragEnd={endProjectDrag}
      canMoveProjectUp={Boolean(
        project && reorderEnabled && onReorderProjects
        && orderedProjects.findIndex((item) => item.id === project.id) > 0,
      )}
      canMoveProjectDown={Boolean(
        project && reorderEnabled && onReorderProjects
        && (() => {
          const index = orderedProjects.findIndex((item) => item.id === project.id);
          return index >= 0 && index < orderedProjects.length - 1;
        })(),
      )}
      onProjectMove={(direction) => {
        if (!project) return;
        reorderProjectByOffset(project.id, direction === "up" ? -1 : 1);
      }}
      onSessionPointerEnter={onSessionPointerEnter}
      onSessionPointerLeave={onSessionPointerLeave}
      onSessionFocus={onSessionFocus}
      onSessionBlur={onSessionBlur}
    />
  );
  const visibleProjects = normalizedFilter
    ? orderedProjects.filter((project) => (grouped.get(project.id)?.length ?? 0) > 0)
    : orderedProjects;

  return (
    <nav
      className="project-sidebar"
      aria-label="Projects and sessions"
      data-pane-name="agent-list"
    >
      <header className="project-sidebar-toolbar">
        <h1 className="sr-only">Projects</h1>
        <SessionFilter
          value={sessionFilter}
          totalCount={sessions.length}
          visibleCount={visibleSessions.length}
          onChange={setLocalFilter}
        />
        {onAddProject && (
          <button
            type="button"
            className="project-add-project"
            aria-label="Add project"
            title="Add project"
            onClick={(event) => {
              event.stopPropagation();
              onAddProject();
            }}
          >
            <FolderPlusIcon aria-hidden="true" />
            <span>Add project</span>
          </button>
        )}
        {onShowArchived && !archivedVisible && (
          <button
            type="button"
            className="project-sidebar-archived-toggle"
            aria-label="Show archived"
            onClick={(event) => {
              event.stopPropagation();
              onShowArchived();
            }}
          >
            <ArchiveIcon aria-hidden="true" />
            <span>{archivedLoading ? "Loading archived…" : "Show archived"}</span>
          </button>
        )}
        {onHideArchived && archivedVisible && (
          <button
            type="button"
            className="project-sidebar-archived-toggle"
            aria-label="Hide archived"
            onClick={(event) => {
              event.stopPropagation();
              onHideArchived();
            }}
          >
            <ArchiveIcon aria-hidden="true" />
            <span>Hide archived</span>
          </button>
        )}
      </header>
      {archivedError && <p className="project-sidebar-error" role="alert">{archivedError}</p>}
      <div className="project-sidebar-groups">
        {visibleProjects.map((project) => renderGroup(project, grouped.get(project.id) ?? []))}
        {unassigned.length > 0 && (
          renderGroup(undefined, unassigned)
        )}
        {normalizedFilter && visibleSessions.length === 0 && (
          <p className="project-sidebar-filter-empty">No sessions match your filter.</p>
        )}
      </div>
    </nav>
  );
}
