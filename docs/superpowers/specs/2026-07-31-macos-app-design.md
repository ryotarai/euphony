# Euphony macOS App Design

## Goal

Package the existing Euphony server and embedded React frontend as a launchable
macOS application. A user should be able to build `bin/Euphony.app`, open it
from Finder, and use Euphony in a native window without manually starting a
server or opening a browser.

The existing `bin/euphony` command remains the supported terminal and browser
entry point. This work adds a macOS desktop entry point without changing the
remote/browser product model.

## Chosen approach

Use a small AppKit application with a `WKWebView` and bundle the existing Go
executable as a private child process inside the app bundle.

Other considered approaches:

1. Wails. Wails is a strong conceptual fit because it uses Go and the native
   OS WebView, and its stable v2 tooling can bundle an embedded frontend. The
   current Euphony frontend, however, depends on WebSockets for terminal
   streams. Wails v2's AssetServer does not support WebSockets, so a v2
   integration would either keep a separate localhost server (making Wails
   mostly a window wrapper) or replace the terminal transport with Wails
   bindings. Wails v3 offers custom transports that can cover this gap, but it
   is currently an alpha release. Adopting either version would therefore
   expand this Mac-only packaging task into a transport migration.
2. Electron or Tauri. These provide a mature desktop shell, but add another
   runtime and build/distribution layer around a project that already has a
   native Go executable. The resulting app would be larger and would duplicate
   process lifecycle responsibilities.
3. A Finder launcher that only opens the default browser. This requires almost
   no code, but does not provide a self-contained Mac window and does not meet
   the desktop-app goal.

The AppKit shell keeps the runtime small, uses WebKit already supplied by
macOS, and lets the existing web UI remain the single product UI.

## Architecture

### Bundle layout

`make macos-app` creates the following ignored build artifact:

```text
bin/Euphony.app/
  Contents/
    Info.plist
    MacOS/Euphony
    Resources/euphony-server
```

The Go executable is built separately as `euphony-server` so the app shell can
launch it without invoking the browser-oriented entry point itself. The app
does not depend on Node.js at runtime.

### App startup

`EuphonyApp.swift` performs these steps:

1. Locate `Resources/euphony-server` through `Bundle.main`.
2. Generate a per-launch access token and a unique readiness-file path in the
   system temporary directory.
3. Launch the server with `EUPHONY_ADDR=127.0.0.1:0`, the generated
   `EUPHONY_TOKEN`, and `EUPHONY_READY_FILE`. The loopback-only address keeps
   the desktop server private to the Mac.
4. Wait asynchronously for the readiness file, verify `/api/health`, and then
   load the tokenized URL in a `WKWebView`.
5. Show a resizable, key, titled window with the existing Euphony UI.

The Go server binds the TCP listener itself before constructing its hook URL.
This allows port `0` to select an unused port while ensuring agent hooks use
the actual selected address. Once the HTTP listener is ready, the server
atomically writes the base URL to `EUPHONY_READY_FILE`. The environment
variable is optional; normal CLI behavior is unchanged.

### App shutdown and failures

Closing or quitting the app terminates the child server and removes the
readiness file. Server output is appended to a per-user log file under
`~/Library/Logs/Euphony/` so a Finder-launched app does not lose diagnostics or
block on an unread pipe.

If the bundled server is missing, exits early, does not publish readiness, or
fails its health check within the startup deadline, the app shows an `NSAlert`
with a concise recovery message and quits after terminating the child.

The app has one window and exits when that window is closed. It provides the
standard application menu with Quit and a Window menu sufficient for normal
macOS keyboard behavior. No new web-side navigation or settings are needed.

## Build workflow

Add a macOS-only `macos-app` Make target backed by a script that:

1. Builds the web assets with the existing frontend command.
2. Builds the Go server binary.
3. Compiles the Swift shell with AppKit and WebKit frameworks.
4. Creates the bundle directories, copies the server, and writes `Info.plist`.

The target checks for `swiftc` and reports an actionable error when run on a
machine without the Xcode Command Line Tools. It does not sign or notarize the
artifact; signing, notarization, icons, and distribution automation remain
future work.

Update the README with the build command, launch command, runtime
requirements, and the distinction between the desktop app and the existing
CLI/browser mode.

## Testing and verification

- Add Go tests for the readiness-file writer and for URL/address behavior when
  the server binds an ephemeral port.
- Keep the existing Go, frontend, CLI, and Playwright test suites unchanged in
  scope and run them through the existing `make test` workflow.
- Type-check the Swift shell with `swiftc -typecheck`.
- Build `bin/Euphony.app` and inspect its bundle structure and `Info.plist`.
- Launch the app binary in a temporary test environment, verify that the
  health endpoint becomes available on the published loopback URL, and ensure
  the child server is terminated when the app exits. The verification must
  avoid the user's normal database and socket by supplying temporary paths.

## Scope boundaries

This iteration does not add code signing, notarization, automatic updates,
App Store packaging, a custom icon, multiple windows, or a native replacement
for the existing React interface.
