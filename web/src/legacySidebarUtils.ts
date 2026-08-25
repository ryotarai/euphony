import type { Session } from "./types";

const terminalRowPriority = new Map([
  ["blocked", 1],
  ["running", 2],
  ["waiting", 3],
  ["terminal", 4],
]);

export function legacySessionActivity(session: Session) {
  if (session.agentStatus) return session.agentStatus;
  return session.state === "running" ? "terminal" : session.state;
}

function terminalPriority(session: Session) {
  if (session.needsAttention) return 0;
  return terminalRowPriority.get(legacySessionActivity(session)) ?? 100;
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

function sidebarCwd(session: Session) {
  return session.repoRoot?.trim() || session.cwd;
}

export function legacySidebarSessionGroups(sessions: Session[]) {
  const groups = new Map<string, Session[]>();
  for (const session of sessions) {
    const cwd = sidebarCwd(session);
    const group = groups.get(cwd);
    if (group) group.push(session);
    else groups.set(cwd, [session]);
  }
  return [...groups].map(([cwd, groupedSessions]) => ({
    cwd,
    sessions: [...groupedSessions].sort(compareTerminalRows),
  }));
}

export function flattenLegacySidebarSessions(sessions: Session[]) {
  return legacySidebarSessionGroups(sessions).flatMap(({ sessions: group }) => group);
}
