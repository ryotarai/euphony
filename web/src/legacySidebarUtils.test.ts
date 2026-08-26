import { flattenLegacySidebarSessions } from "./legacySidebarUtils";
import type { Session } from "./types";

const session = (id: string, cwd: string, updatedAt: string): Session => ({
  id,
  name: id,
  state: "running",
  cwd,
  agentStatus: id === "waiting" ? "waiting" : undefined,
  needsAttention: id === "attention",
  createdAt: "2026-08-27T00:00:00Z",
  updatedAt,
});

test("keeps legacy sidebar rows in source order across activity updates", () => {
  const sessions = [
    session("terminal", "/workspace/app", "2026-08-27T00:01:00Z"),
    session("waiting", "/workspace/app", "2026-08-27T00:03:00Z"),
    session("attention", "/workspace/app", "2026-08-27T00:02:00Z"),
  ];

  expect(flattenLegacySidebarSessions(sessions).map(({ id }) => id)).toEqual([
    "terminal",
    "waiting",
    "attention",
  ]);
});
