# Terminal Rename Design

## Goal

Let a user rename the focused terminal from Quick Actions and show that name in
the sidebar. The name must survive reloads and must not erase agent metadata
that is still useful in the agent log.

## Decisions

- Quick Actions exposes `Rename terminal…` whenever at least one terminal is
  selected.
- The target is the focused selected terminal; if focus is unavailable, the
  first selected terminal is used. A multi-pane selection never renames more
  than one terminal.
- The dialog starts with the current terminal `name`. On submit, surrounding
  whitespace is removed and the result must contain 1–80 characters.
- The server stores the terminal `name` and a `customName` marker. The marker
  is needed because unrenamed agent terminals currently display their dynamic
  `agentTitle` or foreground process name. A renamed terminal displays its
  `name` first; unrenamed terminals keep the current display precedence.
- Rename uses `PATCH /api/v1/terminals/{id}` with `{ "name": string }` and
  returns the updated terminal metadata. The existing `terminal.updated` event
  path carries changes to other clients.
- A successful response updates the local React session list immediately, so
  the sidebar changes even when event synchronization is disabled.

## Architecture and data flow

1. Quick Actions resolves the rename target from the current selected/focused
   terminal and opens the existing dialog primitive.
2. The dialog validates the trimmed draft and calls `ApiClient.renameTerminal`.
3. The v1 server validates the name, calls the control service, and the session
   manager persists the metadata through SQLite before emitting `ChangeUpdated`.
4. The response replaces the matching local session. The normal session change
   event and periodic snapshot keep other browser clients synchronized.
5. Sidebar label selection checks `customName` before `agentTitle`,
   `processName`, and the fallback `name`.

## Error handling

- Blank or overlong names are rejected in the dialog before a request and by
  the server as defense in depth.
- A failed request leaves the dialog open, presents the returned error as an
  inline message, and does not mutate the local session.
- Missing terminals use the existing v1 `terminal_not_found` response.
- Existing metadata migration adds `custom_name` with a false default, so
  existing databases keep their current labels.

## Testing

- Session manager tests cover validation, persistence, custom-name state, and
  the normal updated change.
- v1 server tests cover the PATCH contract, returned metadata, invalid names,
  and missing terminals. Schema route tests include the new method.
- API client tests cover the request path, method, body, and envelope parsing.
- App tests cover target selection, dialog validation/failure, successful
  sidebar update without event sync, and renamed-name precedence over an agent
  title.
- The frontend suite and Go suite are run before merge. Playwright is used for
  the user-visible Quick Actions flow when the local test server is available.

