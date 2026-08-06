import {
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ApiClient } from "../api";
import type { AgentLogEntry, AgentTranscript, Session } from "../types";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { BotIcon, FileWarningIcon } from "lucide-react";
import { MermaidDiagram } from "./MermaidDiagram";

interface AgentLogViewProps {
  session: Session;
  api: ApiClient;
  active: boolean;
  fontSize?: number;
}

function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return "";
  return String(error.code);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The agent log could not be refreshed.";
}

const markdownComponents: Components = {
  pre: ({ node: _node, children, ...props }) => {
    const code = Array.isArray(children) ? children[0] : children;
    if (
      isValidElement<{ className?: string; children?: ReactNode }>(code) &&
      code.props.className === "language-mermaid"
    ) {
      return (
        <MermaidDiagram
          className="agent-log-mermaid"
          source={String(code.props.children).replace(/\n$/, "")}
        />
      );
    }
    return (
      <pre {...props}>
        {children}
      </pre>
    );
  },
  table: ({ node: _node, ...props }) => (
    <div
      className="agent-log-table-scroll"
      role="region"
      aria-label="Scrollable table"
      tabIndex={0}
    >
      <table {...props} />
    </div>
  ),
};

const entryTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function entryTime(timestamp?: string): string {
  if (!timestamp) return "";
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return "";
  return entryTimeFormatter.format(parsed);
}

function Markdown({ children }: { children: string }) {
  return (
    <div className="agent-log-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

function MessageEntry({ entry }: { entry: AgentLogEntry }) {
  const role = entry.role === "user" ? "You" : "Agent";
  return (
    <article className="agent-log-message" data-role={entry.role}>
      <header>
        <span>{role}</span>
        {entry.timestamp && <time dateTime={entry.timestamp}>{entryTime(entry.timestamp)}</time>}
      </header>
      <Markdown>{entry.content ?? ""}</Markdown>
    </article>
  );
}

function DetailEntry({ entry }: { entry: AgentLogEntry }) {
  const isThinking = entry.kind === "thinking";
  const label = isThinking
    ? "Reasoning"
    : entry.kind === "tool_result"
      ? `${entry.title || "Tool"} result`
      : entry.title || "Tool";
  return (
    <details className="agent-log-detail" data-kind={entry.kind}>
      <summary>
        <span>{label}</span>
        {entry.timestamp && <time dateTime={entry.timestamp}>{entryTime(entry.timestamp)}</time>}
      </summary>
      {isThinking ? <Markdown>{entry.content ?? ""}</Markdown> : <pre>{entry.content}</pre>}
    </details>
  );
}

interface ToolExecution {
  call?: AgentLogEntry;
  result?: AgentLogEntry;
}

function pairToolEntries(entries: AgentLogEntry[]): ToolExecution[] {
  const executions: ToolExecution[] = [];
  const callsById = new Map<string, ToolExecution>();
  const callsInSourceOrder: ToolExecution[] = [];
  let nextUnkeyedCall = 0;

  for (const entry of entries) {
    if (entry.kind === "tool") {
      const execution = { call: entry };
      executions.push(execution);
      callsInSourceOrder.push(execution);
      const callId = entry.callId?.trim();
      if (callId) callsById.set(callId, execution);
      continue;
    }
    if (entry.kind !== "tool_result") continue;

    const callId = entry.callId?.trim();
    const keyedExecution = callId ? callsById.get(callId) : undefined;
    if (keyedExecution && !keyedExecution.result) {
      keyedExecution.result = entry;
      continue;
    }
    if (!callId) {
      while (
        nextUnkeyedCall < callsInSourceOrder.length &&
        callsInSourceOrder[nextUnkeyedCall].result
      ) {
        nextUnkeyedCall++;
      }
      const unkeyedExecution = callsInSourceOrder[nextUnkeyedCall];
      if (unkeyedExecution) {
        unkeyedExecution.result = entry;
        nextUnkeyedCall++;
        continue;
      }
    }
    executions.push({ result: entry });
  }

  return executions;
}

function toolEntryContent(entry?: AgentLogEntry): string {
  return entry?.content?.length ? entry.content : "(empty)";
}

function ToolGroupEntry({ entry }: { entry: AgentLogEntry }) {
  const count = entry.toolCalls ?? 0;
  const executions = pairToolEntries(entry.entries ?? []);
  return (
    <details className="agent-log-tool-group" data-kind="tool_group">
      <summary>
        <span>{count} tool {count === 1 ? "call" : "calls"}</span>
        {entry.timestamp && <time dateTime={entry.timestamp}>{entryTime(entry.timestamp)}</time>}
      </summary>
      <div className="agent-log-tool-executions">
        {executions.map((execution, index) => {
          const toolName =
            execution.call?.title || execution.result?.title || "Tool result";
          const headingId = `agent-log-tool-${entry.id}-${index + 1}`;
          const timestamp = execution.call?.timestamp ?? execution.result?.timestamp;
          const executionKey = execution.call
            ? `call-${execution.call.id}`
            : `result-${execution.result?.id ?? "missing"}`;
          return (
            <article
              className="agent-log-tool-execution"
              aria-labelledby={headingId}
              key={executionKey}
            >
              <header>
                <span className="agent-log-tool-sequence">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3 id={headingId}>{toolName}</h3>
                {timestamp && <time dateTime={timestamp}>{entryTime(timestamp)}</time>}
              </header>
              <div className="agent-log-tool-region">
                <span>Call</span>
                <pre>{toolEntryContent(execution.call)}</pre>
              </div>
              <div className="agent-log-tool-region">
                <span>Result</span>
                <pre>
                  {execution.result
                    ? toolEntryContent(execution.result)
                    : "Waiting for result…"}
                </pre>
              </div>
            </article>
          );
        })}
      </div>
    </details>
  );
}

interface TranscriptViewProps {
  transcript: AgentTranscript;
  loadingMore: boolean;
  onLoadMore: () => void;
  viewportRef: RefObject<HTMLDivElement | null>;
}

function TranscriptView({
  transcript,
  loadingMore,
  onLoadMore,
  viewportRef,
}: TranscriptViewProps) {
  const entries = transcript.entries ?? [];
  if (entries.length === 0 && !transcript.nextCursor) {
    return (
      <Empty className="agent-log-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BotIcon />
          </EmptyMedia>
          <EmptyTitle>Transcript is empty</EmptyTitle>
          <EmptyDescription>Waiting for the first agent event…</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <MessageScrollerProvider
      key={transcript.sessionId}
      autoScroll
      defaultScrollPosition="end"
    >
      <MessageScroller className="agent-log-scroller">
        <MessageScrollerViewport aria-label="Agent log" ref={viewportRef}>
          <MessageScrollerContent aria-label={`${transcript.agent} transcript`}>
            {transcript.nextCursor && (
              <div className="agent-log-load-more">
                <button type="button" onClick={onLoadMore} disabled={loadingMore}>
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              </div>
            )}
            {entries.map((entry) => (
              <MessageScrollerItem
                key={entry.id}
                messageId={entry.id}
                scrollAnchor={entry.kind === "message" && entry.role === "user"}
              >
                {entry.kind === "message" ? (
                  <MessageEntry entry={entry} />
                ) : entry.kind === "tool_group" ? (
                  <ToolGroupEntry entry={entry} />
                ) : (
                  <DetailEntry entry={entry} />
                )}
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton aria-label="Scroll to end" />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

function mergeAdjacentToolGroups(entries: AgentLogEntry[]): AgentLogEntry[] {
  const merged: AgentLogEntry[] = [];
  for (const entry of entries) {
    const previous = merged[merged.length - 1];
    if (entry.kind === "tool_group" && previous?.kind === "tool_group") {
      merged[merged.length - 1] = {
        ...previous,
        toolCalls: (previous.toolCalls ?? 0) + (entry.toolCalls ?? 0),
        entries: [...(previous.entries ?? []), ...(entry.entries ?? [])],
      };
      continue;
    }
    merged.push(entry);
  }
  return merged;
}

function AgentLogViewContent({ session, api, active, fontSize = 14 }: AgentLogViewProps) {
  const [log, setLog] = useState<AgentTranscript | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const etagRef = useRef("");
  const endCursorRef = useRef("");
  const loadMoreGenerationRef = useRef(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const prependAdjustmentRef = useRef<{
    sessionId: string;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const sessionKey = `${session.id}\u0000${session.agent ?? ""}`;
  const sessionKeyRef = useRef(sessionKey);
  const linkedAgent = session.agent === "claude"
    ? "Claude"
    : session.agent === "codex"
      ? "Codex"
      : "";

  useLayoutEffect(() => {
    sessionKeyRef.current = sessionKey;
    return () => {
      sessionKeyRef.current = "";
      loadMoreGenerationRef.current++;
    };
  }, [sessionKey]);

  useLayoutEffect(() => {
    const adjustment = prependAdjustmentRef.current;
    if (!adjustment || adjustment.sessionId !== log?.sessionId) {
      if (adjustment) prependAdjustmentRef.current = null;
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) return;
    let adjustmentFrame = 0;
    const layoutFrame = window.requestAnimationFrame(() => {
      adjustmentFrame = window.requestAnimationFrame(() => {
        viewport.scrollTop =
          adjustment.scrollTop + viewport.scrollHeight - adjustment.scrollHeight;
        prependAdjustmentRef.current = null;
      });
    });
    return () => {
      window.cancelAnimationFrame(layoutFrame);
      if (adjustmentFrame) window.cancelAnimationFrame(adjustmentFrame);
    };
  }, [log?.sessionId, log?.startCursor]);

  useEffect(() => {
    if (!active) return;
    let current = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const after = endCursorRef.current;
        const request = etagRef.current || after
          ? {
              ...(etagRef.current ? { etag: etagRef.current } : {}),
              ...(after ? { after } : {}),
            }
          : undefined;
        const result = await api.getAgentLog(session.id, request);
        if (current) {
          etagRef.current = result.etag;
          if (result.log) {
            const nextLog = result.log;
            setLog((currentLog) => {
              if (
                !currentLog ||
                currentLog.sessionId !== nextLog.sessionId ||
                (after && nextLog.startCursor !== after)
              ) {
                return nextLog;
              }
              if (!after) return nextLog;
              return {
                ...currentLog,
                entries: mergeAdjacentToolGroups([
                  ...(currentLog.entries ?? []),
                  ...(nextLog.entries ?? []),
                ]),
                endCursor: nextLog.endCursor,
              };
            });
            endCursorRef.current = nextLog.endCursor ?? "";
          }
          setUnavailable(false);
          setError("");
        }
      } catch (refreshError) {
        if (!current) return;
        if (errorCode(refreshError) === "agent_log_not_found") {
          setUnavailable(true);
          setError("");
        } else {
          setError(errorMessage(refreshError));
        }
      } finally {
        if (current) setLoading(false);
        refreshing = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [active, api, session.agent, session.id]);

  const loadMore = async () => {
    const before = log?.nextCursor;
    if (!before || loadingMore) return;
    const requestSessionKey = sessionKey;
    const requestTranscriptID = log.sessionId;
    const requestGeneration = ++loadMoreGenerationRef.current;
    const viewport = viewportRef.current;
    if (viewport) {
      prependAdjustmentRef.current = {
        sessionId: requestTranscriptID,
        scrollHeight: viewport.scrollHeight,
        scrollTop: viewport.scrollTop,
      };
    }
    setLoadingMore(true);
    try {
      const result = await api.getAgentLog(session.id, { before });
      if (
        sessionKeyRef.current !== requestSessionKey ||
        loadMoreGenerationRef.current !== requestGeneration
      ) {
        return;
      }
      if (!result.log) {
        prependAdjustmentRef.current = null;
        return;
      }
      const olderLog = result.log;
      if (olderLog.sessionId !== requestTranscriptID) {
        prependAdjustmentRef.current = null;
        return;
      }
      setLog((currentLog) => {
        if (
          !currentLog ||
          currentLog.sessionId !== requestTranscriptID ||
          olderLog.sessionId !== requestTranscriptID
        ) {
          return currentLog;
        }
        return {
          ...currentLog,
          entries: mergeAdjacentToolGroups([
            ...(olderLog.entries ?? []),
            ...(currentLog.entries ?? []),
          ]),
          startCursor: olderLog.startCursor,
          nextCursor: olderLog.nextCursor,
        };
      });
    } catch (loadError) {
      if (
        sessionKeyRef.current !== requestSessionKey ||
        loadMoreGenerationRef.current !== requestGeneration
      ) {
        return;
      }
      prependAdjustmentRef.current = null;
      setError(errorMessage(loadError));
    } finally {
      if (
        sessionKeyRef.current === requestSessionKey &&
        loadMoreGenerationRef.current === requestGeneration
      ) {
        setLoadingMore(false);
      }
    }
  };

  return (
    <section
      className="agent-log-view"
      aria-label="Agent log"
      style={{ "--agent-log-font-size": `${fontSize}px` } as CSSProperties}
    >
      {log ? (
        <TranscriptView
          transcript={log}
          loadingMore={loadingMore}
          onLoadMore={() => void loadMore()}
          viewportRef={viewportRef}
        />
      ) : loading && active ? (
        <div className="agent-log-loading" aria-label="Loading agent log">
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </div>
      ) : (
        <Empty className="agent-log-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              {error ? <FileWarningIcon /> : <BotIcon />}
            </EmptyMedia>
            <EmptyTitle>{error ? "Agent log unavailable" : "No agent log yet"}</EmptyTitle>
            <EmptyDescription>
              {error
                ? `${error} Euphony will retry automatically.`
                : unavailable && linkedAgent
                  ? `Waiting for the linked ${linkedAgent} transcript…`
                  : "Agent log will appear when Claude or Codex starts here."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {(unavailable || error) && log && (
        <p className="agent-log-refresh-note" role="status">
          {error
            ? "Refresh interrupted. Retrying automatically."
            : "Waiting for the linked transcript…"}
        </p>
      )}
    </section>
  );
}

export function AgentLogView(props: AgentLogViewProps) {
  const sessionKey = `${props.session.id}\u0000${props.session.agent ?? ""}`;
  return <AgentLogViewContent key={sessionKey} {...props} />;
}
