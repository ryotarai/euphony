import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const stylesheet = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

test("animates running sidebar status icons with a transform-only spinner", () => {
  const runningRule = stylesheet.match(
    /\.session-status-running\s*\{([\s\S]*?)\}/,
  )?.[1] ?? "";

  expect(runningRule).toContain(
    "animation: sidebar-session-status-spin 900ms linear infinite;",
  );
  expect(runningRule).toContain("will-change: transform;");
  expect(stylesheet).toContain(".project-session-status-running");
  expect(stylesheet).toContain("@keyframes sidebar-session-status-spin");
  expect(stylesheet).toContain("transform: rotate(360deg);");
});

test("does not animate xterm scrollbar opacity in terminal views", () => {
  const scrollbarRule = stylesheet.match(
    /\.terminal-host \.xterm \.xterm-scrollable-element > \.visible,\s*\.terminal-host \.xterm \.xterm-scrollable-element > \.invisible\.fade\s*\{([\s\S]*?)\}/,
  )?.[1] ?? "";

  expect(scrollbarRule).toContain("transition: none;");
});

test("keeps the Inbox detail title compact", () => {
  const titleRule = stylesheet.match(
    /\.agents-detail-title\s*\{([\s\S]*?)\}/,
  )?.[1] ?? "";

  expect(titleRule).toContain("font-size: 1rem;");
});

test("defines project sidebar unread and action selectors", () => {
  expect(stylesheet).toContain(".project-sidebar");
  expect(stylesheet).toContain(".project-session-row[data-unread=\"true\"]");
  expect(stylesheet).toContain(".project-create-agent");
  expect(stylesheet).toContain("prefers-reduced-motion: reduce");
});

test("dims read waiting project sessions without attention", () => {
  const waitingRule = stylesheet.match(
    /\.project-session-row\[data-state=\"waiting\"\]\[data-unread=\"false\"\]:not\(\[data-attention=\"true\"\]\)\s+\.project-session-select > \*\s*\{([\s\S]*?)\}/,
  )?.[1] ?? "";

  expect(waitingRule).toContain("opacity: 0.78;");
});

test("uses the sidebar blue, green, and yellow lifecycle palette", () => {
  expect(latestRule(".project-session-status-running", "color: #60a5fa;")).toContain(
    "color: #60a5fa;",
  );
  expect(latestRule(".project-session-status-waiting", "color: #4ade80;")).toContain(
    "color: #4ade80;",
  );
  expect(latestRule(".project-session-status-blocked", "color: #fbbf24;")).toContain(
    "color: #fbbf24;",
  );
});

test("keeps project names concise while retaining readable emphasis", () => {
  const headingRule = stylesheet.match(
    /\.project-sidebar-header h2\s*\{([\s\S]*?)\}/,
  )?.[1] ?? "";

  expect(headingRule).toContain("color: var(--foreground);");
  expect(headingRule).toContain("font-size: 0.7rem;");
  expect(headingRule).toContain("font-weight: 650;");
});

test("keeps project session rows flush with the project list", () => {
  const rowRule = stylesheet.match(
    /\.project-session-row\s*\{([\s\S]*?)\}/,
  )?.[1] ?? "";

  expect(rowRule).toContain("margin-left: 0;");
});

function latestRule(selector: string, requiredDeclaration?: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rules = [
    ...stylesheet.matchAll(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "g")),
  ];
  return rules
    .map((rule) => rule[1])
    .reverse()
    .find((body) => !requiredDeclaration || body.includes(requiredDeclaration)) ?? "";
}

test("renders pane splits as one gray line with a light-gray hover state", () => {
  const splitRule = latestRule(
    ".terminal-pane + .terminal-pane",
    "border-left: 1px solid var(--border);",
  );
  expect(splitRule).toContain("border-left: 1px solid var(--border);");
  expect(splitRule).not.toMatch(/border-(top|right|bottom):/);

  const hoverRule = latestRule(".terminal-pane + .terminal-pane:hover");
  expect(hoverRule).toContain("border-left-color: #737373;");
});
