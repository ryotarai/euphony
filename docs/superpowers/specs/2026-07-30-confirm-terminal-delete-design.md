# Confirm Terminal Deletion Design

## Goal

Require explicit confirmation before a terminal session is deleted from the sidebar.

## Interaction

- Clicking a session's `Delete <name>` action opens a modal titled `Delete terminal?`.
- The dialog identifies the terminal by name and explains that the terminal process will be stopped and cannot be restored.
- `Cancel`, Escape, the close button, and backdrop dismissal close the dialog without calling the delete API.
- `Delete terminal` calls the existing deletion flow for the identified session.
- The destructive action uses the existing destructive button treatment; all other layout and typography reuse the existing dialog system.

## Architecture

`App` owns the pending session because it already owns session state and the delete API workflow. `SessionNavigation` continues to report the selected session through `onDelete`, but `App` stores that session instead of deleting immediately. The confirmation dialog invokes the unchanged `deleteSession` function and clears the pending state after deletion completes.

## Accessibility

The existing Base UI dialog provides modal semantics, focus trapping, Escape handling, focus restoration, and labelled title/description relationships. The cancel button receives initial focus so pressing Enter immediately after opening cannot destroy the terminal.

## Error Handling

API failures continue to use the existing workspace alert. The dialog closes after confirmation, while the terminal remains visible because the existing deletion flow only removes it after a successful response.

## Testing

An App integration test verifies that opening the dialog does not call the delete API, cancellation preserves the terminal, and explicit confirmation performs exactly one delete request and removes the session. Existing App tests continue to cover selection fallback after deletion.
