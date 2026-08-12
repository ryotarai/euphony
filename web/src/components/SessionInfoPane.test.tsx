import { render, screen } from "@testing-library/react";
import { SessionInfoPane } from "./SessionInfoPane";
import type { AgentSummary, Session } from "../types";

const session: Session = {
  id: "session-info",
  name: "Codex",
  state: "running",
  cwd: "/workspace/euphony",
  agent: "codex",
  agentStatus: "waiting",
  createdAt: "2026-08-12T00:00:00Z",
};

const summary: AgentSummary = {
  terminalId: session.id,
  provider: "codex",
  status: "waiting",
  purpose: "Review the sidebar",
  summary: "The sidebar is ready for a visual check.",
  generatedAt: "2026-08-12T00:05:00Z",
  unread: false,
};

test("labels the session detail heading as Purpose instead of the provider name", () => {
  render(<SessionInfoPane session={session} summary={summary} />);

  expect(screen.getByRole("heading", { name: "Purpose", level: 2 })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Codex", level: 2 })).not.toBeInTheDocument();
});
