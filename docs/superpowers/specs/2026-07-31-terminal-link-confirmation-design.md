# Terminal Link Confirmation Design

## Goal

Open safe OSC 8 hyperlinks from Euphony terminals without showing xterm.js's
default confirmation prompt.

## Scope and behavior

- Clicking an HTTP or HTTPS hyperlink opens it in a new browser tab.
- The link activation path does not call `window.confirm`.
- The new window's `opener` is cleared before navigation, matching xterm.js's
  existing safe default for opening external links.
- Invalid URLs and non-HTTP(S) protocols remain blocked. The xterm.js link
  provider already filters these protocols, and the custom handler repeats the
  validation as defense in depth.
- No settings toggle or new UI is introduced; the requested behavior is the
  terminal's single default link behavior.

## Approaches considered

1. **Configure xterm.js `linkHandler` (recommended).** Supply the existing
   OSC 8 link handler option and perform direct, validated navigation. This
   changes only the default activation behavior while preserving xterm.js's
   link parsing and protocol filtering.
2. **Register a replacement link provider.** Reimplement OSC 8 range parsing
   and activation. This would duplicate xterm.js internals and increase the
   risk of diverging behavior across xterm.js upgrades.
3. **Disable OSC 8 links.** Prevent the prompt by removing link activation,
   but this would also remove the requested navigation capability.

## Implementation

`web/src/components/TerminalView.tsx` will expose a small link-opening helper
for unit testing. `defaultTerminal` will pass an object with an `activate`
callback through the `linkHandler` option. The helper will parse the URI,
allow only `http:` and `https:`, open a blank tab, clear its opener, and set
the destination. Popup blocking will remain non-fatal and will produce the
same warning style as xterm.js's default implementation.

## Testing

- Vitest will verify that an HTTP(S) link opens without invoking
  `window.confirm`, clears the popup opener, and navigates to the requested
  URL.
- Vitest will verify that invalid and non-HTTP(S) links do not open.
- The production build and full frontend test suite will pass.
- A Playwright scenario will emit an OSC 8 link in a real terminal, click the
  rendered link, and assert that a popup opens directly without a browser
  confirmation dialog.
