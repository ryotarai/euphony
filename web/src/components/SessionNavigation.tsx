import { useEffect, useRef, useState } from "react";
import type { Session } from "../types";

interface SessionNavigationProps {
  sessions: Session[];
  selectedIDs: string[];
  statusFilters: string[];
  onSelect(id: string, multiple: boolean): void;
  onStatusFilter(status: string, checked: boolean): void;
  onCreate(): void;
  onDelete(session: Session): void;
}

function activity(session: Session) {
  return session.agentStatus || session.state;
}

function statusLabel(status: string) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function SessionList({
  sessions,
  selectedIDs,
  statusFilters,
  onSelect,
  onStatusFilter,
  onCreate,
  onDelete,
}: SessionNavigationProps) {
  const groups = [...new Set(sessions.map(activity))];
  return (
    <>
      <div className="session-list">
        {groups.map((status) => (
          <section className="session-group" key={status}>
            <label className="status-heading">
              <input
                type="checkbox"
                aria-label={`Show all ${statusLabel(status)} terminals`}
                checked={statusFilters.includes(status)}
                onChange={(event) => onStatusFilter(status, event.target.checked)}
              />
              <h2>{statusLabel(status)}</h2>
              <span>{sessions.filter((session) => activity(session) === status).length}</span>
            </label>
            {sessions.filter((session) => activity(session) === status).map((session) => (
              <div className="session-channel" key={session.id} data-state={activity(session)}>
                <span className="channel-signal" aria-hidden="true" />
                <button
                  className="session-select"
                  aria-label={`Select ${session.name}`}
                  aria-pressed={selectedIDs.includes(session.id)}
                  aria-current={selectedIDs.includes(session.id) ? "true" : undefined}
                  title={session.cwd}
                  onClick={(event) => onSelect(session.id, event.metaKey || event.ctrlKey)}
                >
                  <span className="terminal-identity">
                    <span className="session-full-name">
                      {session.agent ? session.agent : session.name}
                    </span>
                    <span className="session-cwd">{session.cwd}</span>
                  </span>
                  {session.agentTitle && <span className="agent-title">{session.agentTitle}</span>}
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
            ))}
          </section>
        ))}
      </div>
      <button className="create-channel" onClick={onCreate}>
        <span aria-hidden="true">＋</span>
        <span className="create-label">New terminal</span>
      </button>
    </>
  );
}

export function SessionNavigation(props: SessionNavigationProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const selected = props.sessions.find((session) => props.selectedIDs.includes(session.id));

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

  const mobileSelect = (id: string) => {
    props.onSelect(id, false);
    setDrawerOpen(false);
    queueMicrotask(() => menuButtonRef.current?.focus());
  };

  return (
    <>
      <aside className="session-rail" aria-label="Terminal sessions">
        <div className="wordmark" aria-label="Euphony">
          EU
        </div>
        <SessionList {...props} />
      </aside>

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
            <SessionList {...props} onSelect={(id) => mobileSelect(id)} />
          </div>
        </div>
      )}
    </>
  );
}
