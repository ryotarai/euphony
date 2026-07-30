import { type CSSProperties, useEffect, useState } from "react";
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

const defaultSidebarWidth = 256;
const minimumSidebarWidth = 180;
const maximumSidebarWidth = 600;

function normalizeSidebarWidth(width: number): number {
  return Math.round(Math.min(maximumSidebarWidth, Math.max(minimumSidebarWidth, width)));
}

interface SessionNavigationProps {
  sessions: Session[];
  selectedIDs: string[];
  statusFilters: string[];
  onSelect(id: string, multiple: boolean): void;
  onStatusFilter(status: string, checked: boolean): void;
  onStatusSelect?(status: string): void;
  cwdFilters?: string[];
  onCwdFilter?(status: string, cwd: string, checked: boolean): void;
  onCwdSelect?(status: string, cwd: string): void;
  onCreate(): void;
  onDelete(session: Session): void;
  settings?: Settings;
  onSettingsChange?(settings: Settings): void;
  onOpenSettings?(): void;
}

function activity(session: Session) {
  if (session.needsAttention) return "attention";
  if (session.agentStatus) return session.agentStatus;
  return session.state === "running" ? "terminal" : session.state;
}

function statusLabel(status: string) {
  if (status === "attention") return "Need attention";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

const activityOrder = new Map([
  ["attention", 0],
  ["running", 1],
  ["waiting", 2],
  ["terminal", 3],
]);

function orderedActivities(sessions: Session[]) {
  return [...new Set(sessions.map(activity))].sort(
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

  const selectSession = (id: string, multiple: boolean) => {
    props.onSelect(id, multiple);
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
                onCheckedChange={(checked) =>
                  props.onStatusFilter(status, checked === true)
                }
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
              {cwds.map((cwd) => {
                const cwdSessions = statusSessions.filter(
                  (session) => session.cwd === cwd,
                );
                const filterKey = cwdFilterKey(status, cwd);
                return (
                  <SidebarGroup className="cwd-group" key={cwd}>
                    <SidebarGroupLabel className="cwd-heading" title={cwd}>
                      <Checkbox
                        aria-label={`Include all terminals in ${displayPath(cwd)}`}
                        checked={
                          statusSelected ||
                          (props.cwdFilters?.includes(filterKey) ?? false)
                        }
                        onCheckedChange={(checked) =>
                          props.onCwdFilter?.(status, cwd, checked === true)
                        }
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
                                onCheckedChange={() => selectSession(session.id, true)}
                              />
                              <SidebarMenuButton
                                className="session-select"
                                size="lg"
                                isActive={selected}
                                aria-label={`Select ${session.name}`}
                                aria-pressed={selected}
                                aria-current={selected ? "true" : undefined}
                                title={session.cwd}
                                onClick={(event) =>
                                  selectSession(
                                    session.id,
                                    event.metaKey || event.ctrlKey,
                                  )
                                }
                              >
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
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const selected = props.sessions.find((session) => props.selectedIDs.includes(session.id));

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

  return (
    <>
      <Sidebar
        className="desktop-sidebar"
        data-resizing={resizing}
        mobileTitle="Terminal menu"
        mobileDescription="Browse and select terminal sessions."
      >
        <SidebarHeader>
          <SidebarTrigger
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
          />
        </SidebarHeader>
        <SidebarContent>
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
                onClick={props.onOpenSettings}
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
    agentLogFontSize: 14,
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
      className="contents"
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
