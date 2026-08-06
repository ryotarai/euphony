import { useMemo, useState } from "react";
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
      data-unread={summary.unread}
      onClick={() => onSelectSession(session.id)}
      aria-label={`${label}: ${summary.summary}`}
    >
      <span className="agent-summary-card-header">
        {summary.unread && <span className="agent-summary-unread-marker" aria-hidden="true" />}
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
  const [selectedTab, setSelectedTab] = useState<"unread" | "read">("unread");
  const items = useMemo(() => {
    const sessionsByID = new Map(sessions.map((session) => [session.id, session]));
    return summaries
      .map((summary) => {
        const session = sessionsByID.get(summary.terminalId);
        return session ? { summary, session } : null;
      })
      .filter((item): item is AgentSummaryItem => item !== null);
  }, [sessions, summaries]);
  const unreadItems = items.filter(({ summary }) => summary.unread);
  const readItems = items.filter(({ summary }) => !summary.unread);
  const visibleItems = selectedTab === "unread" ? unreadItems : readItems;
  const actionItems = visibleItems.filter(
    ({ summary }) => summary.status === "blocked" || summary.status === "waiting",
  );
  const runningItems = visibleItems.filter(({ summary }) => summary.status === "running");
  const emptyCopy = selectedTab === "unread"
    ? {
      action: "No unread agents need attention.",
      running: "No unread agents are running.",
    }
    : {
      action: "No read agents need attention.",
      running: "No read agents are running.",
    };
  const tabPanelID = "agents-tabpanel";

  return (
    <main className="agents-view" aria-labelledby="agents-view-title">
      <header className="agents-view-header">
        <div>
          <p className="agents-view-eyebrow">Workspace / Agents</p>
          <h1 id="agents-view-title">Agents</h1>
          <p>Read the latest signal from every identified agent.</p>
        </div>
        <div className="agents-view-count" aria-label={`${unreadItems.length} unread agents`}>
          <strong>{unreadItems.length}</strong>
          <span>unread</span>
        </div>
      </header>
      {loading && (
        <p className="agents-loading" role="status" aria-label="Loading agent summaries">
          Reading agent signals…
        </p>
      )}
      {error && <p className="agents-error" role="alert">{error}</p>}
      <div className="agents-tabs" role="tablist" aria-label="Agent summaries">
        {(["unread", "read"] as const).map((tab) => {
          const count = tab === "unread" ? unreadItems.length : readItems.length;
          const label = tab === "unread" ? "Unread" : "Read";
          const tabID = `agents-${tab}-tab`;
          return (
            <button
              key={tab}
              id={tabID}
              type="button"
              role="tab"
              className="agents-tab"
              data-tab={tab}
              aria-label={`${label} ${count}`}
              aria-controls={tabPanelID}
              aria-selected={tab === selectedTab}
              tabIndex={tab === selectedTab ? 0 : -1}
              onClick={() => setSelectedTab(tab)}
            >
              <span>{label}</span>
              <span className="agents-tab-count">{count}</span>
            </button>
          );
        })}
      </div>
      <div
        id={tabPanelID}
        className="agents-tab-panel"
        role="tabpanel"
        aria-labelledby={`agents-${selectedTab}-tab`}
      >
        <div className="agents-sections">
          <SummarySection
            id="agents-action-required"
            title="Action required"
            empty={emptyCopy.action}
            items={actionItems}
            onSelectSession={onSelectSession}
          />
          <SummarySection
            id="agents-running"
            title="Running"
            empty={emptyCopy.running}
            items={runningItems}
            onSelectSession={onSelectSession}
          />
        </div>
      </div>
    </main>
  );
}
