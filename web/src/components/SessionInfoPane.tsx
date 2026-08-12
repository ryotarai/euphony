import {
  CircleCheckIcon,
  CircleDotIcon,
  CirclePauseIcon,
  CircleXIcon,
  Clock3Icon,
  SquareTerminalIcon,
} from "lucide-react";
import type { AgentSummary, Session } from "../types";

interface SessionInfoPaneProps {
  session?: Session;
  summary?: AgentSummary;
}

function statusIcon(session: Session) {
  const status = session.agentStatus || (session.state === "running" ? "terminal" : session.state);
  const props = {
    className: `session-info-status session-info-status-${status}`,
    role: "img" as const,
    "aria-label": status,
  };
  switch (status) {
    case "running":
      return <CircleDotIcon {...props} />;
    case "waiting":
      return <CirclePauseIcon {...props} />;
    case "starting":
      return <Clock3Icon {...props} />;
    case "exited":
      return <CircleCheckIcon {...props} />;
    case "failed":
      return <CircleXIcon {...props} />;
    default:
      return <SquareTerminalIcon {...props} />;
  }
}

function purposeFor(session: Session, summary?: AgentSummary) {
  const generated = summary?.purpose?.trim();
  if (generated) return generated;
  return session.agentTitle?.trim() || session.processName?.trim() || "No purpose yet.";
}

export function SessionInfoPane({ session, summary }: SessionInfoPaneProps) {
  if (!session) {
    return (
      <aside className="session-info-pane" role="region" aria-label="Session information">
        <div className="session-info-empty">
          <span className="session-info-kicker">Session information</span>
          <p>Select a session to inspect its purpose, summary, and action.</p>
        </div>
      </aside>
    );
  }

  const purpose = purposeFor(session, summary);
  const latestSummary = summary?.summary?.trim() || "No summary yet.";
  const action = summary?.action?.trim() || "No action required.";

  return (
    <aside
      className="session-info-pane"
      role="region"
      aria-label="Session information"
      data-session-id={session.id}
    >
      <header className="session-info-header">
        <span className="session-info-kicker">Session information</span>
        <div className="session-info-identity">
          {statusIcon(session)}
          <h2>{purpose}</h2>
        </div>
        <p className="session-info-cwd" title={session.cwd}>{session.cwd}</p>
      </header>
      <dl className="session-info-fields">
        <div>
          <dt>Summary</dt>
          <dd>{latestSummary}</dd>
        </div>
        <div>
          <dt>Action</dt>
          <dd className={summary?.action ? "session-info-action" : undefined}>{action}</dd>
        </div>
      </dl>
    </aside>
  );
}
