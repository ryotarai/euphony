# Euphony v0.1 Design

## Summary

Euphony v0.1 is a self-contained web interface for running and switching
between terminal-based coding agents. A single Go binary serves an embedded
React application, exposes an authenticated HTTP API, and bridges browser
terminals to local PTY processes over WebSockets.

The first release prioritizes a dependable terminal loop over workspace
orchestration. It supports multiple independent terminal sessions but does not
support split panes, persistence across server restarts, or file management.

## Goals

- Start and stop real local PTY sessions from a browser.
- Stream terminal input and output with resize support.
- Switch between multiple sessions on desktop and mobile.
- Protect HTTP and WebSocket access with one server-configured token.
- Produce one Go binary containing the frontend assets.
- Provide clear states for connection, process exit, and recoverable errors.

## Non-goals

- Split panes or arbitrary terminal layouts.
- Restoring PTY processes after a server restart.
- Multi-user accounts, roles, or shared sessions.
- A file browser, editor, upload flow, or repository management.
- A tmux dependency or a pluggable terminal backend.
- Internet-facing TLS termination. A reverse proxy is responsible for TLS.

## Architecture

The repository contains a Go server and a Vite-powered TypeScript/React
frontend. The frontend build output is embedded with `go:embed` and served by
the Go process. During development, Vite runs separately and proxies API and
WebSocket traffic to Go.

The Go server has four focused units:

1. **Authentication middleware** validates `Authorization: Bearer <token>` for
   HTTP requests and a short-lived WebSocket ticket for terminal connections.
2. **Session manager** owns in-memory session metadata and PTY processes.
3. **Terminal transport** translates typed WebSocket messages into PTY reads,
   writes, and resize operations.
4. **Static application handler** serves embedded frontend assets and falls
   back to `index.html` for client-side routes.

The React application has three primary units:

1. **Authentication screen** accepts a token, exchanges it for API access, and
   stores it in `sessionStorage`.
2. **Session navigation** lists, creates, selects, and terminates sessions.
3. **Terminal workspace** owns the terminal renderer and WebSocket lifecycle.

## Authentication

The server requires a non-empty `EUPHONY_TOKEN` environment variable and
refuses to start without it. All `/api` endpoints require the token as a
Bearer credential.

Browsers store the token only in `sessionStorage`, so closing the tab ends the
browser-side login. The terminal endpoint does not place the long-lived token
in a WebSocket URL. Instead, an authenticated HTTP request creates a
single-use, 30-second ticket scoped to one session. The browser uses that
ticket in the WebSocket connection query string, and the server consumes it
on successful connection.

This is intentionally a single-operator security model. Deployments exposed
outside a trusted network must put Euphony behind HTTPS.

## Session Model

A session has:

- a server-generated opaque ID;
- a user-editable display name;
- a lifecycle state: `starting`, `running`, `exited`, or `failed`;
- creation and exit timestamps;
- an optional exit code and failure message.

Creating a session starts the server's configured shell in a PTY. The initial
terminal size is 80 columns by 24 rows until the browser sends its first resize
message. Sessions remain listed after process exit so the user can read the
exit state, then delete the session. Deleting a running session terminates its
process group before removing it.

PTY output is streamed live and is not retained for later replay in v0.1. A
browser that disconnects can reconnect to a still-running session but only
receives output produced after reconnection.

## API and WebSocket Protocol

HTTP endpoints:

- `GET /api/health` returns server readiness without authentication.
- `GET /api/sessions` returns all session metadata.
- `POST /api/sessions` creates a session from `{ "name": string }`.
- `DELETE /api/sessions/{id}` terminates and removes a session.
- `POST /api/sessions/{id}/tickets` returns a single-use WebSocket ticket.

The WebSocket endpoint is
`GET /api/sessions/{id}/terminal?ticket=<ticket>`.

Client-to-server JSON messages:

- `{ "type": "input", "data": "<utf8 text>" }`
- `{ "type": "resize", "cols": 120, "rows": 40 }`

Server-to-client JSON messages:

- `{ "type": "output", "data": "<utf8 text>" }`
- `{ "type": "exit", "exitCode": 0 }`
- `{ "type": "error", "message": "actionable description" }`

Binary PTY data is converted to UTF-8 text with invalid sequences replaced.
Messages with unknown types, empty input, or terminal dimensions outside
`1..1000` are rejected with an error message. Repeated invalid messages close
the connection.

## Interface Design

### Visual direction

Euphony should feel like a precise instrument, not an administration
dashboard. The visual language draws from audio patch bays: sessions are
channels, connection state is signal state, and navigation is compact without
competing with terminal content.

The palette uses:

- **Carbon** `#111417` for the application shell;
- **Slate** `#1B2026` for navigation surfaces;
- **Phosphor** `#B8F34A` for active signal and keyboard focus;
- **Ice** `#DCE5E8` for primary text;
- **Muted steel** `#829099` for secondary text;
- **Fault** `#FF6B5F` for destructive and failed states.

The UI uses a characterful condensed sans-serif for the Euphony wordmark, a
high-legibility sans-serif for controls, and the terminal renderer's monospace
stack for terminal content. Fonts must be shipped locally or use system
fallbacks; runtime font downloads are not allowed.

The signature element is a thin vertical signal trace in the session rail. It
brightens and subtly pulses only while the selected session is connected.
Reduced-motion users see a static bright trace.

### Desktop

A narrow session rail stays on the left. It contains the product mark, session
buttons, a create-session control, and connection status. The selected
terminal fills the remaining viewport. Session controls use tooltips and
visible focus rings; terminal content is never placed inside a decorative
card.

### Mobile

The terminal occupies the full viewport. A compact top overlay contains the
current session name and hamburger button. The button opens a left drawer
with the same session list and actions as desktop. Opening the drawer traps
focus; Escape, the backdrop, or selecting a session closes it.

The layout respects safe-area insets and uses dynamic viewport units. Touch
targets are at least 44 by 44 CSS pixels.

### Empty and failure states

With no sessions, the workspace shows one direct action: **Start a terminal**.
Connection loss leaves terminal contents visible and shows a reconnect action.
An exited process leaves the terminal visible with its exit code and a
**Start another terminal** action. Authentication failures return to the token
screen without deleting unrelated session metadata from the server.

## Error Handling

- Startup fails with a clear log message when `EUPHONY_TOKEN` is missing.
- API errors use JSON with a stable machine-readable code and human-readable
  message.
- Unknown session IDs return HTTP 404.
- Invalid names and resize values return HTTP or protocol-level validation
  errors.
- PTY startup failure creates no running session and returns HTTP 500.
- WebSocket disconnect does not terminate the PTY.
- Server shutdown closes listeners, terminates managed process groups, and
  waits for cleanup with a bounded timeout.

## Testing

Go tests cover token middleware, ticket expiry and single use, session
lifecycle, PTY input/output, resize validation, deletion, and graceful
shutdown. HTTP and WebSocket tests exercise the public protocol rather than
private implementation details.

React tests cover authentication, empty state, session creation and switching,
 mobile drawer keyboard behavior, exit state, and reconnect behavior. Terminal
rendering and browser sizing receive focused adapter tests; the third-party
terminal renderer itself is not re-tested.

End-to-end verification runs the embedded binary and checks token login,
terminal creation, command input/output, resize, session switching, process
exit, reconnect, and both desktop and mobile viewport layouts.

## Technology Choices

- Go for the API server and PTY ownership.
- TypeScript, React, and Vite for the frontend.
- xterm.js for v0.1 terminal rendering.
- A Go-native PTY library and a standards-compliant Go WebSocket library,
  selected during implementation planning.
- Go's `embed` package for production asset packaging.

ghostty-web remains a future candidate. It is not selected for v0.1 because
the initial release values a stable integration surface and mature browser
ecosystem over renderer experimentation.

## Acceptance Criteria

- A clean checkout can build one executable containing the frontend.
- Starting without `EUPHONY_TOKEN` fails with an actionable error.
- A valid token permits session operations; an invalid token does not.
- A user can create at least three independent sessions and switch among them.
- Terminal input, output, and resize work in a current desktop browser.
- Disconnecting a browser leaves its PTY running and allows reconnection.
- Desktop navigation and the mobile drawer are fully keyboard accessible.
- The active terminal fills the available viewport without document scrolling.
- Automated Go and React test suites pass.
- Manual verification passes at desktop and mobile viewport sizes.

