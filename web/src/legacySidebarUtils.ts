import type { Session } from "./types";

export function legacySessionActivity(session: Session) {
  if (session.archived) return "archived";
  if (session.agentStatus) return session.agentStatus;
  return session.state === "running" ? "terminal" : session.state;
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
    sessions: groupedSessions,
  }));
}

export function flattenLegacySidebarSessions(sessions: Session[]) {
  return legacySidebarSessionGroups(sessions).flatMap(({ sessions: group }) => group);
}
