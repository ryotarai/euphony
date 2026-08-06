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
