import { render, screen } from "@testing-library/react";
import { SessionInfoCard } from "./SessionInfoPane";
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

test("renders the purpose text in the session information card", () => {
  render(<SessionInfoCard session={session} summary={summary} />);

  expect(screen.getByRole("region", { name: "Session information" }))
    .toHaveAttribute("data-card-name", "session-info-card");
  expect(screen.getByRole("heading", { name: "Review the sidebar", level: 2 })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Codex", level: 2 })).not.toBeInTheDocument();
  expect(screen.queryByText("Purpose", { selector: "dt" })).not.toBeInTheDocument();
  expect(screen.getByText("Summary", { selector: "dt" })).toBeVisible();
  expect(screen.getByText("Action", { selector: "dt" })).toBeVisible();
});

test("keeps the bare terminal name instead of applying an agent purpose", () => {
  render(
    <SessionInfoCard
      session={{ ...session, name: "Terminal", agent: undefined }}
      summary={summary}
    />,
  );

  expect(screen.getByRole("heading", { name: "Terminal", level: 2 })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Review the sidebar", level: 2 }))
    .not.toBeInTheDocument();
});

test("uses the bare terminal name when the session has no purpose or summary", () => {
  render(
    <SessionInfoCard
      session={{
        ...session,
        name: "Shell",
        agent: undefined,
        agentTitle: undefined,
        processName: undefined,
      }}
    />,
  );

  expect(screen.getByRole("heading", { name: "Shell", level: 2 })).toBeVisible();
  expect(screen.getByText("No summary yet.")).toBeVisible();
});
