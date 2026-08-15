# Project Terminal Creation Error Details

## Goal

When a project terminal cannot start, the user should see the actionable
underlying process-start failure instead of only the generic project-terminal
message. This is especially important for Windows ConPTY and executable
lookup failures.

## Design

The v1 terminal-creation endpoint keeps its stable error code and top-level
message, but places the underlying creation error in `error.details.cause`.
The cause is the existing Go error string produced at the terminal startup
boundary, so platform-specific information such as a Windows process or
ConPTY error is preserved without changing success responses or validation
errors.

The Web API client parses the optional `cause` detail and appends it to the
human-readable `ApiError.message`. Existing errors without a cause retain
their current message. The project-agent startup flow also stops replacing a
failed `createSession` error with a second generic message; `createSession`
already records the formatted error in the workspace alert.

## Error flow

```text
terminal startup error
  -> POST /api/v1/terminals
  -> error { code, message, details: { cause } }
  -> ApiError.message includes cause
  -> workspace alert displays the cause
```

## Scope and safety

- Only the terminal creation failure branch exposes the underlying cause.
- Validation messages remain stable and do not include implementation errors.
- No new logging, persistence, or frontend layout is required.
- The tests exercise the HTTP endpoint, API parsing, and project-agent UI
  behavior at their public boundaries.
