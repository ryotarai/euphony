import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileClockIcon, MessageSquareTextIcon, TerminalSquareIcon } from "lucide-react";
import type { ApiClient } from "../api";
import { isEditableTarget, matchesPrefix } from "../keybindings";
import type { AnnotationSession, Session } from "../types";
import { AgentLogView } from "./AgentLogView";
import { AnnotationView } from "./AnnotationView";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface TerminalPaneProps {
  session: Session;
  api: ApiClient;
  active: boolean;
  layoutVersion: number;
  tabShortcut: string;
  agentLogFontSize?: number;
  annotationRevision?: number | null;
  onDeselect: () => void;
  renderTerminal(layoutVersion: number, active: boolean): ReactNode;
}

type PaneSource = "terminal" | "agent-log" | "annotation";

export function TerminalPane({
  session,
  api,
  active,
  layoutVersion,
  tabShortcut,
  agentLogFontSize = 14,
  annotationRevision = null,
  onDeselect,
  renderTerminal,
}: TerminalPaneProps) {
  const [source, setSource] = useState<PaneSource>("terminal");
  const [annotation, setAnnotation] = useState<AnnotationSession | null>(null);
  const annotationIDRef = useRef<string | null>(null);
  const [fitVersion, setFitVersion] = useState(0);
  const changeSource = (next: string | null) => {
    if (next !== "terminal" && next !== "agent-log" && next !== "annotation") return;
    if (next === "annotation" && !annotation) return;
    if (source === "agent-log" && next === "terminal") {
      setFitVersion((current) => current + 1);
    }
    setSource(next);
  };
  const agentLabel = session.agent === "claude"
    ? "Claude"
    : session.agent === "codex"
      ? "Codex"
      : "Agent";

  useEffect(() => {
    if (annotationRevision === null) return;
    let current = true;
    void api.getCurrentAnnotation(session.id).then((next) => {
      if (!current) return;
      const previousID = annotationIDRef.current;
      annotationIDRef.current = next?.id ?? null;
      if (next && next.id !== previousID) setSource("annotation");
      if (!next && previousID) setSource("terminal");
      setAnnotation(next);
    }).catch(() => {
      // Keep an already displayed review available until the next event retry.
    });
    return () => {
      current = false;
    };
  }, [api, annotationRevision, session.id]);

  useEffect(() => {
    if (!active) return;
    const toggleSource = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target) || !matchesPrefix(event, tabShortcut)) return;
      event.preventDefault();
      event.stopPropagation();
      const sources: PaneSource[] = annotation
        ? ["terminal", "agent-log", "annotation"]
        : ["terminal", "agent-log"];
      const index = sources.indexOf(source);
      changeSource(sources[(index + 1) % sources.length]);
    };
    window.addEventListener("keydown", toggleSource, { capture: true });
    return () => window.removeEventListener("keydown", toggleSource, { capture: true });
  }, [active, annotation, source, tabShortcut]);

  return (
    <Tabs
      className="terminal-pane-tabs"
      value={source}
      onValueChange={changeSource}
      data-agent={session.agent || "none"}
    >
      <div className="terminal-tab-rail">
        <TabsList variant="line" aria-label={`${session.name} sources`}>
          <TabsTrigger
            value="terminal"
            aria-label="Terminal"
            title={`Terminal (${tabShortcut})`}
          >
            <TerminalSquareIcon aria-hidden="true" />
          </TabsTrigger>
          <TabsTrigger
            value="agent-log"
            aria-label="Agent log"
            title={`Agent log (${tabShortcut})`}
          >
            <FileClockIcon aria-hidden="true" />
          </TabsTrigger>
          {annotation && (
            <TabsTrigger
              value="annotation"
              aria-label="Annotation"
              title={`Annotation (${tabShortcut})`}
            >
              <MessageSquareTextIcon aria-hidden="true" />
            </TabsTrigger>
          )}
        </TabsList>
        <div className="terminal-tab-meta">
          {session.needsAttention && (
            <span
              className="pane-attention-indicator"
              role="status"
              aria-label="Needs attention"
            >
              <span className="attention-dot" aria-hidden="true" />
            </span>
          )}
          <span className="terminal-tab-source" aria-hidden="true">
            {source === "terminal"
              ? "Terminal"
              : source === "agent-log"
                ? `${agentLabel} log`
                : annotation?.filename ?? "Annotation"}
          </span>
          <Checkbox
            className="terminal-tab-selection"
            aria-label={`Deselect ${session.name}`}
            checked
            onMouseDown={(event) => event.stopPropagation()}
            onCheckedChange={(checked) => {
              if (!checked) onDeselect();
            }}
          />
        </div>
      </div>
      <TabsContent
        className="terminal-tab-content"
        value="terminal"
        keepMounted
      >
        {renderTerminal(layoutVersion + fitVersion, active && source === "terminal")}
      </TabsContent>
      <TabsContent
        className="terminal-tab-content"
        value="agent-log"
        keepMounted
      >
        <AgentLogView
          session={session}
          api={api}
          active={source === "agent-log"}
          fontSize={agentLogFontSize}
        />
      </TabsContent>
      {annotation && (
        <TabsContent
          className="terminal-tab-content"
          value="annotation"
          keepMounted
        >
          <AnnotationView
            annotation={annotation}
            api={api}
            onCompleted={() => {
              annotationIDRef.current = null;
              setAnnotation(null);
              setSource("terminal");
            }}
          />
        </TabsContent>
      )}
    </Tabs>
  );
}
