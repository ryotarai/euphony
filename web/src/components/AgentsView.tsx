import { useMemo } from "react";
import type { AgentSummary, Session } from "../types";

interface AgentsViewProps {
  summaries: AgentSummary[];
  sessions: Session[];
  loading?: boolean;
  error?: string;
  onSelectSession(id: string): void;
}

interface AgentSummaryItem {
  summary: AgentSummary;
  session: Session;
}

function statusLabel(status: AgentSummary["status"]) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function providerLabel(provider: AgentSummary["provider"]) {
  return provider === "claude" ? "Claude · Haiku" : "Codex · GPT-5.6-luna";
}

function sessionLabel(session: Session) {
  return session.agentTitle?.trim() || session.processName?.trim() || session.name;
}

function generatedLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Updated recently";
  return `Updated ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function SummaryCard({ item, onSelectSession }: {
  item: AgentSummaryItem;
  onSelectSession(id: string): void;
}) {
  const { summary, session } = item;
  const label = sessionLabel(session);
  return (
    <button
      type="button"
      className="agent-summary-card"
      data-status={summary.status}
      onClick={() => onSelectSession(session.id)}
      aria-label={`${label}: ${summary.summary}`}
    >
      <span className="agent-summary-card-header">
        <span className="agent-summary-status">{statusLabel(summary.status)}</span>
        <span className="agent-summary-provider">{providerLabel(summary.provider)}</span>
        <span className="agent-summary-updated">{generatedLabel(summary.generatedAt)}</span>
      </span>
      <span className="agent-summary-title">{label}</span>
      <span className="agent-summary-copy">{summary.summary || "Summary unavailable."}</span>
      {summary.action && (
        <span className="agent-summary-action">
          <span className="agent-summary-action-label">Next action</span>
          <span>{summary.action}</span>
        </span>
      )}
      {summary.error && (
        <span className="agent-summary-error">Summary unavailable · {summary.error}</span>
      )}
    </button>
  );
}

function SummarySection({
  id,
  title,
  empty,
  items,
  onSelectSession,
}: {
  id: string;
  title: string;
  empty: string;
  items: AgentSummaryItem[];
  onSelectSession(id: string): void;
}) {
  return (
    <section className="agents-section" aria-labelledby={id}>
      <div className="agents-section-heading">
        <h2 id={id}>{title}</h2>
        <span>{items.length}</span>
      </div>
      {items.length > 0 ? (
        <div className="agent-summary-list">
          {items.map((item) => (
            <SummaryCard
              key={item.summary.terminalId}
              item={item}
              onSelectSession={onSelectSession}
            />
          ))}
        </div>
      ) : (
        <p className="agents-empty">{empty}</p>
      )}
    </section>
  );
}

export function AgentsView({
  summaries,
  sessions,
  loading = false,
  error = "",
  onSelectSession,
}: AgentsViewProps) {
  const items = useMemo(() => {
    const sessionsByID = new Map(sessions.map((session) => [session.id, session]));
    return summaries
      .map((summary) => {
        const session = sessionsByID.get(summary.terminalId);
        return session ? { summary, session } : null;
      })
      .filter((item): item is AgentSummaryItem => item !== null);
  }, [sessions, summaries]);
  const actionItems = items.filter(
    ({ summary }) => summary.status === "blocked" || summary.status === "waiting",
  );
  const runningItems = items.filter(({ summary }) => summary.status === "running");

  return (
    <main className="agents-view" aria-labelledby="agents-view-title">
      <header className="agents-view-header">
        <div>
          <p className="agents-view-eyebrow">Workspace / Agents</p>
          <h1 id="agents-view-title">Agents</h1>
          <p>Read the latest signal from every identified agent.</p>
        </div>
        <div className="agents-view-count" aria-label={`${actionItems.length} agents need attention`}>
          <strong>{actionItems.length}</strong>
          <span>need attention</span>
        </div>
      </header>
      {loading && (
        <p className="agents-loading" role="status" aria-label="Loading agent summaries">
          Reading agent signals…
        </p>
      )}
      {error && <p className="agents-error" role="alert">{error}</p>}
      <div className="agents-sections">
        <SummarySection
          id="agents-action-required"
          title="Action required"
          empty="No agents need attention."
          items={actionItems}
          onSelectSession={onSelectSession}
        />
        <SummarySection
          id="agents-running"
          title="Running"
          empty="No agents are running."
          items={runningItems}
          onSelectSession={onSelectSession}
        />
      </div>
    </main>
  );
}
