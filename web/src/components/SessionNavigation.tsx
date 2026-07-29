import { useEffect, useRef, useState } from "react";
import { PlusIcon, Settings2Icon } from "lucide-react";
import claudeIcon from "../assets/claude.svg";
import openAIIcon from "../assets/openai.svg";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

function agentIcon(session: Session) {
  if (session.agent === "codex") return { source: openAIIcon, label: "Codex" };
  if (session.agent === "claude") return { source: claudeIcon, label: "Claude" };
  return null;
}

function SessionList({
  sessions,
  selectedIDs,
  statusFilters,
  onSelect,
  onStatusFilter,
  onStatusSelect,
  onCreate,
  onDelete,
}: SessionNavigationProps) {
  const repositories = sessions.some((session) => session.repoRoot)
    ? [...new Set(sessions.map((session) => session.repoRoot || session.cwd))]
    : [""];
  return (
    <>
      <div className="session-list">
        {repositories.map((repository) => {
          const repositorySessions = repository
            ? sessions.filter((session) => (session.repoRoot || session.cwd) === repository)
            : sessions;
          return (
          <div className="repository-group" key={repository || "all"}>
            {repository && (
              <h2 className="repository-heading" title={repository}>
                {displayPath(repository)}
              </h2>
            )}
        {orderedActivities(repositorySessions).map((status) => (
          <section className="session-group" key={status}>
            <div className="status-heading">
              <Checkbox
                aria-label={`Show all ${statusLabel(status)} terminals`}
                checked={statusFilters.includes(status)}
                onCheckedChange={(checked) => onStatusFilter(status, checked === true)}
              />
              <button
                className="status-select"
                aria-label={`Show only ${statusLabel(status)} terminals`}
                onClick={() => onStatusSelect?.(status)}
              >
                <h2>{statusLabel(status)}</h2>
                <Badge variant="secondary">
                  {repositorySessions.filter((session) => activity(session) === status).length}
                </Badge>
              </button>
            </div>
            {repositorySessions.filter((session) => activity(session) === status).map((session) => {
              const icon = agentIcon(session);
              return (
              <div className="session-channel" key={session.id} data-state={activity(session)}>
                <span className="channel-signal" aria-hidden="true" />
                <Checkbox
                  className="pane-checkbox"
                  aria-label={`Include ${session.name} in split`}
                  checked={selectedIDs.includes(session.id)}
                  onCheckedChange={() => onSelect(session.id, true)}
                />
                <button
                  className="session-select"
                  aria-label={`Select ${session.name}`}
                  aria-pressed={selectedIDs.includes(session.id)}
                  aria-current={selectedIDs.includes(session.id) ? "true" : undefined}
                  title={session.cwd}
                  onClick={(event) => onSelect(session.id, event.metaKey || event.ctrlKey)}
                >
                  <span className="terminal-identity">
                    {session.agentTitle && <span className="agent-title">{session.agentTitle}</span>}
                    <span className="session-cwd">
                      <span>{displayPath(session.cwd)}</span>
                    </span>
                  </span>
                  {icon && (
                    <img
                      className="session-agent-icon"
                      src={icon.source}
                      alt={icon.label}
                    />
                  )}
                </button>
                <button
                  className="session-delete"
                  aria-label={`Delete ${session.name}`}
                  title={`Delete ${session.name}`}
                  onClick={() => onDelete(session)}
                >
                  ×
                </button>
              </div>
              );
            })}
          </section>
        ))}
          </div>
          );
        })}
      </div>
      <Button className="create-channel" variant="outline" onClick={onCreate}>
        <PlusIcon data-icon="inline-start" aria-hidden="true" />
        <span className="create-label">New terminal</span>
      </Button>
    </>
  );
}

export function SessionNavigation(props: SessionNavigationProps) {
  const settings = props.settings ?? {
    prefix: "Ctrl+B",
    sidebarWidth: defaultSidebarWidth,
    sidebarCollapsed: false,
  };
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(settings.sidebarWidth);
  const [collapsed, setCollapsed] = useState(settings.sidebarCollapsed);
  const [resizing, setResizing] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const selected = props.sessions.find((session) => props.selectedIDs.includes(session.id));

  useEffect(() => setSidebarWidth(settings.sidebarWidth), [settings.sidebarWidth]);
  useEffect(() => setCollapsed(settings.sidebarCollapsed), [settings.sidebarCollapsed]);

  useEffect(() => {
    if (!drawerOpen) return;
    const dialog = dialogRef.current;
    const first = dialog?.querySelector<HTMLElement>("button");
    first?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDrawerOpen(false);
        queueMicrotask(() => menuButtonRef.current?.focus());
      }
      if (event.key === "Tab" && dialog) {
        const controls = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled])")];
        const firstControl = controls[0];
        const lastControl = controls.at(-1);
        if (event.shiftKey && document.activeElement === firstControl) {
          event.preventDefault();
          lastControl?.focus();
        } else if (!event.shiftKey && document.activeElement === lastControl) {
          event.preventDefault();
          firstControl?.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [drawerOpen]);

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
  }, [resizing, settings, props.onSettingsChange]);

  const toggleSidebar = () => {
    const next = !collapsed;
    setCollapsed(next);
    props.onSettingsChange?.({ ...settings, sidebarCollapsed: next });
  };

  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let next = sidebarWidth;
    if (event.key === "ArrowLeft") next -= 16;
    else if (event.key === "ArrowRight") next += 16;
    else if (event.key === "Home") next = minimumSidebarWidth;
    else if (event.key === "End") next = maximumSidebarWidth;
    else return;
    event.preventDefault();
    next = Math.min(maximumSidebarWidth, Math.max(minimumSidebarWidth, next));
    setSidebarWidth(next);
    props.onSettingsChange?.({ ...settings, sidebarWidth: next });
  };

  const mobileSelect = (id: string) => {
    props.onSelect(id, false);
    setDrawerOpen(false);
    queueMicrotask(() => menuButtonRef.current?.focus());
  };

  return (
    <>
      <div
        className="desktop-sidebar"
        data-collapsed={collapsed}
        data-resizing={resizing}
        style={{ width: collapsed ? 48 : sidebarWidth }}
      >
        {collapsed ? (
          <button
            className="sidebar-expand"
            aria-label="Expand sidebar"
            aria-expanded="false"
            onClick={toggleSidebar}
          >
            <span aria-hidden="true">›</span>
          </button>
        ) : (
          <>
            <aside className="session-rail" aria-label="Terminal sessions">
              <div className="sidebar-heading">
                <div className="wordmark" aria-label="Euphony">
                  EU
                </div>
                <div className="sidebar-actions">
                  <Button
                    className="sidebar-settings"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Open settings"
                    onClick={props.onOpenSettings}
                  >
                    <Settings2Icon aria-hidden="true" />
                  </Button>
                  <button
                    className="sidebar-collapse"
                    aria-label="Collapse sidebar"
                    aria-expanded="true"
                    onClick={toggleSidebar}
                  >
                    <span aria-hidden="true">‹</span>
                  </button>
                </div>
              </div>
              <SessionList {...props} />
            </aside>
            <div
              className="sidebar-resizer"
              role="separator"
              aria-label="Resize sidebar"
              aria-orientation="vertical"
              aria-valuemin={minimumSidebarWidth}
              aria-valuemax={maximumSidebarWidth}
              aria-valuenow={sidebarWidth}
              tabIndex={0}
              onKeyDown={resizeWithKeyboard}
              onPointerDown={(event) => {
                event.preventDefault();
                setResizing(true);
              }}
            />
          </>
        )}
      </div>

      <header className="mobile-header">
        <button
          ref={menuButtonRef}
          className="menu-button"
          aria-label="Open terminal menu"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <span aria-hidden="true">☰</span>
        </button>
        <span>{selected?.name ?? "Euphony"}</span>
        <span className="mobile-signal" data-connected={selected?.state === "running"} aria-hidden="true" />
      </header>

      {drawerOpen && (
        <div className="drawer-layer" onMouseDown={(event) => event.target === event.currentTarget && setDrawerOpen(false)}>
          <div
            ref={dialogRef}
            className="session-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Terminal menu"
          >
            <div className="drawer-heading">
              <span>Euphony</span>
              <button aria-label="Close terminal menu" onClick={() => setDrawerOpen(false)}>
                ×
              </button>
            </div>
            <SessionList
              {...props}
              onSelect={(id, multiple) => {
                if (multiple) props.onSelect(id, true);
                else mobileSelect(id);
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}
