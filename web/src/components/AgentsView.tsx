import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { CheckIcon, RefreshCwIcon } from "lucide-react";
import type { AgentSummary, AgentSummaryPriority, Session } from "../types";

interface AgentsViewProps {
  summaries: AgentSummary[];
  sessions: Session[];
  selectedSummaryID?: string | null;
  loading?: boolean;
  error?: string;
  refreshing?: boolean;
  onSelectSummary?(id: string, mode?: "push" | "replace"): void;
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

function SummaryRow({
  item,
  displayDone,
  selected,
  onSelect,
}: {
  item: AgentSummaryItem;
  displayDone: boolean;
  selected: boolean;
  onSelect(item: AgentSummaryItem): void;
}) {
  const { summary, session } = item;
  const unread = displayDone ? false : summary.unread;
  const label = sessionLabel(session);
  const priority = summaryPriority(summary);

  return (
    <article
      className="agent-summary-card agent-inbox-row"
      data-status={summary.status}
      data-unread={unread}
      data-done={displayDone}
      data-selected={selected || undefined}
      data-testid={`agent-summary-card-${summary.terminalId}`}
    >
      <button
        type="button"
        className="agent-summary-open"
        aria-label={`Open ${label}`}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(item)}
      >
        <span className="agent-summary-row-indicator" aria-hidden="true" />
        <span className="agent-summary-row-copy">
          <span className="agent-summary-title" data-unread={unread}>{label}</span>
          <span className="agent-summary-copy" data-unread={unread}>
            {summary.summary || "Summary unavailable."}
          </span>
          <span className="agent-summary-action sr-only" data-unread={unread}>
            {summary.action ? "Action available" : "No action requested."}
          </span>
          <span className="agent-summary-row-meta">
            {!selected && <span className="agent-summary-provider">{providerLabel(summary.provider)}</span>}
            {summary.action && (
              <span
                className="agent-summary-priority"
                data-priority={priority}
                data-testid="agent-summary-priority"
                aria-label={`${priorityLabel(priority)} priority`}
              >
                {priorityLabel(priority)}
              </span>
            )}
          </span>
        </span>
        <span className="agent-summary-updated">{generatedLabel(summary.generatedAt)}</span>
      </button>
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
  selectedID,
  onSelect,
}: {
  id: string;
  title: string;
  legacyTitle?: string;
  empty: string;
  items: AgentSummaryItem[];
  optimisticDoneIDs: Set<string>;
  selectedID: string | null;
  onSelect(item: AgentSummaryItem): void;
}) {
  return (
    <section
      className="agents-section"
      aria-labelledby={legacyTitle ? `${id}-legacy` : id}
    >
      <div className="agents-section-heading">
        <div>
          <h2 id={id}>{title}</h2>
          {legacyTitle && (
            <h3 id={`${id}-legacy`} className="agents-legacy-heading">{legacyTitle}</h3>
          )}
        </div>
        <span>{items.length}</span>
      </div>
      {items.length > 0 ? (
        <div className="agent-summary-list">
          {items.map((item) => (
            <SummaryRow
              key={item.summary.terminalId}
              item={item}
              displayDone={item.summary.done === true || optimisticDoneIDs.has(item.summary.terminalId)}
              selected={item.summary.terminalId === selectedID}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : (
        <p className="agents-empty">{empty}</p>
      )}
    </section>
  );
}

function InboxDetail({
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
  onDone(id?: string, generatedAt?: string): void;
}) {
  const { summary, session } = item;
  const [pendingOptionID, setPendingOptionID] = useState<string | null>(null);
  const [choiceError, setChoiceError] = useState("");
  const options = summary.options?.slice(0, 4) ?? [];
  const label = sessionLabel(session);
  const priority = summaryPriority(summary);

  const markDone = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!onMarkDone) return;
    const result = await onMarkDone(session.id);
    if (result !== false) onDone();
  };

  const chooseOption = async (event: MouseEvent<HTMLButtonElement>, id: string) => {
    event.stopPropagation();
    if (!onChooseOption || pendingOptionID) return;
    setChoiceError("");
    setPendingOptionID(id);
    try {
      const applied = await onChooseOption(session.id, id);
      if (applied !== false) onDone(session.id, summary.generatedAt);
    } catch (error) {
      setChoiceError(optionErrorMessage(error));
    } finally {
      setPendingOptionID(null);
    }
  };

  return (
    <section className="agents-detail" aria-label="Selected Inbox item">
      <header className="agents-detail-header">
        <div>
          <p className="agents-detail-eyebrow">Agent update · {label}</p>
          <div className="agents-detail-meta">
            <span className="agent-summary-status">{statusLabel(summary.status)}</span>
            <span className="agent-summary-provider">{providerLabel(summary.provider)}</span>
            <span>{generatedLabel(summary.generatedAt)}</span>
          </div>
        </div>
        <span
          className="agent-summary-priority agents-detail-priority"
          data-priority={priority}
        >
          {priorityLabel(priority)}
        </span>
      </header>
      <div className="agents-detail-body">
        <h2 className="agents-detail-title">Summary · {summary.summary || "Summary unavailable."}</h2>
        {summary.error && (
          <p className="agent-summary-error" role="alert">Summary unavailable · {summary.error}</p>
        )}
        {summary.action && (
          <div className="agents-detail-action" data-unread={!displayDone && summary.unread}>
            <span className="agents-detail-label">Next action</span>
            <p>{summary.action}</p>
          </div>
        )}
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
            {choiceError && <span className="agent-summary-error" role="alert">{choiceError}</span>}
          </div>
        )}
        <div className="agents-detail-actions">
          {summary.action && !displayDone && onMarkDone && (
            <button
              type="button"
              className="agent-summary-done"
              aria-label={`Mark ${label} as done`}
              onClick={(event) => void markDone(event)}
            >
              <CheckIcon aria-hidden="true" />
              <span>Mark done</span>
            </button>
          )}
          <button
            type="button"
            className="agent-summary-legacy-action"
            onClick={() => onSelectSession(session.id)}
          >
            Open terminal
          </button>
        </div>
      </div>
    </section>
  );
}

export function AgentsView({
  summaries,
  sessions,
  selectedSummaryID,
  loading = false,
  error = "",
  refreshing = false,
  onSelectSummary,
  onSelectSession,
  onMarkDone,
  onChooseOption,
  onRefresh,
}: AgentsViewProps) {
  const [requestedTab, setRequestedTab] = useState<AgentTab>("action");
  const [localSelectedID, setLocalSelectedID] = useState<string | null>(null);
  const [refreshPending, setRefreshPending] = useState(false);
  const [optimisticDoneAt, setOptimisticDoneAt] = useState<Map<string, string>>(
    () => new Map(),
  );
  const tabRefs = useRef<Record<AgentTab, HTMLButtonElement | null>>({
    action: null,
    done: null,
  });
  const controlledSelection = selectedSummaryID !== undefined;
  const activeSelectedID = controlledSelection ? selectedSummaryID ?? null : localSelectedID;
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
    const summariesByID = new Map(summaries.map((summary) => [summary.terminalId, summary]));
    const visibleIDs = new Set<string>();
    for (const [id, generatedAt] of optimisticDoneAt) {
      if (!completedIDs.has(id) && summariesByID.get(id)?.generatedAt === generatedAt) {
        visibleIDs.add(id);
      }
    }
    return visibleIDs;
  }, [optimisticDoneAt, summaries]);

  const actionItems = items.filter(({ summary }) => (
    summary.done !== true && !visibleOptimisticDoneIDs.has(summary.terminalId)
  ));
  const actionRequiredItems = sortByPriority(actionItems.filter(
    ({ summary }) => summary.status === "blocked" || summary.status === "waiting",
  ));
  const runningItems = sortByPriority(actionItems.filter(({ summary }) => summary.status === "running"));
  const doneItems = sortByPriority(items.filter(({ summary }) => (
    summary.done === true || visibleOptimisticDoneIDs.has(summary.terminalId)
  )));
  const requestedVisibleItems = requestedTab === "action"
    ? [...actionRequiredItems, ...runningItems]
    : doneItems;
  const requestedSelectedItem = requestedVisibleItems.find(
    (item) => item.summary.terminalId === activeSelectedID,
  ) ??
    (requestedTab === "action"
      ? items.find((item) => item.summary.terminalId === activeSelectedID && item.summary.done === true)
      : null) ??
    requestedVisibleItems[0] ?? null;
  const selectedTab = requestedSelectedItem?.summary.done === true ? "done" : requestedTab;
  const visibleItems = selectedTab === "action"
    ? [...actionRequiredItems, ...runningItems]
    : doneItems;
  const selectedItem = visibleItems.find((item) => item.summary.terminalId === activeSelectedID) ??
    visibleItems[0] ?? null;
  const selectedDisplayDone = selectedItem
    ? selectedItem.summary.done === true || visibleOptimisticDoneIDs.has(selectedItem.summary.terminalId)
    : false;
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

  const selectSummary = (item: AgentSummaryItem, mode: "push" | "replace" = "push") => {
    if (!controlledSelection) setLocalSelectedID(item.summary.terminalId);
    if (onSelectSummary) onSelectSummary(item.summary.terminalId, mode);
    else onSelectSession(item.session.id);
  };

  const completeItem = (id?: string, generatedAt?: string) => {
    if (id && generatedAt) {
      setOptimisticDoneAt((current) => {
        const next = new Map(current);
        next.set(id, generatedAt);
        return next;
      });
    }
    setRequestedTab("done");
  };

  return (
    <main className="agents-view" aria-labelledby="agents-view-title">
      <h1 id="agents-view-title" className="sr-only">Inbox</h1>
      {loading && (
        <p className="agents-loading" role="status" aria-label="Loading agent summaries">
          Reading agent signals…
        </p>
      )}
      {error && <p className="agents-error" role="alert">{error}</p>}
      <div className="agents-toolbar">
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
              onClick={() => setRequestedTab(tab)}
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
                setRequestedTab(nextTab);
                tabRefs.current[nextTab]?.focus();
              }}
            >
              <span>{label}</span>
              <span className="agents-tab-count">{count}</span>
            </button>
          );
          })}
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
      </div>
      <div
        id={tabPanelID}
        className="agents-tab-panel"
        role="tabpanel"
        aria-labelledby={`agents-${selectedTab}-tab`}
      >
        <div className="agents-mailbox">
          <aside className="agents-list" aria-label="Inbox message list">
            <div className="agents-list-heading">
              <span>{selectedTab === "action" ? "Action queue" : "Completed"}</span>
              <span>{visibleItems.length}</span>
            </div>
            {selectedTab === "action" ? (
              <div className="agents-sections">
                <SummarySection
                  id="agents-action-required"
                  title="Needs your action"
                  legacyTitle="Action required"
                  empty={emptyCopy.action}
                  items={actionRequiredItems}
                  optimisticDoneIDs={visibleOptimisticDoneIDs}
                  selectedID={selectedItem?.summary.terminalId ?? null}
                  onSelect={selectSummary}
                />
                <SummarySection
                  id="agents-running"
                  title="Agent updates"
                  legacyTitle="Running"
                  empty={emptyCopy.running}
                  items={runningItems}
                  optimisticDoneIDs={visibleOptimisticDoneIDs}
                  selectedID={selectedItem?.summary.terminalId ?? null}
                  onSelect={selectSummary}
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
                  selectedID={selectedItem?.summary.terminalId ?? null}
                  onSelect={selectSummary}
                />
              </div>
            )}
          </aside>
          {selectedItem ? (
            <InboxDetail
              item={selectedItem}
              displayDone={selectedDisplayDone}
              onSelectSession={onSelectSession}
              onMarkDone={onMarkDone}
              onChooseOption={onChooseOption}
              onDone={completeItem}
            />
          ) : (
            <section className="agents-detail agents-detail-empty" aria-label="Selected Inbox item">
              <p>Select an Inbox item to see its details.</p>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
