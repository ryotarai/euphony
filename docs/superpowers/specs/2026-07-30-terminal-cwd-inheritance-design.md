# Terminal CWD Inheritance Design

## Goal

New terminals start in the working directory of the currently focused terminal.
When there is no focused terminal whose working directory can be inherited,
terminal creation falls back to the user's home directory.

## Behavior

- Sidebar creation, the empty-state action, and prefix commands use the focused
  terminal's current `cwd` when one exists.
- Vertical splits inherit the same focused terminal `cwd`.
- The explicit directory dialog continues to seed its input from the focused
  terminal and sends the directory entered by the user.
- Automatic creation for an empty session list has no source terminal and
  therefore uses the backend default.
- A creation request without a `cwd` starts in `os.UserHomeDir()`, not the
  Euphony server process's working directory.
- An explicitly supplied missing or non-directory `cwd` remains a validation
  error. The home fallback applies only when no inherited directory is
  available; it must not hide an invalid directory entered by the user.

## Architecture

`App` owns the focused terminal ID and loaded session metadata, so it derives
the inherited `cwd` at the creation boundary and passes it to `ApiClient`.
`Manager.Create` remains the authoritative backend default and resolves the
home directory when the request omits `cwd`.

No new API fields or UI controls are needed. The existing optional `cwd`
contract already distinguishes inherited creation from fallback creation.

## Error Handling

If the backend cannot resolve the user's home directory, creation returns that
resolution error through the existing request-error path. Explicit invalid
directories retain the existing stable validation error.

## Testing

- React component tests verify that sidebar and prefix create/split actions
  send the focused terminal's literal `cwd`.
- A Go manager test changes the process working directory away from a
  test-specific home directory, creates a session without `cwd`, and verifies
  that metadata records the home directory.
- Existing App and manager suites protect explicit directory selection and
  invalid-directory validation.
