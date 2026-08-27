import {
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  BotIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  CirclePauseIcon,
  CircleXIcon,
  Clock3Icon,
  ArchiveIcon,
  ListIcon,
  LoaderCircleIcon,
  PlusIcon,
  Settings2Icon,
  SquareTerminalIcon,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { ProjectSidebar, type SessionInfoInteractionHandlers } from "./ProjectSidebar";
import { useSessionContextMenu } from "./SessionContextMenu";
import { SessionInfoCard } from "./SessionInfoPane";
import {
  legacySessionActivity,
  legacySidebarSessionGroups,
} from "../legacySidebarUtils";
import type { AgentSummary, Project, Session, Settings } from "../types";
import {
  isTerminalTarget,
} from "../keybindings";
import {
  defaultTerminalCursorBlink,
  defaultTerminalCursorStyle,
  defaultTerminalFontFamily,
  defaultTerminalLineHeight,
  defaultTerminalOptionAsAlt,
  defaultTerminalScrollSensitivity,
} from "../settings";
import { filterSessions, normalizeSessionFilter } from "../sessionPresentation";
import { SessionFilter } from "./SessionFilter";

const defaultSidebarWidth = 256;
const minimumSidebarWidth = 180;
const maximumSidebarWidth = 600;
const sessionInfoHoverDelayMs = 500;
const sessionInfoCardGap = 12;
const sessionInfoViewportPadding = 12;

function normalizeSidebarWidth(width: number): number {
  return Math.round(Math.min(maximumSidebarWidth, Math.max(minimumSidebarWidth, width)));
}

interface SessionNavigationProps {
  sessions: Session[];
  selectedIDs: string[];
  projects?: Project[];
  agentSummaries?: AgentSummary[];
  selectedID?: string | null;
  pinnedIDs?: string[];
  onSelect(id: string, multiple: boolean, pin?: boolean): void;
  onSelectSession?(sessionID: string): void;
  onSelectArchivedSession?(session: Session): void;
  onCreate(cwd?: string): void;
  onCreateTerminal?(projectID: string): void;
  onCreateAgent?(projectID: string): void;
  onAddProject?(): void;
  onArchive?(session: Session): void;
  onDelete(session: Session): void;
  onRename?(session: Session): void;
  onReorderSessions?(orderedIDs: string[]): void;
  onReorderProjects?(orderedIDs: string[]): void;
  settings?: Settings;
  onSettingsChange?(settings: Settings): void;
  onOpenSettings?(): void;
  onOpenAllSessions?(): void;
  archivedVisible?: boolean;
  archivedLoading?: boolean;
  archivedError?: string;
  onShowArchived?(): void;
  onHideArchived?(): void;
  focusedPaneID?: string | null;
  agentsOpen?: boolean;
  agentSummaryCount?: number;
  onOpenAgents?(multiple?: boolean): void;
}

function statusLabel(status: string) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function latestSessionSummaries(summaries: AgentSummary[]) {
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

function canonicalPath(path: string) {
  return path.replace(/^\/private\/tmp(?=\/|$)/, "/tmp");
}

function displayPath(path: string) {
  return canonicalPath(path)
    .replace(/^\/Users\/[^/]+(?=\/|$)/, "~")
    .replace(/^\/home\/[^/]+(?=\/|$)/, "~");
}

function sessionLabel(session: Session) {
  if (session.customName) return session.name;
  return session.agentTitle?.trim() || session.processName?.trim() || session.name;
}

function sessionStatusIcon(status: string) {
  const label = statusLabel(status);
  const className = `session-status-icon session-status-${status}`;
  const props = {
    "aria-label": label,
    className,
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

function SessionListItem({
  session,
  selected,
  pinned,
  selectSession,
  onSelectArchivedSession,
  onArchive,
  onDelete,
  onRename,
  onSessionPointerEnter,
  onSessionPointerLeave,
  onSessionFocus,
  onSessionBlur,
}: {
  session: Session;
  selected: boolean;
  pinned: boolean;
  selectSession(id: string, multiple: boolean, pin?: boolean): void;
  onSelectArchivedSession?(session: Session): void;
  onArchive?(session: Session): void;
  onDelete(session: Session): void;
  onRename?(session: Session): void;
} & SessionInfoInteractionHandlers) {
  const isAgentSession = session.agent === "codex" || session.agent === "claude";
  const contextAction = session.archived
    ? undefined
    : isAgentSession
      ? onArchive
        ? () => onArchive(session)
        : undefined
      : () => onDelete(session);
  const { onContextMenu, menu } = useSessionContextMenu(
    session.name,
    contextAction,
    isAgentSession ? "Archive" : "Delete",
    onRename && !session.archived
      ? [{ label: "Rename", onSelect: () => onRename(session) }]
      : [],
  );
  const attentionDescriptionID = session.needsAttention
    ? `attention-${session.id}`
    : undefined;

  return (
    <SidebarMenuItem
      className="session-channel"
      data-state={legacySessionActivity(session)}
      data-attention={session.needsAttention || undefined}
      onContextMenu={onContextMenu}
      onPointerEnter={(event) => onSessionPointerEnter?.(session, event)}
      onPointerLeave={() => onSessionPointerLeave?.(session.id)}
    >
      <Checkbox
        className="pane-checkbox"
        aria-label={`Include ${session.name} in split`}
        checked={selected}
        data-pinned={pinned || undefined}
        title={pinned ? "Pinned — click to remove" : "Option-click to pin"}
        onClick={(event) => selectSession(session.id, true, event.altKey)}
      />
      <SidebarMenuButton
        className="session-select"
        size="lg"
        isActive={selected}
        aria-label={`Select ${session.name}`}
        aria-pressed={selected}
        aria-current={selected ? "true" : undefined}
        aria-describedby={attentionDescriptionID}
        title={displayPath(session.cwd)}
        onFocus={(event) => onSessionFocus?.(session, event)}
        onBlur={() => onSessionBlur?.(session.id)}
        onClick={(event) => {
          if (session.archived) onSelectArchivedSession?.(session);
          else selectSession(session.id, event.metaKey || event.ctrlKey);
        }}
      >
        {sessionStatusIcon(legacySessionActivity(session))}
        <span className="terminal-identity">
          <span className="agent-title">{sessionLabel(session)}</span>
        </span>
        {session.needsAttention && (
          <>
            <span className="attention-dot" aria-hidden="true" />
            <span className="sr-only" id={attentionDescriptionID}>
              Needs attention
            </span>
          </>
        )}
      </SidebarMenuButton>
      {menu}
    </SidebarMenuItem>
  );
}

function SessionList(
  props: SessionNavigationProps & {
    sessionInfoHandlers: SessionInfoInteractionHandlers;
  },
) {
  const { isMobile, setOpenMobile } = useSidebar();

  const selectSession = (id: string, multiple: boolean, pin?: boolean) => {
    if (pin === undefined) props.onSelect(id, multiple);
    else props.onSelect(id, multiple, pin);
    if (isMobile && !multiple) setOpenMobile(false);
  };
  const selectedIDSet = new Set(props.selectedIDs);
  const pinnedIDSet = new Set(props.pinnedIDs ?? []);
  const [sessionFilter, setSessionFilter] = useState("");
  const summaries = latestSessionSummaries(props.agentSummaries ?? []);
  const visibleSessions = filterSessions(props.sessions, summaries, sessionFilter);
  const normalizedFilter = normalizeSessionFilter(sessionFilter);

  return (
    <nav className="session-list" aria-label="Terminal sessions">
      <SessionFilter
        value={sessionFilter}
        totalCount={props.sessions.length}
        visibleCount={visibleSessions.length}
        onChange={setSessionFilter}
      />
      {props.onShowArchived && !props.archivedVisible && (
        <button
          type="button"
          className="session-list-archived-toggle"
          aria-label="Show archived"
          onClick={() => props.onShowArchived?.()}
        >
          <ArchiveIcon aria-hidden="true" />
          {props.archivedLoading ? "Loading archived…" : "Show archived"}
        </button>
      )}
      {props.onHideArchived && props.archivedVisible && (
        <button
          type="button"
          className="session-list-archived-toggle"
          aria-label="Hide archived"
          onClick={() => props.onHideArchived?.()}
        >
          <ArchiveIcon aria-hidden="true" />
          Hide archived
        </button>
      )}
      {props.archivedError && <p className="session-list-error" role="alert">{props.archivedError}</p>}
      {legacySidebarSessionGroups(visibleSessions).map(({ cwd, sessions: cwdSessions }) => (
        <SidebarGroup className="cwd-group" key={cwd}>
          <SidebarGroupLabel className="cwd-heading" title={displayPath(cwd)}>
            <h3>{displayPath(cwd)}</h3>
            <button
              type="button"
              className="cwd-create"
              aria-label={`Create terminal in ${displayPath(cwd)}`}
              title={`Create terminal in ${displayPath(cwd)}`}
              onClick={(event) => {
                event.stopPropagation();
                props.onCreate(canonicalPath(cwd));
                if (isMobile) setOpenMobile(false);
              }}
            >
              <PlusIcon aria-hidden="true" />
            </button>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="cwd-terminal-list">
              {cwdSessions.map((session) => (
                <SessionListItem
                  key={session.id}
                  session={session}
                  selected={selectedIDSet.has(session.id)}
                  pinned={pinnedIDSet.has(session.id)}
                  selectSession={selectSession}
                  onSelectArchivedSession={props.onSelectArchivedSession}
                  onArchive={props.onArchive}
                  onDelete={props.onDelete}
                  onRename={props.onRename}
                  {...props.sessionInfoHandlers}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
      {normalizedFilter && visibleSessions.length === 0 && (
        <p className="session-list-empty">No sessions match your filter.</p>
      )}
    </nav>
  );
}

function SessionNavigationContent({
  settings,
  sidebarWidth,
  setSidebarWidth,
  resizing,
  setResizing,
  ...props
}: SessionNavigationProps & {
  settings: Settings;
  sidebarWidth: number;
  setSidebarWidth(width: number): void;
  resizing: boolean;
  setResizing(resizing: boolean): void;
}) {
  const { isMobile, setOpenMobile, state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  const projectSidebarEnabled = props.projects !== undefined;
  const selected = projectSidebarEnabled
    ? props.sessions.find((session) =>
        (props.selectedID ?? props.selectedIDs[0]) === session.id,
      )
    : props.sessions.find((session) => props.selectedIDs.includes(session.id));
  const mobileTitle = props.focusedPaneID === "agents"
      ? "Inbox"
      : selected
        ? sessionLabel(selected)
        : "Euphony";
  const [terminalTree, setTerminalTree] = useState<HTMLDivElement | null>(null);
  const [hasTerminalTreeOverflowBelow, setHasTerminalTreeOverflowBelow] =
    useState(false);

  const updateTerminalTreeOverflow = useCallback(() => {
    if (!terminalTree) return;
    const hasOverflowBelow =
      terminalTree.scrollTop + terminalTree.clientHeight <
      terminalTree.scrollHeight - 1;
    setHasTerminalTreeOverflowBelow((current) =>
      current === hasOverflowBelow ? current : hasOverflowBelow
    );
  }, [terminalTree]);

  useLayoutEffect(() => {
    if (!terminalTree) {
      setHasTerminalTreeOverflowBelow(false);
      return;
    }
    updateTerminalTreeOverflow();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateTerminalTreeOverflow);
    observer.observe(terminalTree);
    if (terminalTree.firstElementChild) {
      observer.observe(terminalTree.firstElementChild);
    }
    return () => observer.disconnect();
  }, [
    collapsed,
    props.sessions,
    sidebarWidth,
    terminalTree,
    updateTerminalTreeOverflow,
  ]);

  const [sessionInfoHover, setSessionInfoHover] = useState<{
    sessionID: string;
    x: number;
    y: number;
  } | null>(null);
  const [sessionInfoCardPosition, setSessionInfoCardPosition] = useState({
    left: sessionInfoViewportPadding,
    top: sessionInfoViewportPadding,
  });
  const sessionInfoTimerRef = useRef<number | null>(null);
  const sessionInfoPendingIDRef = useRef<string | null>(null);
  const sessionInfoCardRef = useRef<HTMLElement | null>(null);
  const sessionsRef = useRef(props.sessions);
  useLayoutEffect(() => {
    sessionsRef.current = props.sessions;
  }, [props.sessions]);
  const sessionSummaries = latestSessionSummaries(props.agentSummaries ?? []);

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
    session: Session,
    anchor: { x: number; y: number },
  ) => {
    clearSessionInfoTimer();
    sessionInfoPendingIDRef.current = session.id;
    setSessionInfoHover(null);
    sessionInfoTimerRef.current = window.setTimeout(() => {
      sessionInfoTimerRef.current = null;
      if (sessionInfoPendingIDRef.current !== session.id) return;
      if (!sessionsRef.current.some((current) => current.id === session.id)) {
        sessionInfoPendingIDRef.current = null;
        return;
      }
      setSessionInfoHover({ sessionID: session.id, ...anchor });
    }, sessionInfoHoverDelayMs);
  }, [clearSessionInfoTimer]);

  const onSessionPointerEnter = useCallback((
    session: Session,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    scheduleSessionInfo(session, { x: event.clientX, y: event.clientY });
  }, [scheduleSessionInfo]);

  const onSessionFocus = useCallback((
    session: Session,
    event: ReactFocusEvent<HTMLElement>,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    scheduleSessionInfo(session, { x: rect.right, y: rect.top });
  }, [scheduleSessionInfo]);

  const sessionInfoHandlers: SessionInfoInteractionHandlers = {
    onSessionPointerEnter,
    onSessionPointerLeave: cancelSessionInfo,
    onSessionFocus,
    onSessionBlur: cancelSessionInfo,
  };
  const hoveredSession = sessionInfoHover
    ? props.sessions.find((session) => session.id === sessionInfoHover.sessionID)
    : undefined;
  const hoveredSummary = hoveredSession
    ? sessionSummaries.get(hoveredSession.id)
    : undefined;

  useLayoutEffect(() => {
    if (!sessionInfoHover || !hoveredSession) return;
    const rect = sessionInfoCardRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 0;
    const height = rect?.height ?? 0;
    const maxLeft = Math.max(
      sessionInfoViewportPadding,
      window.innerWidth - width - sessionInfoViewportPadding,
    );
    const maxTop = Math.max(
      sessionInfoViewportPadding,
      window.innerHeight - height - sessionInfoViewportPadding,
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
  }, [hoveredSession, hoveredSummary, sessionInfoHover]);

  useEffect(() => {
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isTerminalTarget(event.target)) {
        cancelSessionInfo();
      }
    };
    window.addEventListener("keydown", cancelOnEscape, true);
    return () => window.removeEventListener("keydown", cancelOnEscape, true);
  }, [cancelSessionInfo]);

  useEffect(() => cancelSessionInfo, [cancelSessionInfo]);

  useEffect(() => {
    if (isMobile) return;
    const toggleWithCommandB = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "b" ||
        !event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      event.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", toggleWithCommandB, { capture: true });
    return () =>
      window.removeEventListener("keydown", toggleWithCommandB, { capture: true });
  }, [isMobile, toggleSidebar]);

  useEffect(() => {
    if (!resizing) return;
    const resize = (event: PointerEvent) => {
      setSidebarWidth(normalizeSidebarWidth(event.clientX));
    };
    const finish = (event: PointerEvent) => {
      const width = normalizeSidebarWidth(event.clientX);
      setSidebarWidth(width);
      props.onSettingsChange?.({ ...settings, sidebarWidth: width });
      setResizing(false);
    };
    document.addEventListener("pointermove", resize);
    document.addEventListener("pointerup", finish);
    return () => {
      document.removeEventListener("pointermove", resize);
      document.removeEventListener("pointerup", finish);
    };
  }, [
    props.onSettingsChange,
    resizing,
    setResizing,
    setSidebarWidth,
    settings,
  ]);

  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    let next = sidebarWidth;
    if (event.key === "ArrowLeft") next -= 16;
    else if (event.key === "ArrowRight") next += 16;
    else if (event.key === "Home") next = minimumSidebarWidth;
    else if (event.key === "End") next = maximumSidebarWidth;
    else return;
    event.preventDefault();
    next = normalizeSidebarWidth(next);
    setSidebarWidth(next);
    props.onSettingsChange?.({ ...settings, sidebarWidth: next });
  };

  const openSettings = () => {
    if (isMobile) setOpenMobile(false);
    props.onOpenSettings?.();
  };

  const openAllSessions = () => {
    if (isMobile) setOpenMobile(false);
    props.onOpenAllSessions?.();
  };

  const openAgents = (event: React.MouseEvent<HTMLButtonElement>) => {
    const multiple = event.metaKey || event.ctrlKey;
    if (isMobile && !multiple) setOpenMobile(false);
    props.onOpenAgents?.(multiple);
  };

  const selectProjectSession = (sessionID: string) => {
    if (props.onSelectSession) props.onSelectSession(sessionID);
    else props.onSelect(sessionID, false);
    if (isMobile) setOpenMobile(false);
  };

  const selectArchivedSession = (session: Session) => {
    props.onSelectArchivedSession?.(session);
    if (isMobile) setOpenMobile(false);
  };

  return (
    <>
      <Sidebar
        className="desktop-sidebar"
        data-pane-name="agent-list"
        data-resizing={resizing}
        mobileTitle="Terminal menu"
        mobileDescription="Browse and select terminal sessions."
      >
        <SidebarHeader>
          {!collapsed && (
            <SidebarTrigger
              aria-label="Collapse sidebar"
              aria-expanded="true"
              aria-keyshortcuts="Meta+B"
              title="Collapse sidebar (⌘B)"
            />
          )}
        </SidebarHeader>
        <SidebarContent
          ref={setTerminalTree}
          className="terminal-tree-scroll"
          data-overflow-bottom={hasTerminalTreeOverflowBelow || undefined}
          onScroll={updateTerminalTreeOverflow}
        >
          <SidebarMenu className="sidebar-primary-navigation">
            {!projectSidebarEnabled && (
              <SidebarMenuItem className="workspace-channel">
                <Checkbox
                  className="pane-checkbox workspace-pane-checkbox"
                  aria-label="Include Inbox in split"
                  checked={props.agentsOpen ?? false}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onOpenAgents?.(true);
                  }}
                />
                <SidebarMenuButton
                  className="workspace-select"
                  type="button"
                  tooltip="Inbox"
                  isActive={props.agentsOpen && props.focusedPaneID === "agents"}
                  aria-current={
                    props.agentsOpen && props.focusedPaneID === "agents" ? "page" : undefined
                  }
                  aria-label="Inbox"
                  onClick={openAgents}
                >
                  <BotIcon aria-hidden="true" />
                  <span>Inbox</span>
                  {(props.agentSummaryCount ?? 0) > 0 && (
                    <span className="sidebar-attention-count" aria-hidden="true">
                      {props.agentSummaryCount}
                    </span>
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
          {projectSidebarEnabled ? (
            <ProjectSidebar
              projects={props.projects ?? []}
              sessions={props.sessions}
              agentSummaries={props.agentSummaries ?? []}
              selectedID={props.selectedID ?? props.selectedIDs[0] ?? null}
              onSelectSession={selectProjectSession}
              onSelectArchivedSession={selectArchivedSession}
              onCreateTerminal={props.onCreateTerminal
                ? (projectID) => {
                  props.onCreateTerminal?.(projectID);
                  if (isMobile) setOpenMobile(false);
                }
                : undefined}
              onCreateAgent={props.onCreateAgent
                ? (projectID) => {
                  props.onCreateAgent?.(projectID);
                  if (isMobile) setOpenMobile(false);
                }
                : undefined}
              onAddProject={props.onAddProject
                ? () => {
                  props.onAddProject?.();
                  if (isMobile) setOpenMobile(false);
                }
                : undefined}
              archivedVisible={props.archivedVisible}
              archivedLoading={props.archivedLoading}
              archivedError={props.archivedError}
              onShowArchived={props.onShowArchived}
              onHideArchived={props.onHideArchived}
              onRename={props.onRename
                ? (session) => {
                  props.onRename?.(session);
                  if (isMobile) setOpenMobile(false);
                }
                : undefined}
              onReorderSessions={props.onReorderSessions}
              onReorderProjects={props.onReorderProjects}
              onDelete={(session) => {
                props.onDelete(session);
                if (isMobile) setOpenMobile(false);
              }}
              onArchive={(session) => {
                props.onArchive?.(session);
                if (isMobile) setOpenMobile(false);
              }}
              {...sessionInfoHandlers}
            />
          ) : (
            <SessionList
              {...props}
              settings={settings}
              sessionInfoHandlers={sessionInfoHandlers}
            />
          )}
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            {!projectSidebarEnabled && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="New terminal"
                  onClick={() => props.onCreate()}
                >
                  <PlusIcon aria-hidden="true" />
                  <span>New terminal</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="All sessions"
                aria-label="All sessions"
                onClick={openAllSessions}
              >
                <ListIcon aria-hidden="true" />
                <span>All sessions</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Settings"
                aria-label="Open settings"
                onClick={openSettings}
              >
                <Settings2Icon aria-hidden="true" />
                <span>Settings</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        {!collapsed && (
          <SidebarRail
            className="sidebar-resizer"
            role="separator"
            aria-label="Resize sidebar"
            aria-orientation="vertical"
            aria-valuemin={minimumSidebarWidth}
            aria-valuemax={maximumSidebarWidth}
            aria-valuenow={sidebarWidth}
            tabIndex={0}
            onClick={(event) => event.preventDefault()}
            onKeyDown={resizeWithKeyboard}
            onPointerDown={(event) => {
              event.preventDefault();
              setResizing(true);
            }}
          />
        )}
      </Sidebar>

      {hoveredSession && (
        <SessionInfoCard
          ref={sessionInfoCardRef}
          session={hoveredSession}
          summary={hoveredSummary}
          style={{
            position: "fixed",
            left: `${sessionInfoCardPosition.left}px`,
            top: `${sessionInfoCardPosition.top}px`,
          }}
        />
      )}

      {!isMobile && collapsed && (
        <SidebarTrigger
          className="sidebar-expand"
          aria-label="Expand sidebar"
          aria-expanded="false"
          aria-keyshortcuts="Meta+B"
          title="Expand sidebar (⌘B)"
        />
      )}

      <header className="mobile-header">
        <SidebarTrigger
          className="menu-button"
          aria-label="Open terminal menu"
        />
        <span>{mobileTitle}</span>
      </header>
    </>
  );
}

export function SessionNavigation(props: SessionNavigationProps) {
  const settings = props.settings ?? {
    prefix: "Ctrl+B",
    paneTabShortcut: "Meta+L",
    sidebarWidth: defaultSidebarWidth,
    sidebarCollapsed: false,
    interfaceFontSize: 16,
    terminalFontSize: 14,
    terminalFontFamily: defaultTerminalFontFamily,
    agentLogFontSize: 14,
    terminalHistoryLimit: 1024 * 1024,
    terminalLineHeight: defaultTerminalLineHeight,
    terminalCursorStyle: defaultTerminalCursorStyle,
    terminalCursorBlink: defaultTerminalCursorBlink,
    terminalScrollSensitivity: defaultTerminalScrollSensitivity,
    terminalOptionAsAlt: defaultTerminalOptionAsAlt,
    codingAgent: "codex",
    agentSummaryProvider: "codex",
    agentSummaryOpenAIEffort: "low",
    agentSummaryPrompt: "",
  };
  const [sidebarWidth, setSidebarWidth] = useState(settings.sidebarWidth);
  const [collapsed, setCollapsed] = useState(settings.sidebarCollapsed);
  const [resizing, setResizing] = useState(false);

  useEffect(() => setSidebarWidth(settings.sidebarWidth), [settings.sidebarWidth]);
  useEffect(() => setCollapsed(settings.sidebarCollapsed), [settings.sidebarCollapsed]);

  const setOpen = (open: boolean) => {
    const nextCollapsed = !open;
    setCollapsed(nextCollapsed);
    props.onSettingsChange?.({
      ...settings,
      sidebarCollapsed: nextCollapsed,
    });
  };

  return (
    <SidebarProvider
      className="sidebar-provider"
      open={!collapsed}
      onOpenChange={setOpen}
      keyboardShortcut={null}
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
        } as CSSProperties
      }
    >
      <SessionNavigationContent
        {...props}
        settings={settings}
        sidebarWidth={sidebarWidth}
        setSidebarWidth={setSidebarWidth}
        resizing={resizing}
        setResizing={setResizing}
      />
    </SidebarProvider>
  );
}
