import {
  BotIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleHelpIcon,
  CirclePauseIcon,
  CircleXIcon,
  Clock3Icon,
  Columns3Icon,
  FolderPlusIcon,
  SquareTerminalIcon,
} from "lucide-react";
import type { FocusEvent, PointerEvent } from "react";
import type { AgentSummary, Project, Session } from "../types";
import { useSessionContextMenu } from "./SessionContextMenu";

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
  onCreateTerminal?(projectID: string): void;
  onCreateAgent?(projectID: string): void;
  onOpenKanban?(projectPath: string): void;
  onAddProject?(): void;
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
  if (summary) return summary.status;
  if (session.agentStatus) return session.agentStatus;
  return session.state === "running" ? "terminal" : session.state;
}

function providerLabel(provider: string | undefined) {
  if (!provider) return "";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
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

function terminalUpdatedAt(session: Session) {
  const timestamp = Date.parse(session.updatedAt ?? session.createdAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sessionPriority(session: Session, summary: SessionSummary) {
  if (session.needsAttention) return 0;
  switch (activity(session, isAgentSession(session) ? summary : undefined)) {
    case "blocked":
      return 1;
    case "running":
      return 2;
    case "waiting":
      return 3;
    case "terminal":
      return 4;
    default:
      return 100;
  }
}

function compareSessions(
  summaries: Map<string, AgentSummary>,
  left: Session,
  right: Session,
) {
  const priority =
    sessionPriority(left, summaries.get(left.id)) -
    sessionPriority(right, summaries.get(right.id));
  if (priority !== 0) return priority;
  return terminalUpdatedAt(right) - terminalUpdatedAt(left);
}

function latestProjectSessionUpdatedAt(sessions: Session[]) {
  if (sessions.length === 0) return 0;
  return sessions.reduce(
    (latest, session) => Math.max(latest, terminalUpdatedAt(session)),
    Number.NEGATIVE_INFINITY,
  );
}

function orderProjectsByLatestSession(
  projects: Project[],
  grouped: Map<string, Session[]>,
) {
  return projects
    .map((project, index) => ({
      index,
      latestUpdatedAt: latestProjectSessionUpdatedAt(
        grouped.get(project.id) ?? [],
      ),
      project,
    }))
    .sort(
      (left, right) =>
        right.latestUpdatedAt - left.latestUpdatedAt || left.index - right.index,
    )
    .map(({ project }) => project);
}

function sessionStatusIcon(status: string) {
  const props = {
    "aria-label": statusLabel(status),
    className: `project-session-status-icon project-session-status-${status}`,
    role: "img" as const,
  };

  switch (status) {
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
  summaries: Map<string, AgentSummary>,
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

  for (const group of grouped.values()) {
    group.sort((left, right) => compareSessions(summaries, left, right));
  }
  unassigned.sort((left, right) => compareSessions(summaries, left, right));
  const orderedProjects = orderProjectsByLatestSession(projects, grouped);
  return { grouped, orderedProjects, unassigned };
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
  onArchive?: (session: Session) => void;
  onDelete?: (session: Session) => void;
} & SessionInfoInteractionHandlers) {
  const agentSession = isAgentSession(session);
  const effectiveSummary = agentSession ? summary : undefined;
  const status = activity(session, effectiveSummary);
  const identity = sessionIdentity(session, effectiveSummary);
  const purpose = sessionPurpose(session, effectiveSummary);
  const action = effectiveSummary?.action?.trim() || "";
  const unread = effectiveSummary?.unread === true;
  const latestSummary = effectiveSummary?.summary?.trim() || "";
  const purposeText = purpose || latestSummary || "New session";
  const showSummary = Boolean(latestSummary && purpose && latestSummary !== purpose);
  const requiredAction = action || "None";
  const accessibleDescriptionID = `project-session-details-${session.id}`;
  const accessibleDescription = [
    `Status: ${statusLabel(status)}.`,
    `Latest summary: ${latestSummary}.`,
    `Required action: ${requiredAction}.`,
    unread ? "Unread." : "Read.",
    ...(session.needsAttention ? ["Needs attention."] : []),
  ].join(" ");
  const selectionDetails = [purpose, action].filter(Boolean).join(" — ");
  const selectionLabel = `Select ${identity}${selectionDetails ? ` — ${selectionDetails}` : ""}`;
  const { onContextMenu, menu } = useSessionContextMenu(
    identity,
    agentSession
      ? onArchive
        ? () => onArchive(session)
        : undefined
      : onDelete
        ? () => onDelete(session)
        : undefined,
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
        onClick={() => onSelectSession(session.id)}
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
  onCreateTerminal,
  onCreateAgent,
  onOpenKanban,
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
  onCreateTerminal?(projectID: string): void;
  onCreateAgent?(projectID: string): void;
  onOpenKanban?(projectPath: string): void;
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
        {project && onOpenKanban && (
          <button
            type="button"
            className="project-open-kanban"
            aria-label={`Open Kanban for ${project.path}`}
            title={`Open Kanban for ${project.path}`}
            onClick={(event) => {
              event.stopPropagation();
              onOpenKanban(project.path);
            }}
          >
            <Columns3Icon aria-hidden="true" />
            <span className="sr-only">Open Kanban for {project.path}</span>
          </button>
        )}
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
  onCreateTerminal,
  onCreateAgent,
  onOpenKanban,
  onAddProject,
  onArchive,
  onDelete,
  onSessionPointerEnter,
  onSessionPointerLeave,
  onSessionFocus,
  onSessionBlur,
}: ProjectSidebarProps) {
  const summaries = latestSummaries(agentSummaries);
  const { grouped, orderedProjects, unassigned } = projectSessions(
    projects,
    sessions,
    summaries,
  );

  return (
    <nav
      className="project-sidebar"
      aria-label="Projects and sessions"
      data-pane-name="agent-list"
    >
      <header className="project-sidebar-toolbar">
        <h1 className="sr-only">Projects</h1>
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
      </header>
      <div className="project-sidebar-groups">
        {orderedProjects.map((project) => (
          <ProjectGroup
            key={project.id}
            project={project}
            sessions={grouped.get(project.id) ?? []}
            summaries={summaries}
            selectedID={selectedID}
            onSelectSession={onSelectSession}
            onCreateTerminal={onCreateTerminal}
            onCreateAgent={onCreateAgent}
            onOpenKanban={onOpenKanban}
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
      </div>
    </nav>
  );
}
