# Auto-Select Attention Terminals Design

## Goal

Automatically add terminals to the selected workspace when they newly need
attention, while keeping focus and attention acknowledgement under explicit
user control.

## Behavior

Settings gains an **Auto-select attention terminals** checkbox. It is enabled
by default for new and migrated installations.

When enabled, every terminal that transitions from `needsAttention: false` to
`needsAttention: true` during a session poll is added to the selected terminal
IDs. Existing selected and pinned terminals remain selected. Status and
working-directory filters remain active, and an automatically added terminal
is treated as an independent selection so a later filter update does not
remove it.

Automatic selection never changes `focusedID`. Attention is acknowledged only
by the existing focus-driven acknowledgement flow. If the user disables the
setting, notifications and sounds continue unchanged but attention transitions
do not change the workspace selection.

## Settings Persistence

`session.Settings` and the web `Settings` interface gain an
`autoSelectAttention` boolean. SQLite stores it as a non-null integer column
with a default value of `1`. The migration adds the column with the same
default so existing installations opt in.

The settings API accepts and returns the boolean. JSON decoding continues to
reject unknown fields, and the existing numeric and shortcut validation is
unchanged.

## User Interface

The existing Settings dialog adds one horizontal shadcn `Field` containing a
controlled `Checkbox`, label, and concise description:

- Label: **Auto-select attention terminals**
- Description: **Add them to the workspace without moving focus.**

The checkbox uses a draft value while the dialog is open. Cancel discards the
draft; **Save settings** persists it with the other settings.

No new visual language is introduced. The control follows the existing field
spacing, typography, and checkbox treatment.

## State Flow

The polling effect detects attention transitions and records their terminal
IDs. The existing workspace-selection effect consumes those pending IDs after
the session state updates:

1. Ignore and clear pending IDs when the setting is disabled.
2. Add each available pending ID to `selectedIDs` without duplication.
3. Remove the IDs from dynamic-filter ownership.
4. Preserve `focusedID`, pinned IDs, and filter selections.
5. Replace the workspace URL so reload restores the expanded selection.

This consumption lives alongside the existing agent-launch and dynamic-filter
selection logic to prevent competing effects from overwriting each other's
workspace updates.

## Testing

- SQLite tests cover the default-on value, persistence of `false`, and
  migration of legacy settings.
- Settings API tests cover the default and both boolean values.
- React tests prove that an attention transition adds the terminal without
  moving focus or acknowledging it, and that disabling the setting prevents
  automatic selection.
- Settings dialog tests prove the checkbox defaults on and persists an
  unchecked value.
- Playwright verifies the visible settings control and the no-focus selection
  behavior through the running application.

## Product Rule

Automatic attention selection must never move focus. The user must focus a
terminal explicitly before its attention state is acknowledged.
