# Euphony TODO Cleanup Design

## Scope

Implement every item in the active section of `Euphony TODO.md` and leave the
`Pending` section unchanged. The active items cover public automation removal,
Tasks removal, internal pane naming, empty-session labeling, richer agent-log
media, and filtering Codex context that was injected by the runtime rather
than authored by the user.

## Public API and CLI removal

The browser-facing `/api/*` contract remains because the shipped web app uses
it. The external automation contract is the `/api/v1/*` surface, its OpenAPI
schema, Unix-socket transport, and automation subcommands. Remove those
surfaces and their clients, handlers, tests, and documentation.

Keep the narrow `euphony setup` and `euphony hook <agent> <status>` commands:
they install and invoke the agent integration used by the browser application,
and are not the external automation interface. The server continues to expose
its browser HTTP listener, but it no longer starts a second Unix listener.

## Tasks removal

Remove the Tasks dashboard, navigation, client methods and types, `/api/tasks`
handlers, service, storage implementation, and tests. Do not add a destructive
database migration; existing task tables may remain inert in old databases.
The Inbox and terminal workspace remain available.

## Internal pane names

Expose stable, non-user-facing `data-pane-name` attributes for the three
primary surfaces:

- `agent-list`: the left session/project navigation surface
- `information-pane`: the session information surface
- `terminal-pane`: the terminal workspace surface

Document these names in `AGENTS.md`; no visible label or accessible name is
changed.

## Agent-log media and filtering

Transcript parsing emits a `media` entry for supported image and video blocks.
The normalized entry contains the media kind, a safe HTTP(S) or data URL, an
optional MIME type, and an accessible alt label. Support Claude `image` and
`video` source blocks and the common Codex Responses `input_image`,
`output_image`, `input_video`, and `output_video` blocks. Invalid or oversized
media is skipped rather than making the transcript endpoint fail.

The web Agent Log renders image entries as responsive images and video entries
as controllable, metadata-preloaded videos. Text, thinking, and tool grouping
behavior remains unchanged.

Codex user messages containing the runtime's `<environment_context>...</environment_context>`
or `# AGENTS.md instructions for ... <INSTRUCTIONS>...</INSTRUCTIONS>` payloads
are omitted. Ordinary user messages remain visible.

## Verification

Add parser tests for media normalization and injected-message filtering, API
serialization coverage through the existing transcript endpoint, and browser
component tests for image/video rendering. Run focused tests first, then the
full Go and web unit suites, typecheck, and production build. Playwright is
used for the final UI smoke coverage when the local test harness is available.
