# Terminal WebGL Renderer Design

## Problem

The terminal currently uses xterm.js's DOM renderer. The renderer measures cell
widths through DOM layout during writes, which can force synchronous style and
layout work once per rendered row or glyph. A trace from the running Euphony
web client shows this path dominating the renderer main thread while Japanese
text, symbols, and emoji are written.

## Goal

Use xterm.js's WebGL renderer as the default rendering path for Euphony
terminals so normal terminal output no longer depends on the DOM renderer's
per-cell width measurement. Keep the current terminal behavior and preserve a
working DOM renderer fallback when WebGL cannot be initialized.

## Non-goals

- Do not add a user-facing renderer setting.
- Do not change terminal sizing, history replay, WebSocket messages, selection,
  links, colors, or keyboard behavior.
- Do not remove the existing xterm CSS or DOM renderer support.
- Do not claim a benchmark improvement without a fresh browser trace.

## Approaches considered

1. **Make WebGL mandatory.** This has the smallest runtime branch but causes
   terminals to fail on browsers, GPU configurations, or embedded shells that
   do not expose a usable WebGL context.
2. **Try WebGL and retain DOM fallback.** This keeps the existing rendering
   contract and makes the performance improvement opt-in only at runtime. It is
   the selected approach.
3. **Add a renderer preference.** This would support debugging and manual
   switching, but adds settings, persistence, UI, and more combinations without
   being required to fix the observed regression.

## Design

### Dependency and renderer setup

Add `@xterm/addon-webgl` to `web/package.json` and the lockfile. After the
existing `Terminal.open(element)` call, construct and load a `WebglAddon`.
Loading happens after `open` because xterm must have a mounted render surface
before an addon can activate.

The WebGL load is isolated behind a small helper so its success and failure
behavior can be tested without constructing a real browser terminal. If addon
construction or loading throws, log a warning and leave xterm's DOM renderer
active. The helper must not throw to its caller.

### Lifecycle

The WebGL addon is loaded into the same xterm instance as `FitAddon`. The
existing `terminal.dispose()` call remains the single cleanup path; xterm
disposes loaded addons when the terminal is disposed. No React state or effect
dependency changes are needed, so renderer initialization does not reconnect a
terminal or alter resize negotiation.

### Test strategy

- Unit test the renderer helper's success path: it creates/loads exactly one
  addon.
- Unit test the failure path: an addon creation or load error is caught, a
  warning is emitted, and the fake terminal remains usable.
- Run the existing `TerminalView` unit suite to prove the injected terminal
  driver contract and lifecycle behavior remain unchanged.
- Run TypeScript type checking and the production Vite build.
- Run the relevant Playwright terminal reliability scenario when the local
  Euphony server is available; inspect the rendered terminal for a normal
  output path and rely on the unit fallback test for environments without
  WebGL.

## Acceptance criteria

1. A normal Chromium session attempts to load `WebglAddon` after opening each
   terminal.
2. A WebGL initialization failure does not prevent the terminal from opening
   or receiving output.
3. Existing unit tests remain green, and the new helper tests cover both
   success and failure.
4. `npm run typecheck` and `npm run build` succeed.
5. No unrelated files or existing user changes are modified.
