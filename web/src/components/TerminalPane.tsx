import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  FileClockIcon,
  FolderTreeIcon,
  GitCompareArrowsIcon,
  MessageSquareTextIcon,
  TerminalSquareIcon,
} from "lucide-react";
import type { ApiClient } from "../api";
import { isEditableTarget, matchesPrefix } from "../keybindings";
import type { AnnotationSession, Session } from "../types";
import { AgentLogView } from "./AgentLogView";
import { AnnotationView } from "./AnnotationView";
import { GitChangesView } from "./GitChangesView";
import { WorkspaceFilesView } from "./WorkspaceFilesView";
import { Button } from "@/components/ui/button";
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
  renderTerminal(layoutVersion: number, active: boolean, sourceVisible: boolean): ReactNode;
}

type PaneSource = "terminal" | "agent-log" | "changes" | "files" | "annotation";

const minimumPrimarySize = 20;
const maximumPrimarySize = 80;

function normalizePrimarySize(size: number) {
  return Math.min(maximumPrimarySize, Math.max(minimumPrimarySize, Math.round(size)));
}

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
  const [secondarySource, setSecondarySource] = useState<PaneSource | null>(null);
  const [primarySize, setPrimarySize] = useState(50);
  const [resizingSplit, setResizingSplit] = useState(false);
  const [annotation, setAnnotation] = useState<AnnotationSession | null>(null);
  const [annotationRetry, setAnnotationRetry] = useState(0);
  const [annotationSyncFailed, setAnnotationSyncFailed] = useState(false);
  const annotationIDRef = useRef<string | null>(null);
  const commandClickSourceRef = useRef<PaneSource | null>(null);
  const resizingPointerRef = useRef<number | null>(null);
  const sourceStageRef = useRef<HTMLDivElement | null>(null);
  const [fitVersion, setFitVersion] = useState(0);
  const changeSource = (next: string | null) => {
    if (
      next !== "terminal" &&
      next !== "agent-log" &&
      next !== "changes" &&
      next !== "files" &&
      next !== "annotation"
    ) return;
    if (next === "annotation" && !annotation) return;
    if (source !== "terminal" && next === "terminal") {
      setFitVersion((current) => current + 1);
    }
    setSecondarySource(null);
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
      setAnnotationSyncFailed(false);
      if (next && next.id !== previousID) {
        setSecondarySource(null);
        setSource("annotation");
      }
      if (!next && previousID) {
        setFitVersion((current) => current + 1);
        setSecondarySource((current) => (
          current === "annotation" ? null : current
        ));
        setSource((current) => (
          current === "annotation" ? "terminal" : current
        ));
      }
      setAnnotation(next);
    }).catch(() => {
      if (annotationIDRef.current) setAnnotationSyncFailed(true);
    });
    return () => {
      current = false;
    };
  }, [annotationRetry, api, annotationRevision, session.id]);

  useEffect(() => {
    if (!active) return;
    const toggleSource = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target) || !matchesPrefix(event, tabShortcut)) return;
      event.preventDefault();
      event.stopPropagation();
      const sources: PaneSource[] = annotation
        ? ["terminal", "agent-log", "changes", "files", "annotation"]
        : ["terminal", "agent-log", "changes", "files"];
      const index = sources.indexOf(source);
      changeSource(sources[(index + 1) % sources.length]);
    };
    window.addEventListener("keydown", toggleSource, { capture: true });
    return () => window.removeEventListener("keydown", toggleSource, { capture: true });
  }, [active, annotation, source, tabShortcut]);

  useEffect(() => {
    if (!resizingSplit) return;
    const matchesPointer = (event: PointerEvent) => (
      resizingPointerRef.current === event.pointerId
    );
    const resize = (event: PointerEvent) => {
      if (!matchesPointer(event)) return;
      const bounds = sourceStageRef.current?.getBoundingClientRect();
      if (!bounds || bounds.width <= 0) return;
      setPrimarySize(normalizePrimarySize(
        ((event.clientX - bounds.left) / bounds.width) * 100,
      ));
    };
    const finish = (event: PointerEvent) => {
      if (!matchesPointer(event)) return;
      resize(event);
      resizingPointerRef.current = null;
      setResizingSplit(false);
    };
    const cancel = () => {
      resizingPointerRef.current = null;
      setResizingSplit(false);
    };
    const cancelPointer = (event: PointerEvent) => {
      if (!matchesPointer(event)) return;
      cancel();
    };
    document.addEventListener("pointermove", resize);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", cancelPointer);
    window.addEventListener("blur", cancel);
    return () => {
      document.removeEventListener("pointermove", resize);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", cancelPointer);
      window.removeEventListener("blur", cancel);
    };
  }, [resizingSplit]);

  useEffect(() => {
    if (secondarySource !== null) return;
    resizingPointerRef.current = null;
    setResizingSplit(false);
  }, [secondarySource]);

  const sourceLabel = (paneSource: PaneSource) => (
    paneSource === "terminal"
      ? "Terminal"
      : paneSource === "agent-log"
        ? `${agentLabel} log`
        : paneSource === "changes"
          ? "Git changes"
          : paneSource === "files"
            ? "Workspace files"
            : annotation?.filename ?? "Annotation"
  );
  const sourceIsVisible = (paneSource: PaneSource) => (
    paneSource === source || paneSource === secondarySource
  );
  const sourcePosition = (paneSource: PaneSource) => (
    paneSource === source
      ? "primary"
      : paneSource === secondarySource
        ? "secondary"
        : undefined
  );
  const sourcePanelProps = (paneSource: PaneSource) => {
    const visible = sourceIsVisible(paneSource);
    const position = sourcePosition(paneSource);
    const secondary = position === "secondary";
    return {
      ...(secondary ? {
        "aria-label": `${sourceLabel(paneSource)} split view`,
        "aria-labelledby": undefined,
      } : {}),
      "data-pane-position": position,
      hidden: !visible,
      inert: !visible,
      role: secondary ? "region" : "tabpanel",
      tabIndex: visible ? 0 : -1,
    };
  };
  const toggleSecondarySource = (next: PaneSource) => {
    if (next === source) {
      setSecondarySource(null);
      return;
    }
    setSecondarySource((current) => current === next ? null : next);
  };
  const handleTabClickCapture = (
    event: ReactMouseEvent<HTMLButtonElement>,
    paneSource: PaneSource,
  ) => {
    commandClickSourceRef.current = event.metaKey ? paneSource : null;
  };
  const handleTabClick = (
    event: ReactMouseEvent<HTMLButtonElement>,
    paneSource: PaneSource,
  ) => {
    if (event.metaKey) {
      event.preventDefault();
      toggleSecondarySource(paneSource);
      queueMicrotask(() => {
        if (commandClickSourceRef.current === paneSource) {
          commandClickSourceRef.current = null;
        }
      });
      return;
    }
    if (paneSource === source) setSecondarySource(null);
  };
  const resizeSplitWithKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    let next = primarySize;
    if (event.key === "ArrowLeft") next -= 5;
    else if (event.key === "ArrowRight") next += 5;
    else if (event.key === "Home") next = minimumPrimarySize;
    else if (event.key === "End") next = maximumPrimarySize;
    else return;
    event.preventDefault();
    setPrimarySize(normalizePrimarySize(next));
  };
  const splitStyle = {
    "--pane-primary-size": `${primarySize}%`,
  } as CSSProperties;
  const tabInteractionProps = (paneSource: PaneSource) => ({
    "aria-description": secondarySource === paneSource
      ? "Visible in split"
      : undefined,
    "aria-keyshortcuts": "Meta+Enter",
    "data-split-active": secondarySource === paneSource ? "true" : undefined,
    onClickCapture: (event: ReactMouseEvent<HTMLButtonElement>) => {
      handleTabClickCapture(event, paneSource);
    },
    onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
      handleTabClick(event, paneSource);
    },
    onKeyDownCapture: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!event.metaKey || event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      toggleSecondarySource(paneSource);
    },
  });

  return (
    <Tabs
      className="terminal-pane-tabs"
      value={source}
      onValueChange={(next) => {
        if (commandClickSourceRef.current === next) return;
        changeSource(next);
      }}
      data-agent={session.agent || "none"}
    >
      <div className="terminal-tab-rail">
        <TabsList variant="line" aria-label={`${session.name} sources`}>
          <TabsTrigger
            value="terminal"
            aria-label="Terminal"
            title={`Terminal (${tabShortcut})`}
            {...tabInteractionProps("terminal")}
          >
            <TerminalSquareIcon aria-hidden="true" />
          </TabsTrigger>
          <TabsTrigger
            value="agent-log"
            aria-label="Agent log"
            title={`Agent log (${tabShortcut})`}
            {...tabInteractionProps("agent-log")}
          >
            <FileClockIcon aria-hidden="true" />
          </TabsTrigger>
          <TabsTrigger
            value="changes"
            aria-label="Changes"
            title={`Changes (${tabShortcut})`}
            {...tabInteractionProps("changes")}
          >
            <GitCompareArrowsIcon aria-hidden="true" />
          </TabsTrigger>
          <TabsTrigger
            value="files"
            aria-label="Files"
            title={`Files (${tabShortcut})`}
            {...tabInteractionProps("files")}
          >
            <FolderTreeIcon aria-hidden="true" />
          </TabsTrigger>
          {annotation && (
            <TabsTrigger
              value="annotation"
              aria-label="Annotation"
              title={`Annotation (${tabShortcut})`}
              {...tabInteractionProps("annotation")}
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
            {sourceLabel(source)}
            {secondarySource && ` + ${sourceLabel(secondarySource)}`}
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
      <div
        className="terminal-source-stage"
        ref={sourceStageRef}
        data-split={secondarySource ? "true" : undefined}
        data-resizing={resizingSplit ? "true" : undefined}
        style={splitStyle}
      >
        <TabsContent
          className="terminal-tab-content"
          value="terminal"
          keepMounted
          {...sourcePanelProps("terminal")}
        >
          {renderTerminal(
            layoutVersion + fitVersion,
            active && source === "terminal" && secondarySource === null,
            sourceIsVisible("terminal"),
          )}
        </TabsContent>
        <TabsContent
          className="terminal-tab-content"
          value="agent-log"
          keepMounted
          {...sourcePanelProps("agent-log")}
        >
          <AgentLogView
            session={session}
            api={api}
            active={sourceIsVisible("agent-log")}
            fontSize={agentLogFontSize}
          />
        </TabsContent>
        <TabsContent
          className="terminal-tab-content"
          value="changes"
          keepMounted
          {...sourcePanelProps("changes")}
        >
          <GitChangesView
            session={session}
            api={api}
            active={sourceIsVisible("changes")}
          />
        </TabsContent>
        <TabsContent
          className="terminal-tab-content"
          value="files"
          keepMounted
          {...sourcePanelProps("files")}
        >
          <WorkspaceFilesView
            session={session}
            api={api}
            active={sourceIsVisible("files")}
          />
        </TabsContent>
        {annotation && (
          <TabsContent
            className="terminal-tab-content"
            value="annotation"
            keepMounted
            {...sourcePanelProps("annotation")}
          >
            {annotationSyncFailed && (
              <div className="annotation-sync-warning" role="status">
                <span>Review status could not be refreshed.</span>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => setAnnotationRetry((current) => current + 1)}
                >
                  Retry
                </Button>
              </div>
            )}
            <AnnotationView
              annotation={annotation}
              api={api}
              onCompleted={() => {
                annotationIDRef.current = null;
                setAnnotation(null);
                setFitVersion((current) => current + 1);
                setSecondarySource((current) => (
                  current === "annotation" ? null : current
                ));
                setSource((current) => (
                  current === "annotation" ? "terminal" : current
                ));
              }}
            />
          </TabsContent>
        )}
        {secondarySource && (
          <button
            type="button"
            className="terminal-source-divider"
            role="separator"
            aria-label="Resize source split"
            aria-orientation="vertical"
            aria-valuemin={minimumPrimarySize}
            aria-valuemax={maximumPrimarySize}
            aria-valuenow={primarySize}
            aria-valuetext={`${primarySize}% primary, ${100 - primarySize}% secondary`}
            title="Drag to resize split"
            onDoubleClick={() => setPrimarySize(50)}
            onKeyDown={resizeSplitWithKeyboard}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              resizingPointerRef.current = event.pointerId;
              event.currentTarget.setPointerCapture?.(event.pointerId);
              setResizingSplit(true);
            }}
            onLostPointerCapture={(event) => {
              if (resizingPointerRef.current !== event.pointerId) return;
              resizingPointerRef.current = null;
              setResizingSplit(false);
            }}
          >
            <span aria-hidden="true" />
          </button>
        )}
      </div>
    </Tabs>
  );
}
