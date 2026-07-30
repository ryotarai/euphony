import {
  isValidElement,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
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
      return <MermaidDiagram source={String(code.props.children).replace(/\n$/, "")} />;
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

function entryTime(timestamp?: string): string {
  if (!timestamp) return "";
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(parsed);
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

function TranscriptView({ transcript }: { transcript: AgentTranscript }) {
  const entries = transcript.entries ?? [];
  if (entries.length === 0) {
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
        <MessageScrollerViewport aria-label="Agent log">
          <MessageScrollerContent aria-label={`${transcript.agent} transcript`}>
            {entries.map((entry) => (
              <MessageScrollerItem
                key={entry.id}
                messageId={entry.id}
                scrollAnchor={entry.kind === "message" && entry.role === "user"}
              >
                {entry.kind === "message" ? (
                  <MessageEntry entry={entry} />
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

export function AgentLogView({ session, api, active, fontSize = 14 }: AgentLogViewProps) {
  const [log, setLog] = useState<AgentTranscript | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState("");
  const etagRef = useRef("");
  const linkedAgent = session.agent === "claude"
    ? "Claude"
    : session.agent === "codex"
      ? "Codex"
      : "";

  useEffect(() => {
    etagRef.current = "";
    setLog(null);
    setLoading(true);
    setUnavailable(false);
    setError("");
  }, [session.id, session.agent]);

  useEffect(() => {
    if (!active) return;
    let current = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const result = await api.getAgentLog(session.id, etagRef.current || undefined);
        if (!current) return;
        etagRef.current = result.etag;
        if (result.log) setLog(result.log);
        setUnavailable(false);
        setError("");
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

  return (
    <section
      className="agent-log-view"
      role="region"
      aria-label="Agent log"
      style={{ "--agent-log-font-size": `${fontSize}px` } as CSSProperties}
    >
      {log ? (
        <TranscriptView transcript={log} />
      ) : loading ? (
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
