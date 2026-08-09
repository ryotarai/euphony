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
