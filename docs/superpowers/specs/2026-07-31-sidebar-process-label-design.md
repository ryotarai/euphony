# Sidebar Process Label Design

## Goal

Refine the cwd-first sidebar so each session row identifies the process that
currently owns the terminal, while agent session titles remain the most useful
label when they are available. Provider-specific Claude and Codex artwork is
not part of the sidebar identity.

## Chosen Approach

Expose a transient processName field in session metadata. The session manager
initializes it from the command used to start or restore the PTY, then samples
the PTY foreground process and updates the field when the process changes. The
sampled value is never persisted because it describes live runtime state.

The React sidebar resolves one display label per session using this order:

1. A non-blank agentTitle.
2. A non-blank processName.
3. The existing session name as a final fallback.

The existing cwd grouping, lifecycle status icon, attention dot, selection,
pinning, deletion, mobile drawer, and cwd-scoped create action remain intact.
Only the provider image imports and markup are removed from SessionNavigation;
agent metadata still drives status and title behavior.

## Runtime Process Sampling

On Unix systems, Session.ForegroundCommand already asks the PTY for its
foreground process group and reads the command line with ps. A small helper
normalizes that command line to an executable name by taking its first field,
removing a login-shell prefix, and applying filepath.Base. The manager samples
running sessions at a bounded interval during List(), outside the manager lock,
and emits a normal terminal update only when the name changes. The sampled
value is not saved in SQLite. Exited and failed sessions have no current
process name and use the fallback session name.

The initial metadata returned by create and restore uses the launched command's
executable name so a new row does not wait for the first list refresh to stop
showing the generic name. Unsupported platforms keep the existing session name
because foreground inspection returns its existing unsupported error.

## Sidebar Structure

~~~text
▾ ~/work/euphony                                      +
    [split]  ◌  Review changes
    [split]  🚫  Permission request
▾ /workspace/shell                                    +
    [split]  ▣  ps
~~~

- The status marker remains the first visual item in each session row.
- A provider icon is not rendered; the row title is the resolved label.
- The attention dot remains at the far right and does not replace status.
- Existing accessible row names keep using the stable session name so
  selection and deletion controls do not become ambiguous when a process title
  changes.

## Error Handling and Compatibility

Process sampling failures are non-fatal and leave the last known value in
place. A blank or unavailable value falls through to the session name. The new
JSON field is optional, is not part of the SQLite schema, and is therefore
backward-compatible with existing databases and API clients.

## Testing

- Go session tests verify command-name normalization, foreground process
  detection, initial process metadata, and manager list refresh behavior.
- Component tests verify provider artwork is absent and label priority is
  agent title, process name, then session name.
- Existing cwd tree, status, attention, mobile, selection, and creation tests
  remain green.
- Playwright verifies the live sidebar label for a plain shell and an agent
  title without relying on provider artwork.

