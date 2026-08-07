# Resume Claude and Codex Sessions Through Bash

## Goal

When Euphony restores a persisted Claude Code or Codex session, start the CLI through `/bin/bash` while preserving the existing resume arguments. Ordinary terminal restoration must continue to use the configured shell unchanged.

## Design

`restoredCommand` will build a Bash login-shell command for known agents:

```text
/bin/bash -lc 'exec "$0" "$@"' codex resume <session-id>
/bin/bash -lc 'exec "$0" "$@"' claude --resume <session-id>
```

The command string uses Bash positional parameters rather than interpolating the session ID into shell source. This keeps the session ID an argument even if it contains shell-significant characters. `exec` replaces the Bash process with the agent after Bash startup, preserving the current PTY wait, termination, and signal behavior while still allowing login-shell initialization to provide the CLI environment.

The fallback for terminals without a recognized resumable agent remains `exec.Command(shell)`. No new fallback or configuration is introduced: if `/bin/bash` cannot start, the existing PTY start error is returned by the restore path.

## Testing

Update `TestRestoredCommandResumesKnownAgents` to assert the Bash command shape, positional arguments, and unchanged configured-shell fallback for both Codex and Claude. The focused session test and the complete Go test suite must pass.

## Scope

Only the restored-agent command construction and its unit test change. No changes to persisted metadata, terminal creation, hook handling, or frontend behavior.
