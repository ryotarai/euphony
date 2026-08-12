import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const stylesheet = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

test("does not animate running status icons forever", () => {
  const runningRule = stylesheet.match(
    /\.session-status-running\s*\{([\s\S]*?)\}/,
  )?.[1] ?? "";

  expect(runningRule).toContain("animation: none;");
  expect(stylesheet).not.toContain("@keyframes session-status-spin");
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

test("keeps project paths aligned to the visible tail", () => {
  const headingRule = stylesheet.match(
    /\.project-sidebar-header h2\s*\{([\s\S]*?)\}/,
  )?.[1] ?? "";

  expect(headingRule).toContain("direction: rtl;");
  expect(headingRule).toContain("text-align: right;");
});

test("keeps project session rows flush with the project list", () => {
  const rowRule = stylesheet.match(
    /\.project-session-row\s*\{([\s\S]*?)\}/,
  )?.[1] ?? "";

  expect(rowRule).toContain("margin-left: 0;");
});
