import type { AgentSummary } from "./types";
import { isHumanActionRequired } from "./sessionPresentation";

const summary = (overrides: Partial<AgentSummary> = {}): AgentSummary => ({
  terminalId: "terminal-1",
  provider: "codex",
  status: "waiting",
  summary: "The agent is waiting.",
  generatedAt: "2026-08-27T00:00:00Z",
  unread: false,
  ...overrides,
});

test("requires a real decision or input before showing a next action", () => {
  expect(isHumanActionRequired(summary({ action: "Choose the release target." }))).toBe(true);
  expect(isHumanActionRequired(summary({ status: "blocked", action: "Approve the requested access." })))
    .toBe(true);
  expect(isHumanActionRequired(summary({ action: "Work completed. Please check it." }))).toBe(false);
  expect(isHumanActionRequired(summary({ action: "The task is complete. Confirm the result." })))
    .toBe(false);
  expect(isHumanActionRequired(summary({ status: "running", action: "Approve the requested access." })))
    .toBe(false);
});

test("treats suggested options as actionable while the agent is waiting", () => {
  expect(isHumanActionRequired(summary({
    action: "Select an option.",
    options: [{ label: "Use the existing release" }],
  }))).toBe(true);
  expect(isHumanActionRequired(summary({
    action: "Work completed.",
    options: [],
  }))).toBe(false);
});
