import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { PlusIcon, Settings2Icon, Trash2Icon } from "lucide-react";
import claudeIcon from "../assets/claude.svg";
import openAIIcon from "../assets/openai.svg";
import { Badge } from "@/components/ui/badge";
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
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import type { Session, Settings } from "../types";
import {
  defaultTerminalCursorBlink,
  defaultTerminalCursorStyle,
  defaultTerminalFontFamily,
  defaultTerminalLineHeight,
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
  pinnedIDs?: string[];
  statusFilters: string[];
  pinnedStatusFilters?: string[];
  onSelect(id: string, multiple: boolean, pin?: boolean): void;
  onStatusFilter(status: string, checked: boolean, pin?: boolean): void;
  onStatusSelect?(status: string): void;
  cwdFilters?: string[];
  pinnedCwdFilters?: string[];
  onCwdFilter?(status: string, cwd: string, checked: boolean, pin?: boolean): void;
  onCwdSelect?(status: string, cwd: string): void;
  onCreate(): void;
  onDelete(session: Session): void;
  settings?: Settings;
  onSettingsChange?(settings: Settings): void;
  onOpenSettings?(): void;
}

function activity(session: Session) {
  if (session.agentStatus) return session.agentStatus;
  return session.state === "running" ? "terminal" : session.state;
}

function statusLabel(status: string) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

const builtInActivities = [
  "blocked",
  "running",
  "waiting",
  "terminal",
];

const activityOrder = new Map(
  builtInActivities.map((status, index) => [status, index]),
);

function orderedActivities(sessions: Session[]) {
  return [...new Set([...builtInActivities, ...sessions.map(activity)])].sort(
    (left, right) =>
      (activityOrder.get(left) ?? 100) - (activityOrder.get(right) ?? 100) ||
      left.localeCompare(right),
  );
}

function displayPath(path: string) {
  return path
    .replace(/^\/Users\/[^/]+(?=\/|$)/, "~")
    .replace(/^\/home\/[^/]+(?=\/|$)/, "~");
}

export function cwdFilterKey(status: string, cwd: string) {
  return `${status}\u0000${cwd}`;
}

function agentIcon(session: Session) {
  if (session.agent === "codex") return { source: openAIIcon, label: "Codex" };
  if (session.agent === "claude") return { source: claudeIcon, label: "Claude" };
  return null;
}

function SessionList(props: SessionNavigationProps) {
  const { isMobile, setOpenMobile } = useSidebar();

  const selectSession = (id: string, multiple: boolean, pin?: boolean) => {
    if (pin === undefined) props.onSelect(id, multiple);
    else props.onSelect(id, multiple, pin);
    if (isMobile && !multiple) setOpenMobile(false);
  };

  return (
    <nav className="session-list" aria-label="Terminal sessions">
      {orderedActivities(props.sessions).map((status) => {
        const statusSessions = props.sessions.filter(
          (session) => activity(session) === status,
        );
        const cwds = [...new Set(statusSessions.map((session) => session.cwd))];
        const statusSelected = props.statusFilters.includes(status);
        const statusPinned = props.pinnedStatusFilters?.includes(status) ?? false;
        const statusHasSelectedCwd = props.cwdFilters?.some((filter) =>
          filter.startsWith(`${status}\u0000`)
        ) ?? false;
        return (
          <SidebarGroup className="session-group" key={status}>
            <SidebarGroupLabel className="status-heading">
              <Checkbox
                aria-label={`Show all ${statusLabel(status)} terminals`}
                checked={statusSelected}
                indeterminate={!statusSelected && statusHasSelectedCwd}
                data-pinned={statusPinned || undefined}
                title={
                  statusPinned
                    ? "Pinned — click to remove"
                    : "Option-click to pin"
                }
                onClick={(event) => {
                  if (event.altKey) {
                    props.onStatusFilter(status, true, true);
                  } else {
                    props.onStatusFilter(status, !statusSelected);
                  }
                }}
              />
              <button
                className="status-select"
                aria-label={`Show only ${statusLabel(status)} terminals`}
                onClick={() => props.onStatusSelect?.(status)}
              >
                <h2>{statusLabel(status)}</h2>
                <Badge variant="secondary">{statusSessions.length}</Badge>
              </button>
            </SidebarGroupLabel>
            <SidebarGroupContent>
              {statusSessions.length === 0 && (
                <p className="status-empty">No terminal</p>
              )}
              {cwds.map((cwd) => {
                const cwdSessions = statusSessions.filter(
                  (session) => session.cwd === cwd,
                );
                const filterKey = cwdFilterKey(status, cwd);
                const cwdSelected =
                  statusSelected ||
                  (props.cwdFilters?.includes(filterKey) ?? false);
                const cwdPinned =
                  statusPinned ||
                  (props.pinnedCwdFilters?.includes(filterKey) ?? false);
                return (
                  <SidebarGroup className="cwd-group" key={cwd}>
                    <SidebarGroupLabel className="cwd-heading" title={cwd}>
                      <Checkbox
                        aria-label={`Include all terminals in ${displayPath(cwd)}`}
                        checked={cwdSelected}
                        data-pinned={cwdPinned || undefined}
                        title={
                          cwdPinned
                            ? "Pinned — click to remove"
                            : "Option-click to pin"
                        }
                        onClick={(event) => {
                          if (event.altKey) {
                            props.onCwdFilter?.(status, cwd, true, true);
                          } else {
                            props.onCwdFilter?.(status, cwd, !cwdSelected);
                          }
                        }}
                      />
                      <button
                        className="cwd-select"
                        aria-label={`Show only ${statusLabel(status)} terminals in ${displayPath(cwd)}`}
                        onClick={() => props.onCwdSelect?.(status, cwd)}
                      >
                        <h3>{displayPath(cwd)}</h3>
                      </button>
                    </SidebarGroupLabel>
                    <SidebarGroupContent>
                      <SidebarMenu className="cwd-terminal-list">
                        {cwdSessions.map((session) => {
                          const icon = agentIcon(session);
                          const selected = props.selectedIDs.includes(session.id);
                          const pinned = props.pinnedIDs?.includes(session.id) ?? false;
                          const attentionDescriptionID = session.needsAttention
                            ? `attention-${session.id}`
                            : undefined;
                          return (
                            <SidebarMenuItem
                              className="session-channel"
                              key={session.id}
                              data-state={activity(session)}
                            >
                              <Checkbox
                                className="pane-checkbox"
                                aria-label={`Include ${session.name} in split`}
                                checked={selected}
                                data-pinned={pinned || undefined}
                                title={
                                  pinned
                                    ? "Pinned — click to remove"
                                    : "Option-click to pin"
                                }
                                onClick={(event) =>
                                  selectSession(session.id, true, event.altKey)
                                }
                              />
                              <SidebarMenuButton
                                className="session-select"
                                size="lg"
                                isActive={selected}
                                aria-label={`Select ${session.name}`}
                                aria-pressed={selected}
                                aria-current={selected ? "true" : undefined}
                                aria-describedby={attentionDescriptionID}
                                title={session.cwd}
                                onClick={(event) =>
                                  selectSession(
                                    session.id,
                                    event.metaKey || event.ctrlKey,
                                  )
                                }
                              >
                                {session.needsAttention && (
                                  <>
                                    <span
                                      className="attention-dot"
                                      aria-hidden="true"
                                    />
                                    <span
                                      className="sr-only"
                                      id={attentionDescriptionID}
                                    >
                                      Needs attention
                                    </span>
                                  </>
                                )}
                                {icon && (
                                  <img
                                    className="session-agent-icon"
                                    src={icon.source}
                                    alt={icon.label}
                                  />
                                )}
                                <span className="terminal-identity">
                                  <span className="agent-title">
                                    {session.agentTitle || session.name}
                                  </span>
                                </span>
                              </SidebarMenuButton>
                              <SidebarMenuAction
                                className="session-delete"
                                showOnHover
                                aria-label={`Delete ${session.name}`}
                                title={`Delete ${session.name}`}
                                onClick={() => props.onDelete(session)}
                              >
                                <Trash2Icon aria-hidden="true" />
                                <span className="sr-only">Delete {session.name}</span>
                              </SidebarMenuAction>
                            </SidebarMenuItem>
                          );
                        })}
                      </SidebarMenu>
                    </SidebarGroupContent>
                  </SidebarGroup>
                );
              })}
            </SidebarGroupContent>
          </SidebarGroup>
        );
      })}
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
  const selected = props.sessions.find((session) => props.selectedIDs.includes(session.id));
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
          <SessionList {...props} settings={settings} />
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="New terminal" onClick={props.onCreate}>
                <PlusIcon aria-hidden="true" />
                <span>New terminal</span>
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
        <span>{selected?.name ?? "Euphony"}</span>
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
    autoSelectAttention: true,
    terminalLineHeight: defaultTerminalLineHeight,
    terminalCursorStyle: defaultTerminalCursorStyle,
    terminalCursorBlink: defaultTerminalCursorBlink,
    terminalScrollSensitivity: defaultTerminalScrollSensitivity,
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
