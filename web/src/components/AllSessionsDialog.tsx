import { useEffect, useMemo, useRef, useState } from "react";
import {
  Clock3Icon,
  FolderIcon,
  LoaderCircleIcon,
  SearchIcon,
  TerminalIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AllSession } from "../types";

export interface AllSessionsDialogProps {
  open: boolean;
  sessions: AllSession[];
  loading?: boolean;
  error?: string;
  resumingID?: string | null;
  onOpenChange(open: boolean): void;
  onSelect(session: AllSession): void | Promise<void>;
}

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function compareSessions(left: AllSession, right: AllSession): number {
  const leftTime = Date.parse(left.updatedAt);
  const rightTime = Date.parse(right.updatedAt);
  const timeDifference = (Number.isFinite(rightTime) ? rightTime : 0)
    - (Number.isFinite(leftTime) ? leftTime : 0);
  return timeDifference === 0 ? left.id.localeCompare(right.id) : timeDifference;
}

function sessionSearchText(session: AllSession): string {
  return normalizeSearch([
    session.title,
    session.purpose,
    session.summary,
    session.cwd,
    session.project,
    session.agent,
    session.sessionId,
    session.terminalId,
  ].filter(Boolean).join(" "));
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
  const elapsedDays = Math.round(elapsedHours / 24);
  return `${elapsedDays}d ago`;
}

function displayAgent(session: AllSession): string {
  return session.agent ? session.agent[0].toUpperCase() + session.agent.slice(1) : "Terminal";
}

function displayPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}

function pathLocation(path: string): string {
  const normalizedPath = path.replace(/\/+$/, "");
  const displayed = displayPath(normalizedPath);
  return displayed.split("/").filter(Boolean).at(-1) || displayed || "unknown";
}

function sessionLocation(session: AllSession): string {
  return pathLocation(session.project || session.cwd);
}

function sessionShortID(session: AllSession): string {
  const id = (session.sessionId || session.terminalId || session.id).trim();
  if (!id) return "#unknown";
  if (id.length <= 16) return `#${id}`;
  return `#${id.slice(0, 8)}…${id.slice(-8)}`;
}

function hasGenericTitle(title: string): boolean {
  return new Set(["terminal", "shell", "zsh", "new session", "codex session", "claude session"])
    .has(title.trim().toLowerCase());
}

function displayTitle(session: AllSession): string {
  const title = session.title.trim();
  return title && (session.customName || !hasGenericTitle(title))
    ? title
    : `${displayAgent(session)} · ${sessionLocation(session)}`;
}

function sessionActionLabel(session: AllSession): string {
  if (session.archived) {
    return session.state === "open" ? "Restore terminal" : "Restore and resume";
  }
  return session.state === "open" ? "Open terminal" : "Resume session";
}

export function AllSessionsDialog({
  open,
  sessions,
  loading = false,
  error = "",
  resumingID = null,
  onOpenChange,
  onSelect,
}: AllSessionsDialogProps) {
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = normalizeSearch(query);
  const orderedSessions = useMemo(
    () => [...sessions].sort(compareSessions),
    [sessions],
  );
  const searchableSessions = useMemo(
    () => orderedSessions.map((session) => ({
      session,
      searchText: sessionSearchText(session),
    })),
    [orderedSessions],
  );
  const visibleSessions = useMemo(
    () => normalizedQuery === ""
      ? orderedSessions
      : searchableSessions.reduce<AllSession[]>((visible, item) => {
        if (item.searchText.includes(normalizedQuery)) visible.push(item.session);
        return visible;
      }, []),
    [normalizedQuery, orderedSessions, searchableSessions],
  );

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const resultCount = normalizedQuery
    ? `${visibleSessions.length} of ${sessions.length}`
    : `${sessions.length}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="all-sessions-dialog">
        <DialogHeader className="all-sessions-header">
          <div className="all-sessions-heading-row">
            <div>
              <p className="all-sessions-eyebrow">Session index</p>
              <DialogTitle>All sessions</DialogTitle>
            </div>
            <span className="all-sessions-count" aria-live="polite">
              {resultCount} {sessions.length === 1 ? "session" : "sessions"}
            </span>
          </div>
          <DialogDescription className="all-sessions-description">
            Search managed terminals and saved agent sessions by what you remember.
          </DialogDescription>
        </DialogHeader>

        <label className="all-sessions-search" htmlFor="all-sessions-search">
          <SearchIcon aria-hidden="true" />
          <span className="sr-only">Search all sessions</span>
          <Input
            ref={searchInputRef}
            id="all-sessions-search"
            type="search"
            role="searchbox"
            aria-label="Search all sessions"
            placeholder="Search title, purpose, project, or directory"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
        </label>

        <div className="all-sessions-content">
          {loading && (
            <div className="all-sessions-status" role="status">
              <LoaderCircleIcon aria-hidden="true" className="all-sessions-spinner" />
              <span>Loading sessions…</span>
            </div>
          )}

          {!loading && error && (
            <div className="all-sessions-status all-sessions-error" role="alert">
              <span>{error}</span>
            </div>
          )}

          {!loading && !error && visibleSessions.length > 0 && (
            <ul className="all-sessions-list" aria-label="All sessions">
              {visibleSessions.map((session) => {
                const resuming = resumingID === session.id;
                const busy = resumingID !== null;
                const title = displayTitle(session);
                const location = sessionLocation(session);
                const shortID = sessionShortID(session);
                const locationPath = session.project || session.cwd;
                return (
                  <li key={session.id}>
                    <Button
                      type="button"
                      variant="ghost"
                      className="all-session-row"
                      data-all-session-row="true"
                      data-state={session.state}
                      disabled={busy}
                      aria-busy={resuming || undefined}
                      aria-label={`${title} · ${location} ${shortID} — ${resuming ? "Resuming session" : sessionActionLabel(session)}`}
                      onClick={() => void onSelect(session)}
                    >
                      <span className="all-session-activity-rail" aria-hidden="true" />
                      <span className="all-session-main">
                        <span className="all-session-topline">
                          <span className="all-session-agent">
                            {session.agent === "codex" || session.agent === "claude" ? (
                              <TerminalIcon aria-hidden="true" />
                            ) : (
                              <FolderIcon aria-hidden="true" />
                            )}
                            {displayAgent(session)}
                          </span>
                          <span className="all-session-action">
                            {resuming ? (
                              <>
                                <LoaderCircleIcon aria-hidden="true" className="all-sessions-spinner" />
                                Resuming…
                              </>
                            ) : sessionActionLabel(session)}
                          </span>
                        </span>
                        <span className="all-session-title">{title}</span>
                        {session.purpose && (
                          <span className="all-session-purpose">{session.purpose}</span>
                        )}
                        {session.summary && (
                          <span className="all-session-summary">{session.summary}</span>
                        )}
                        <span className="all-session-metadata">
                          <span className="all-session-location" title={locationPath}>{location}</span>
                          {session.project && session.project !== session.cwd && (
                            <span title={session.cwd}>{pathLocation(session.cwd)}</span>
                          )}
                          <span className="all-session-session-id" title={session.sessionId || session.id}>
                            {shortID}
                          </span>
                          <span className="all-session-updated">
                            <Clock3Icon aria-hidden="true" />
                            <time dateTime={session.updatedAt} title={session.updatedAt}>
                              {formatUpdatedAt(session.updatedAt)}
                            </time>
                          </span>
                        </span>
                      </span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}

          {!loading && !error && visibleSessions.length === 0 && (
            <Empty className="all-sessions-empty">
              <EmptyHeader>
                <EmptyTitle>
                  {sessions.length === 0 ? "No sessions found" : "No sessions match your search"}
                </EmptyTitle>
                <EmptyDescription>
                  {sessions.length === 0
                    ? "Start a terminal or save an agent session to see it here."
                    : "Try a different title, project, purpose, or directory."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
