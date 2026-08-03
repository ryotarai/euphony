import type { Session } from "./types";

export function cwdFilterKey(status: string, cwd: string) {
  return `${status}\u0000${cwd}`;
}

export function attentionTransitions(previous: Session[], next: Session[]): Session[] {
  const previousAttention = new Map(
    previous.map((session) => [session.id, Boolean(session.needsAttention)]),
  );
  return next.filter(
    (session) => session.needsAttention && !previousAttention.get(session.id),
  );
}

export function agentLaunchTransitions(
  previous: Session[],
  next: Session[],
): Session[] {
  const previousActivity = new Map(
    previous.map((session) => [session.id, sessionActivity(session)]),
  );
  return next.filter(
    (session) =>
      Boolean(session.agent) &&
      previousActivity.get(session.id) === "terminal" &&
      sessionActivity(session) !== "terminal",
  );
}

export function agentRunningTransitions(
  previous: Session[],
  next: Session[],
): Session[] {
  const previousStatuses = new Map(
    previous.map((session) => [session.id, session.agentStatus]),
  );
  return next.filter(
    (session) =>
      Boolean(session.agent) &&
      session.agentStatus === "running" &&
      previousStatuses.get(session.id) !== "running",
  );
}

export function sessionsEqual(left: Session[], right: Session[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((session, index) => {
    const next = right[index];
    if (!next) return false;
    const keys = Object.keys(session) as Array<keyof Session>;
    const nextKeys = Object.keys(next) as Array<keyof Session>;
    return (
      keys.length === nextKeys.length &&
      keys.every((key) => session[key] === next[key])
    );
  });
}

export function replacementSession(
  previous: Session[],
  removedID: string,
  remaining: Session[],
): Session | undefined {
  const previousIndex = previous.findIndex((session) => session.id === removedID);
  if (previousIndex < 0) return remaining[0];
  return remaining[previousIndex] ?? remaining[previousIndex - 1] ?? remaining[0];
}

function sessionActivity(session: Session) {
  if (session.agentStatus) return session.agentStatus;
  return session.state === "running" ? "terminal" : session.state;
}
