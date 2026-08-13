import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import {
  BotIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleHelpIcon,
  CirclePauseIcon,
  CircleXIcon,
  Clock3Icon,
  ListIcon,
  ListTodoIcon,
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
import { ProjectSidebar } from "./ProjectSidebar";
import { useSessionContextMenu } from "./SessionContextMenu";
import type { AgentSummary, Project, Session, Settings } from "../types";
import {
  defaultTerminalCursorBlink,
  defaultTerminalCursorStyle,
  defaultTerminalFontFamily,
  defaultTerminalLineHeight,
  defaultTerminalOptionAsAlt,
  defaultTerminalScrollSensitivity,
} from "../settings";

const defaultSidebarWidth = 256;
const minimumSidebarWidth = 180;
const maximumSidebarWidth = 600;

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
  onCreate(cwd?: string): void;
  onCreateTerminal?(projectID: string): void;
  onCreateAgent?(projectID: string): void;
  onAddProject?(): void;
  onDelete(session: Session): void;
  settings?: Settings;
  onSettingsChange?(settings: Settings): void;
  onOpenSettings?(): void;
  onOpenAllSessions?(): void;
  tasksOpen?: boolean;
  focusedPaneID?: string | null;
  taskCount?: number;
  onOpenTasks?(multiple?: boolean): void;
  agentsOpen?: boolean;
  agentSummaryCount?: number;
  onOpenAgents?(multiple?: boolean): void;
}

function activity(session: Session) {
  if (session.agentStatus) return session.agentStatus;
  return session.state === "running" ? "terminal" : session.state;
}

const terminalRowPriority = new Map([
  ["blocked", 1],
  ["running", 2],
  ["waiting", 3],
  ["terminal", 4],
]);

function terminalPriority(session: Session) {
  if (session.needsAttention) return 0;
  return terminalRowPriority.get(activity(session)) ?? 100;
}

function terminalUpdatedAt(session: Session) {
  const timestamp = Date.parse(session.updatedAt ?? session.createdAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareTerminalRows(left: Session, right: Session) {
  const priority = terminalPriority(left) - terminalPriority(right);
  if (priority !== 0) return priority;
  return terminalUpdatedAt(right) - terminalUpdatedAt(left);
}

function statusLabel(status: string) {
  return status.charAt(0).toUpperCase() + status.slice(1);
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

function sidebarCwd(session: Session) {
  return session.repoRoot?.trim() || session.cwd;
}

function groupSessionsByCwd(sessions: Session[]) {
  const groups = new Map<string, Session[]>();
  for (const session of sessions) {
    const cwd = sidebarCwd(session);
    const group = groups.get(cwd);
    if (group) group.push(session);
    else groups.set(cwd, [session]);
  }
  return [...groups].map(([cwd, groupedSessions]) => ({
    cwd,
    sessions: [...groupedSessions].sort(
      compareTerminalRows,
    ),
  }));
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
    case "running":
      return <CircleDotIcon {...props} />;
    case "blocked":
      return (
        <span {...props}>
          🚫
        </span>
      );
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
  onDelete,
}: {
  session: Session;
  selected: boolean;
  pinned: boolean;
  selectSession(id: string, multiple: boolean, pin?: boolean): void;
  onDelete(session: Session): void;
}) {
  const { onContextMenu, menu } = useSessionContextMenu(
    session.name,
    () => onDelete(session),
  );
  const attentionDescriptionID = session.needsAttention
    ? `attention-${session.id}`
    : undefined;

  return (
    <SidebarMenuItem
      className="session-channel"
      data-state={activity(session)}
      data-attention={session.needsAttention || undefined}
      onContextMenu={onContextMenu}
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
        onClick={(event) =>
          selectSession(session.id, event.metaKey || event.ctrlKey)
        }
      >
        {sessionStatusIcon(activity(session))}
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

function SessionList(props: SessionNavigationProps) {
  const { isMobile, setOpenMobile } = useSidebar();

  const selectSession = (id: string, multiple: boolean, pin?: boolean) => {
    if (pin === undefined) props.onSelect(id, multiple);
    else props.onSelect(id, multiple, pin);
    if (isMobile && !multiple) setOpenMobile(false);
  };
  const selectedIDSet = new Set(props.selectedIDs);
  const pinnedIDSet = new Set(props.pinnedIDs ?? []);

  return (
    <nav className="session-list" aria-label="Terminal sessions">
      {groupSessionsByCwd(props.sessions).map(({ cwd, sessions: cwdSessions }) => (
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
                  onDelete={props.onDelete}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
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
  const mobileTitle = props.focusedPaneID === "tasks"
    ? "Tasks"
    : props.focusedPaneID === "agents"
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

  const openTasks = (event: React.MouseEvent<HTMLButtonElement>) => {
    const multiple = event.metaKey || event.ctrlKey;
    if (isMobile && !multiple) setOpenMobile(false);
    props.onOpenTasks?.(multiple);
  };

  const selectProjectSession = (sessionID: string) => {
    if (props.onSelectSession) props.onSelectSession(sessionID);
    else props.onSelect(sessionID, false);
    if (isMobile) setOpenMobile(false);
  };

  return (
    <>
      <Sidebar
        className="desktop-sidebar"
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
            <SidebarMenuItem className="workspace-channel">
              {!projectSidebarEnabled && (
                <Checkbox
                  className="pane-checkbox workspace-pane-checkbox"
                  aria-label="Include Tasks in split"
                  checked={props.tasksOpen ?? false}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onOpenTasks?.(true);
                  }}
                />
              )}
              <SidebarMenuButton
                className="workspace-select"
                type="button"
                tooltip="Tasks"
                isActive={props.tasksOpen && props.focusedPaneID === "tasks"}
                aria-current={
                  props.tasksOpen && props.focusedPaneID === "tasks" ? "page" : undefined
                }
                aria-label="Tasks"
                onClick={openTasks}
              >
                <ListTodoIcon aria-hidden="true" />
                <span>Tasks</span>
                {(props.taskCount ?? 0) > 0 && (
                  <span className="sidebar-attention-count" aria-hidden="true">
                    {props.taskCount}
                  </span>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
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
              onDelete={(session) => {
                props.onDelete(session);
                if (isMobile) setOpenMobile(false);
              }}
            />
          ) : (
            <SessionList {...props} settings={settings} />
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
