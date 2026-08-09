import { useMemo, useRef, useState } from "react";
import { CheckIcon, RefreshCwIcon } from "lucide-react";
import type { AgentSummary, AgentSummaryPriority, Session } from "../types";

interface AgentsViewProps {
  summaries: AgentSummary[];
  sessions: Session[];
  loading?: boolean;
  error?: string;
  refreshing?: boolean;
  onSelectSession(id: string): void;
  onRefresh?(): Promise<void> | void;
  onMarkDone?(id: string): Promise<boolean> | boolean | void;
  onChooseOption?(id: string, optionID: string): Promise<unknown> | unknown;
}

interface AgentSummaryItem {
  summary: AgentSummary;
  session: Session;
}

const agentTabs = ["action", "done"] as const;
type AgentTab = (typeof agentTabs)[number];

const priorityRank: Record<AgentSummaryPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function statusLabel(status: AgentSummary["status"]) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function providerLabel(provider: AgentSummary["provider"]) {
  switch (provider) {
    case "openai":
      return "OpenAI · GPT-5.6-luna";
    case "claude":
      return "Claude · Haiku";
    case "codex":
    default:
      return "Codex · GPT-5.6-luna";
  }
}

function sessionLabel(session: Session) {
  if (session.customName) return session.name;
  return session.agentTitle?.trim() || session.processName?.trim() || session.name;
}

function generatedLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Updated recently";
  return `Updated ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function summaryPriority(summary: AgentSummary): AgentSummaryPriority {
  return summary.priority ?? "medium";
}

function priorityLabel(priority: AgentSummaryPriority) {
  return priority.charAt(0).toUpperCase() + priority.slice(1);
}

function optionID(option: { id?: string }, index: number) {
  return option.id?.trim() || `option-${index + 1}`;
}

function optionErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The Inbox action could not be completed.";
}

function sortByPriority(items: AgentSummaryItem[]) {
  return [...items].sort((left, right) => {
    const priorityDifference = priorityRank[summaryPriority(left.summary)] -
      priorityRank[summaryPriority(right.summary)];
    if (priorityDifference !== 0) return priorityDifference;
    const generatedDifference = Date.parse(right.summary.generatedAt) -
      Date.parse(left.summary.generatedAt);
    if (!Number.isNaN(generatedDifference) && generatedDifference !== 0) {
      return generatedDifference;
    }
    return left.summary.terminalId.localeCompare(right.summary.terminalId);
  });
}

function SummaryCard({
  item,
  displayDone,
  onSelectSession,
  onMarkDone,
  onChooseOption,
  onDone,
}: {
  item: AgentSummaryItem;
  displayDone: boolean;
  onSelectSession(id: string): void;
  onMarkDone?: (id: string) => Promise<boolean> | boolean | void;
  onChooseOption?: (id: string, optionID: string) => Promise<unknown> | unknown;
  onDone(id?: string): void;
}) {
  const { summary, session } = item;
  const label = sessionLabel(session);
  const unread = displayDone ? false : summary.unread;
  const priority = summaryPriority(summary);
  const options = summary.options?.slice(0, 4) ?? [];
  const [pendingOptionID, setPendingOptionID] = useState<string | null>(null);
  const [choiceError, setChoiceError] = useState("");

  const markDone = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!onMarkDone) return;
    const result = await onMarkDone(session.id);
    if (result !== false) onDone();
  };

  const chooseOption = async (
    event: React.MouseEvent<HTMLButtonElement>,
    id: string,
  ) => {
    event.stopPropagation();
    if (!onChooseOption || pendingOptionID) return;
    setChoiceError("");
    setPendingOptionID(id);
    try {
      await onChooseOption(session.id, id);
      onDone(session.id);
    } catch (error) {
      setChoiceError(optionErrorMessage(error));
    } finally {
      setPendingOptionID(null);
    }
  };

  return (
    <article
      className="agent-summary-card agent-inbox-row"
      data-status={summary.status}
      data-unread={unread}
      data-done={displayDone}
      data-testid={`agent-summary-card-${summary.terminalId}`}
    >
      <button
        type="button"
        className="agent-summary-open"
        onClick={() => onSelectSession(session.id)}
        aria-label={`Open ${label}`}
      >
        <span className="agent-summary-card-header">
          <span className="agent-summary-status">{statusLabel(summary.status)}</span>
          <span className="agent-summary-provider">{providerLabel(summary.provider)}</span>
          <span className="agent-summary-updated">{generatedLabel(summary.generatedAt)}</span>
        </span>
        <span className="agent-summary-title" data-unread={unread}>{label}</span>
        <span className="agent-summary-copy" data-unread={unread}>
          {summary.summary || "Summary unavailable."}
        </span>
        {summary.action && (
          <span className="agent-summary-action" data-unread={unread}>
            <span className="agent-summary-action-label">Next action</span>
            <span className="agent-summary-action-value">{summary.action}</span>
            <span
              className="agent-summary-priority"
              data-priority={priority}
              data-testid="agent-summary-priority"
              aria-label={`${priorityLabel(priority)} priority`}
            >
              {priorityLabel(priority)}
            </span>
          </span>
        )}
        {summary.error && (
          <span className="agent-summary-error" role="alert">
            Summary unavailable · {summary.error}
          </span>
        )}
      </button>
      {!displayDone && summary.action && options.length > 0 && (
        <div className="agent-summary-options" aria-label="Suggested responses">
          <span className="agent-summary-options-label">Choose a response</span>
          <div className="agent-summary-option-list">
            {options.map((option, index) => {
              const id = optionID(option, index);
              return (
                <button
                  key={id}
                  type="button"
                  className="agent-summary-option"
                  data-testid={`agent-summary-option-${id}`}
                  disabled={!onChooseOption || pendingOptionID !== null}
                  aria-busy={pendingOptionID === id}
                  onClick={(event) => void chooseOption(event, id)}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          {choiceError && (
            <span className="agent-summary-error" role="alert">{choiceError}</span>
          )}
        </div>
      )}
      {!displayDone && summary.action && options.length === 0 && (
        <button
          type="button"
          className="agent-summary-legacy-action"
          onClick={() => onSelectSession(session.id)}
        >
          Open terminal
        </button>
      )}
      {!displayDone && summary.action && options.length === 0 && onMarkDone && (
        <button
          type="button"
          className="agent-summary-done"
          aria-label={`Mark ${label} as done`}
          onClick={(event) => void markDone(event)}
        >
          <CheckIcon aria-hidden="true" />
        </button>
      )}
    </article>
  );
}

function SummarySection({
  id,
  title,
  legacyTitle,
  empty,
  items,
  optimisticDoneIDs,
  onSelectSession,
  onMarkDone,
  onChooseOption,
  onDone,
}: {
  id: string;
  title: string;
  legacyTitle?: string;
  empty: string;
  items: AgentSummaryItem[];
  optimisticDoneIDs: Set<string>;
  onSelectSession(id: string): void;
  onMarkDone?: (id: string) => Promise<boolean> | boolean | void;
  onChooseOption?: (id: string, optionID: string) => Promise<unknown> | unknown;
  onDone(id?: string): void;
}) {
  return (
    <section
      className="agents-section"
      aria-labelledby={legacyTitle ? `${id}-legacy` : id}
    >
      <div className="agents-section-heading">
        <h2 id={id}>{title}</h2>
        {legacyTitle && (
          <h3 id={`${id}-legacy`} className="agents-legacy-heading">{legacyTitle}</h3>
        )}
        <span>{items.length}</span>
      </div>
      {items.length > 0 ? (
        <div className="agent-summary-list">
          {items.map((item) => (
            <SummaryCard
              key={item.summary.terminalId}
              item={item}
              displayDone={item.summary.done === true || optimisticDoneIDs.has(item.summary.terminalId)}
              onSelectSession={onSelectSession}
              onMarkDone={onMarkDone}
              onChooseOption={onChooseOption}
              onDone={onDone}
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
  refreshing = false,
  onSelectSession,
  onMarkDone,
  onChooseOption,
  onRefresh,
}: AgentsViewProps) {
  const [selectedTab, setSelectedTab] = useState<AgentTab>("action");
  const [refreshPending, setRefreshPending] = useState(false);
  const [optimisticDoneIDs, setOptimisticDoneIDs] = useState<Set<string>>(
    () => new Set(),
  );
  const tabRefs = useRef<Record<AgentTab, HTMLButtonElement | null>>({
    action: null,
    done: null,
  });
  const items = useMemo(() => {
    const sessionsByID = new Map(sessions.map((session) => [session.id, session]));
    return summaries
      .map((summary) => {
        const session = sessionsByID.get(summary.terminalId);
        return session ? { summary, session } : null;
      })
      .filter((item): item is AgentSummaryItem => item !== null);
  }, [sessions, summaries]);

  const visibleOptimisticDoneIDs = useMemo(() => {
    const completedIDs = new Set<string>();
    for (const summary of summaries) {
      if (summary.done === true) completedIDs.add(summary.terminalId);
    }
    const visibleIDs = new Set<string>();
    for (const id of optimisticDoneIDs) {
      if (!completedIDs.has(id)) visibleIDs.add(id);
    }
    return visibleIDs;
  }, [optimisticDoneIDs, summaries]);

  const actionItems = items.filter(({ summary }) => (
    summary.done !== true && !visibleOptimisticDoneIDs.has(summary.terminalId)
  ));
  const actionRequiredItems = sortByPriority(actionItems.filter(
    ({ summary }) => summary.status === "blocked" || summary.status === "waiting",
  ));
  const runningItems = sortByPriority(actionItems.filter(
    ({ summary }) => summary.status === "running",
  ));
  const doneItems = sortByPriority(items.filter(({ summary }) => (
    summary.done === true || visibleOptimisticDoneIDs.has(summary.terminalId)
  )));
  const emptyCopy = selectedTab === "action"
    ? { action: "No actions require attention.", running: "No agents are running." }
    : { action: "No completed actions yet.", running: "" };
  const tabPanelID = "agents-tabpanel";
  const isRefreshing = refreshing || refreshPending;
  const handleRefresh = async () => {
    if (!onRefresh || isRefreshing) return;
    setRefreshPending(true);
    try {
      await onRefresh();
    } finally {
      setRefreshPending(false);
    }
  };
  const completeItem = (id?: string) => {
    if (id) setOptimisticDoneIDs((current) => new Set(current).add(id));
    setSelectedTab("done");
  };

  return (
    <main className="agents-view" aria-labelledby="agents-view-title">
      <header className="agents-view-header">
        <div>
          <p className="agents-view-eyebrow">Workspace / Inbox</p>
          <h1 id="agents-view-title">Inbox</h1>
          <p>Review agent messages and choose a response.</p>
        </div>
        <div className="agents-view-header-actions">
          <div
            className="agents-view-count"
            aria-label={`${actionRequiredItems.length} need your attention`}
          >
            <strong>{actionRequiredItems.length}</strong>
            <span>need your attention</span>
          </div>
          <button
            type="button"
            className="agents-refresh-button"
            aria-label="Refresh all agent summaries"
            aria-busy={isRefreshing}
            data-refreshing={isRefreshing}
            disabled={!onRefresh || isRefreshing}
            onClick={() => void handleRefresh()}
          >
            <RefreshCwIcon aria-hidden="true" />
            <span>{isRefreshing ? "Refreshing…" : "Refresh"}</span>
          </button>
        </div>
      </header>
      {loading && (
        <p className="agents-loading" role="status" aria-label="Loading agent summaries">
          Reading agent signals…
        </p>
      )}
      {error && <p className="agents-error" role="alert">{error}</p>}
      <div className="agents-tabs" role="tablist" aria-label="Inbox views">
        {agentTabs.map((tab) => {
          const count = tab === "action" ? actionItems.length : doneItems.length;
          const label = tab === "action" ? "Inbox" : "Done";
          const tabID = `agents-${tab}-tab`;
          return (
            <button
              key={tab}
              id={tabID}
              type="button"
              role="tab"
              className="agents-tab"
              data-tab={tab}
              aria-label={tab === "action" ? `Inbox · Action required ${count}` : `${label} ${count}`}
              aria-controls={tabPanelID}
              aria-selected={tab === selectedTab}
              tabIndex={tab === selectedTab ? 0 : -1}
              ref={(element) => {
                tabRefs.current[tab] = element;
              }}
              onClick={() => setSelectedTab(tab)}
              onKeyDown={(event) => {
                const currentIndex = agentTabs.indexOf(tab);
                let nextIndex: number;
                switch (event.key) {
                  case "ArrowRight":
                  case "ArrowDown":
                    nextIndex = (currentIndex + 1) % agentTabs.length;
                    break;
                  case "ArrowLeft":
                  case "ArrowUp":
                    nextIndex = (currentIndex - 1 + agentTabs.length) % agentTabs.length;
                    break;
                  case "Home":
                    nextIndex = 0;
                    break;
                  case "End":
                    nextIndex = agentTabs.length - 1;
                    break;
                  default:
                    return;
                }
                event.preventDefault();
                const nextTab = agentTabs[nextIndex];
                setSelectedTab(nextTab);
                tabRefs.current[nextTab]?.focus();
              }}
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
        {selectedTab === "action" ? (
          <div className="agents-sections">
            <SummarySection
              id="agents-action-required"
              title="Needs your action"
              legacyTitle="Action required"
              empty={emptyCopy.action}
              items={actionRequiredItems}
              optimisticDoneIDs={visibleOptimisticDoneIDs}
              onSelectSession={onSelectSession}
              onMarkDone={onMarkDone}
              onChooseOption={onChooseOption}
              onDone={completeItem}
            />
            <SummarySection
              id="agents-running"
              title="Agent updates"
              legacyTitle="Running"
              empty={emptyCopy.running}
              items={runningItems}
              optimisticDoneIDs={visibleOptimisticDoneIDs}
              onSelectSession={onSelectSession}
              onMarkDone={onMarkDone}
              onChooseOption={onChooseOption}
              onDone={completeItem}
            />
          </div>
        ) : (
          <div className="agents-sections">
            <SummarySection
              id="agents-done"
              title="Done"
              empty={emptyCopy.action}
              items={doneItems}
              optimisticDoneIDs={visibleOptimisticDoneIDs}
              onSelectSession={onSelectSession}
              onDone={() => undefined}
            />
          </div>
        )}
      </div>
    </main>
  );
}
