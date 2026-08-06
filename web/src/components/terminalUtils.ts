import { Terminal } from "@xterm/xterm";
import { defaultTerminalOptionAsAlt } from "../settings";
import type { TerminalCursorStyle } from "../types";

const maxTerminalScrollback = 4294967295;
const maxFiniteTerminalScrollback = 100000;
const estimatedBytesPerScrollbackRow = 128;

export function terminalScrollback(historyLimit: number): number {
  if (historyLimit === 0) return maxTerminalScrollback;
  return Math.max(
    1000,
    Math.min(
      maxFiniteTerminalScrollback,
      Math.ceil(historyLimit / estimatedBytesPerScrollbackRow),
    ),
  );
}

export function openTerminalLink(uri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;

  const newWindow = window.open(parsed.href, "_blank", "noopener,noreferrer");
  if (!newWindow) {
    console.warn("Opening link blocked as opener could not be cleared");
    return;
  }
  try {
    newWindow.opener = null;
  } catch {
    // Some browser shells may reject changing opener.
  }
}

export function terminalOptions(
  fontFamily: string,
  fontSize: number,
  scrollback: number,
  lineHeight: number,
  cursorStyle: TerminalCursorStyle,
  cursorBlink: boolean,
  scrollSensitivity: number,
  optionAsAlt = defaultTerminalOptionAsAlt,
): ConstructorParameters<typeof Terminal>[0] {
  return {
    allowTransparency: false,
    fontFamily,
    fontSize,
    lineHeight,
    cursorStyle,
    cursorBlink,
    linkHandler: {
      activate: (_event, uri) => openTerminalLink(uri),
    },
    macOptionIsMeta: optionAsAlt,
    scrollback,
    scrollSensitivity,
    theme: {
      background: "#050505",
      foreground: "#f5f5f5",
      cursor: "#f5f5f5",
      selectionBackground: "#333333",
      black: "#050505",
      red: "#f87171",
      green: "#a3e635",
      yellow: "#facc15",
      blue: "#93c5fd",
      magenta: "#d8b4fe",
      cyan: "#67e8f9",
      white: "#f5f5f5",
      brightBlack: "#737373",
    },
  };
}

export function terminalElementIsVisible(host: HTMLElement): boolean {
  return !host.hidden &&
    !host.closest("[hidden]") &&
    !host.closest('[aria-hidden="true"]');
}

export function fitTerminalIfVisible(
  host: HTMLElement,
  terminal: Pick<{ fit(): void }, "fit">,
) {
  if (!terminalElementIsVisible(host)) return;
  terminal.fit();
}

export function refreshTerminalIfVisible(
  host: HTMLElement,
  terminal: Pick<{ refresh?(): void }, "refresh">,
) {
  if (!terminalElementIsVisible(host)) return;
  terminal.refresh?.();
}
