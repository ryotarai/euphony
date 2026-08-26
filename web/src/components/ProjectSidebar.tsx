import {
  BotIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleHelpIcon,
  CirclePauseIcon,
  CircleXIcon,
  Clock3Icon,
  FolderPlusIcon,
  ArchiveIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { useState } from "react";
import type { FocusEvent, PointerEvent } from "react";
import type { AgentSummary, Project, Session } from "../types";
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

function sentence(value: string, fallback: string) {
  const text = value.trim() || fallback;
  return /[.!?。！？]$/u.test(text) ? text : `${text}.`;
}

function sessionIdentity(session: Session, summary: SessionSummary) {
  if (session.customName) return session.name;
  return providerLabel(summary?.provider ?? session.agent) || session.name;
}

function sessionPurpose(session: Session, summary: SessionSummary) {
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
      return <CircleDotIcon {...props} />;
    case "blocked":
      return <span {...props}>🚫</span>;
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

function projectSessions(
  projects: Project[],
  sessions: Session[],
) {
  const knownProjectIDs = new Set(projects.map((project) => project.id));
  const grouped = new Map<string, Session[]>();
  const unassigned: Session[] = [];

  for (const session of sessions) {
    if (!session.projectId || !knownProjectIDs.has(session.projectId)) {
      unassigned.push(session);
      continue;
    }
    const group = grouped.get(session.projectId);
    if (group) group.push(session);
    else grouped.set(session.projectId, [session]);
  }

  return { grouped, orderedProjects: projects, unassigned };
}

export function flattenProjectSidebarSessions(
  projects: Project[],
  sessions: Session[],
) {
  const { grouped, orderedProjects, unassigned } = projectSessions(
    projects,
    sessions,
  );
  return [
    ...orderedProjects.flatMap((project) => grouped.get(project.id) ?? []),
    ...unassigned,
  ];
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
  selected,
  onSelectSession,
  onSelectArchivedSession,
  onArchive,
  onDelete,
  onSessionPointerEnter,
  onSessionPointerLeave,
  onSessionFocus,
  onSessionBlur,
}: {
  session: Session;
  summary: SessionSummary;
  selected: boolean;
  onSelectSession(sessionID: string): void;
  onSelectArchivedSession?(session: Session): void;
  onArchive?: (session: Session) => void;
  onDelete?: (session: Session) => void;
} & SessionInfoInteractionHandlers) {
  const agentSession = isAgentSession(session);
  const effectiveSummary = agentSession ? summary : undefined;
  const status = activity(session, effectiveSummary);
  const identity = sessionIdentity(session, effectiveSummary);
  const purpose = sessionPurpose(session, effectiveSummary);
  const action = effectiveSummary && isHumanActionRequired(effectiveSummary)
    ? effectiveSummary.action?.trim() ?? ""
    : "";
  const unread = effectiveSummary?.unread === true;
  const latestSummary = effectiveSummary?.summary?.trim() || "";
  const purposeText = purpose || latestSummary || "New session";
  const showSummary = Boolean(latestSummary && purpose && latestSummary !== purpose);
  const requiredAction = action || "None";
  const accessibleDescriptionID = `project-session-details-${session.id}`;
  const accessibleDescription = [
    `Status: ${statusLabel(status)}.`,
    `Latest summary: ${sentence(latestSummary, "None")}`,
    `Required action: ${sentence(requiredAction, "None")}`,
    unread ? "Unread." : "Read.",
    ...(session.needsAttention ? ["Needs attention."] : []),
  ].join(" ");
  const selectionDetails = [purpose, action].filter(Boolean).join(" — ");
  const selectionLabel = `Select ${identity}${selectionDetails ? ` — ${selectionDetails}` : ""}`;
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
  );

  return (
    <li
      className="project-session-row"
      data-agent={agentSession ? "true" : undefined}
      data-attention={session.needsAttention ? "true" : undefined}
      data-state={status}
      data-unread={unread ? "true" : "false"}
      onContextMenu={onContextMenu}
      onPointerEnter={(event) => onSessionPointerEnter?.(session, event)}
      onPointerLeave={() => onSessionPointerLeave?.(session.id)}
    >
      <button
        type="button"
        className="project-session-select"
        aria-label={selectionLabel}
        aria-describedby={accessibleDescriptionID}
        aria-pressed={selected}
        aria-current={selected ? "true" : undefined}
        data-unread={unread ? "true" : "false"}
        onFocus={(event) => onSessionFocus?.(session, event)}
        onBlur={() => onSessionBlur?.(session.id)}
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
  selectedID,
  onSelectSession,
  onSelectArchivedSession,
  onCreateTerminal,
  onCreateAgent,
  onArchive,
  onDelete,
  onSessionPointerEnter,
  onSessionPointerLeave,
  onSessionFocus,
  onSessionBlur,
}: {
  project?: Project;
  sessions: Session[];
  summaries: Map<string, AgentSummary>;
  selectedID?: string | null;
  onSelectSession(sessionID: string): void;
  onSelectArchivedSession?(session: Session): void;
  onCreateTerminal?(projectID: string): void;
  onCreateAgent?(projectID: string): void;
  onArchive?: (session: Session) => void;
  onDelete?: (session: Session) => void;
} & SessionInfoInteractionHandlers) {
  const groupID = project?.id ?? "unassigned";
  const headingID = `project-sidebar-heading-${groupID}`;
  const label = project?.path ?? "Unassigned";

  return (
    <section
      className={`project-sidebar-group${project ? "" : " project-sidebar-unassigned"}`}
      data-project-id={groupID}
      data-bounded={!project ? "true" : undefined}
      aria-labelledby={headingID}
    >
      <header className="project-sidebar-header">
        <h2 className="project-sidebar-path" id={headingID} title={label}>{label}</h2>
        {project && (onCreateTerminal || onCreateAgent) && (
          <ProjectActions
            project={project}
            onCreateTerminal={onCreateTerminal}
            onCreateAgent={onCreateAgent}
          />
        )}
      </header>
      {sessions.length > 0 ? (
        <ul className="project-sidebar-session-list">
          {sessions.map((session) => (
            <ProjectSessionRow
              key={session.id}
              session={session}
              summary={summaries.get(session.id)}
              selected={selectedID === session.id}
              onSelectSession={onSelectSession}
              onSelectArchivedSession={onSelectArchivedSession}
              onArchive={onArchive}
              onDelete={onDelete}
              onSessionPointerEnter={onSessionPointerEnter}
              onSessionPointerLeave={onSessionPointerLeave}
              onSessionFocus={onSessionFocus}
              onSessionBlur={onSessionBlur}
            />
          ))}
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
  onSessionPointerEnter,
  onSessionPointerLeave,
  onSessionFocus,
  onSessionBlur,
}: ProjectSidebarProps) {
  const [localFilter, setLocalFilter] = useState("");
  const summaries = latestSummaries(agentSummaries);
  const sessionFilter = localFilter;
  const visibleSessions = filterSessions(sessions, summaries, sessionFilter);
  const { grouped, orderedProjects, unassigned } = projectSessions(
    projects,
    visibleSessions,
  );
  const normalizedFilter = normalizeSessionFilter(sessionFilter);
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
        {visibleProjects.map((project) => (
          <ProjectGroup
            key={project.id}
            project={project}
            sessions={grouped.get(project.id) ?? []}
            summaries={summaries}
            selectedID={selectedID}
            onSelectSession={onSelectSession}
            onSelectArchivedSession={onSelectArchivedSession}
            onCreateTerminal={onCreateTerminal}
            onCreateAgent={onCreateAgent}
            onArchive={onArchive}
            onDelete={onDelete}
            onSessionPointerEnter={onSessionPointerEnter}
            onSessionPointerLeave={onSessionPointerLeave}
            onSessionFocus={onSessionFocus}
            onSessionBlur={onSessionBlur}
          />
        ))}
        {unassigned.length > 0 && (
          <ProjectGroup
            sessions={unassigned}
            summaries={summaries}
            selectedID={selectedID}
            onSelectSession={onSelectSession}
            onSelectArchivedSession={onSelectArchivedSession}
            onCreateTerminal={onCreateTerminal}
            onCreateAgent={onCreateAgent}
            onArchive={onArchive}
            onDelete={onDelete}
            onSessionPointerEnter={onSessionPointerEnter}
            onSessionPointerLeave={onSessionPointerLeave}
            onSessionFocus={onSessionFocus}
            onSessionBlur={onSessionBlur}
          />
        )}
        {normalizedFilter && visibleSessions.length === 0 && (
          <p className="project-sidebar-filter-empty">No sessions match your filter.</p>
        )}
      </div>
    </nav>
  );
}
