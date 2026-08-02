# Delete Selected Terminals Quick Action Design

## Goal

Add a Quick Actions command that lets users delete all currently selected terminal panes in one confirmed operation.

## Requirements

- Show `Delete selected terminals` only when at least one selected terminal still exists in the current session list.
- Opening the command must not delete anything.
- Reuse the existing destructive confirmation dialog pattern.
- Use a count-aware confirmation message for multiple terminals while preserving the existing single-terminal wording.
- Delete selected terminals through the existing terminal deletion API, one at a time, in a stable order.
- In shared-selection mode, apply the latest server selection snapshot returned by the deletion sequence.
- If a later deletion fails, keep successful deletions applied locally and show the existing request error.
- Do not add a backend bulk endpoint or change the Quick Actions visual language.

## Approach

The Quick Actions catalog derives a `selectedSessions` snapshot by intersecting `selectedIDs` with `sessions`. The new action is added to the existing `Actions` group only when that snapshot is non-empty. Its `run` handler closes Quick Actions and stores the snapshot in the pending-delete state.

The pending-delete state changes from one `Session` to a non-empty list of `Session` values. The existing sidebar delete callback supplies a one-item list, so the current single-terminal behavior remains on the same path. The dialog chooses its title, description, and button text from the list size. Confirmation clears the pending state and starts the sequential deletion loop.

The deletion loop records each successful ID and, for shared selection, the most recent `SelectionSnapshot`. After every item it removes the successful terminal from the local session list. On completion, shared-selection mode applies the last snapshot; URL-selection mode removes successful IDs from the local selection, repairs focus, and retains the existing replacement-terminal behavior only when the workspace would otherwise be empty. A failure exits the loop, keeps prior deletions, and reports the error.

## Interaction and accessibility

- The action label uses the user-facing verb `Delete` and includes the selected count in its detail text.
- The confirmation dialog remains keyboard accessible with `Cancel` focused by default.
- The destructive button is unavailable until the user explicitly confirms through the existing dialog.
- No new keyboard shortcut is introduced; the action is reachable through the existing Quick Actions search and navigation.

## Testing

- Add an App behavior test proving the action is absent without a selected session, opens a count-aware confirmation for multiple selected sessions, does not call delete on cancel, and deletes each selected session after confirmation.
- Add a Playwright scenario using the isolated Euphony test server to verify the user-visible Quick Actions flow and that selected sessions disappear after confirmation.
- Run focused Web tests and type checking, then the broader Web checks and relevant Go checks. Existing unrelated baseline failures must be recorded separately.
