import { useState, type ReactNode } from "react";
import { FileClockIcon, TerminalSquareIcon } from "lucide-react";
import type { ApiClient } from "../api";
import type { Session } from "../types";
import { AgentLogView } from "./AgentLogView";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface TerminalPaneProps {
  session: Session;
  api: ApiClient;
  active: boolean;
  layoutVersion: number;
  onDeselect: () => void;
  renderTerminal(layoutVersion: number, active: boolean): ReactNode;
}

type PaneSource = "terminal" | "agent-log";

export function TerminalPane({
  session,
  api,
  active,
  layoutVersion,
  onDeselect,
  renderTerminal,
}: TerminalPaneProps) {
  const [source, setSource] = useState<PaneSource>("terminal");
  const [fitVersion, setFitVersion] = useState(0);
  const changeSource = (next: string | null) => {
    if (next !== "terminal" && next !== "agent-log") return;
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

  return (
    <Tabs
      className="terminal-pane-tabs"
      value={source}
      onValueChange={changeSource}
      data-agent={session.agent || "none"}
    >
      <div className="terminal-tab-rail">
        <TabsList variant="line" aria-label={`${session.name} sources`}>
          <TabsTrigger value="terminal" aria-label="Terminal" title="Terminal">
            <TerminalSquareIcon aria-hidden="true" />
          </TabsTrigger>
          <TabsTrigger value="agent-log" aria-label="Agent log" title="Agent log">
            <FileClockIcon aria-hidden="true" />
          </TabsTrigger>
        </TabsList>
        <div className="terminal-tab-meta">
          <span className="terminal-tab-source" aria-hidden="true">
            {source === "terminal" ? "Terminal" : `${agentLabel} log`}
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
        <AgentLogView session={session} api={api} active={source === "agent-log"} />
      </TabsContent>
    </Tabs>
  );
}
