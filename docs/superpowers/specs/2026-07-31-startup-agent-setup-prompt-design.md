# Startup Agent Setup Prompt Design

## Goal

When Euphony starts interactively, detect supported coding-agent hooks or the
bundled `euphony-annotate` skill that are missing or outdated and offer to
install them. Respect a declined offer permanently and explain how to run the
manual setup command later.

## Scope

- Check Codex and Claude Code only when their executables are present on
  `PATH`, matching the existing `euphony setup` behavior.
- Run the check only for the default server command, not for hooks, automation
  subcommands, or `euphony setup`.
- Prompt only when standard input is an interactive character device so
  service and redirected launches cannot block.
- Preserve the existing explicit `euphony setup` command and installation
  format.

## Detection

The `internal/setup` package exposes a read-only inspection operation alongside
`Install`. For every supported agent on `PATH`, inspection verifies:

- every expected lifecycle event contains the exact hook command for the
  current Euphony executable;
- Codex has `hooks = true` in its `[features]` configuration;
- the installed `euphony-annotate/SKILL.md` bytes exactly match the bundled
  skill.

Any missing or different item marks that agent as needing setup. Existing
unrelated settings, hooks, and skills remain irrelevant to this decision and
are preserved by the existing installer.

## Startup Interaction

Before creating the server, an interactive launch with pending setup prints:

```text
Euphony can install coding-agent integrations:
  Hooks: report agent status and session metadata to Euphony.
  Skill: lets coding agents ask you to annotate Markdown and HTML files in Euphony.
Existing agent settings are preserved.
Euphony hooks or skills are missing or outdated. Install them now? (Y/n) 
```

An empty response, `y`, or `yes` runs the existing idempotent installer. `n` or
`no` skips installation, writes the opt-out marker, and prints:

```text
Skipped. Run 'euphony setup' to install hooks and skills later.
```

Other input prints a short English validation message and asks again.

The explicit `euphony setup` command prints the same explanation before it
installs anything. This gives the user purpose and preservation context whether
setup begins automatically or manually.

The marker lives at
`~/.local/euphony/setup-prompt-declined`. Once present, startup inspection and
the prompt are skipped permanently, including after a later manual setup. The
explicit setup command remains available but does not remove the marker, which
preserves the user's "do not ask again" preference.

## Error Handling

Hook or skill inspection and optional installation are not prerequisites for
the Euphony server. Read, parse, or write failures are logged as warnings and
server startup continues. Failure to write the opt-out marker is also reported;
because the preference could not be persisted, a later interactive launch may
ask again.

## Testing

- Setup package tests create isolated Codex and Claude homes and prove that
  inspection reports missing, current, and outdated skill states without
  modifying files.
- Command tests exercise the accept/default, decline/persisted suppression,
  invalid-response, and setup-error paths using in-memory input/output and
  temporary homes.
- Existing setup idempotency tests continue to protect settings preservation.
- The full Go test suite and build verify integration.
