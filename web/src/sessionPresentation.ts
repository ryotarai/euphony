import type { AgentSummary, Session } from "./types";

const humanInterventionPattern = /\b(?:approve|allow|deny|grant|choose|select|decide|decision|confirm|provide|enter|input|pick|reply|respond|authorize|permission|consent)\b|承認|許可|選択|判断|決定|入力|回答|同意/iu;
const completionPattern = /(?:complete|completed|finish|finished|done|succeed|succeeded|完了|終了|完了済み|成功)/iu;
const reviewOnlyPattern = /\b(?:review|check|confirm)\b|確認|チェック|見て/iu;

function hasSuggestedOption(summary: AgentSummary) {
  return (summary.options ?? []).some((option) => option.label.trim() !== "");
}

/**
 * A generated action is useful in the sidebar only when the agent is stopped
 * for an explicit human decision or input. Completion notices belong in the
 * summary, not in every session row.
 */
export function isHumanActionRequired(summary?: AgentSummary): boolean {
  if (!summary || summary.done || (summary.status !== "waiting" && summary.status !== "blocked")) {
    return false;
  }
  const action = summary.action?.trim();
  if (!action) return false;
  if (completionPattern.test(action) && reviewOnlyPattern.test(action) && !/\b(?:approve|allow|deny|choose|select|decide|decision|provide|enter|input|authorize|permission)\b|承認|許可|選択|判断|決定|入力|回答|同意/iu.test(action)) {
    return false;
  }
  return hasSuggestedOption(summary) || humanInterventionPattern.test(action);
}

export function normalizeSessionFilter(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

export function sessionMatchesFilter(
  session: Session,
  summary: AgentSummary | undefined,
  filter: string,
  additionalSearchText = "",
): boolean {
  const query = normalizeSessionFilter(filter);
  if (!query) return true;
  const searchableGroups = [
    [
      session.name,
      session.agent,
      session.agentTitle,
      session.processName,
      session.agentStatus,
      summary?.provider,
      summary?.purpose,
      summary?.summary,
      summary?.action,
      additionalSearchText,
    ],
    [session.cwd, session.repoRoot],
  ].map((group) => normalizeSessionFilter(group.filter(Boolean).join(" ")));
  const terms = query.split(" ");
  return searchableGroups.some((group) => terms.every((term) => group.includes(term)));
}

export function filterSessions(
  sessions: Session[],
  summaries: ReadonlyMap<string, AgentSummary>,
  filter: string,
  additionalSearchText?: (session: Session, summary: AgentSummary | undefined) => string,
): Session[] {
  return sessions.filter((session) => {
    const summary = summaries.get(session.id);
    return sessionMatchesFilter(
      session,
      summary,
      filter,
      additionalSearchText?.(session, summary),
    );
  });
}
