# Auto-Deselect Running Agent Design

## Goal

Add a persisted Settings option that removes a selected terminal from the
workspace when its identified agent transitions into `running`. The option is
enabled by default so terminals actively doing agent work do not remain in the
user's workspace unless the user disables the behavior or pins the terminal.

## Behavior

Settings gains an **Auto-deselect running agent terminals** checkbox. It is
enabled for new and migrated installations.

The browser detects a transition using two session snapshots. A session is
eligible when it has an identified agent, its next `agentStatus` is
`"running"`, and its previous `agentStatus` was not `"running"`. A session
that is already running on the initial snapshot does not trigger the option,
and repeated running snapshots do not trigger it.

When the option is enabled, every eligible ID is removed from the selected
terminal IDs unless it is pinned. If the focused ID is removed, focus moves to
the first remaining selected terminal; if none remain, the workspace becomes
intentionally empty. Active status/CWD filters remain unchanged and continue
to own terminals that match them. Pinned terminals and their filter state are
preserved.

When the option is disabled, the transition is ignored by this feature and the
existing agent-launch selection behavior remains unchanged. Pending transition
IDs are consumed in either case so enabling the option later does not replay an
old transition.

If a plain terminal becomes an identified agent already in `running`, the
running-transition behavior takes precedence over the existing focused-agent
promotion for that same snapshot. This prevents the default setting from
selecting a terminal at the exact moment it should be removed.

## Persistence and API

The shared Settings model gains:

```text
autoDeselectRunning: boolean
```

SQLite stores it as `auto_deselect_running INTEGER NOT NULL DEFAULT 1`. The
migration is additive and idempotent, so existing databases receive the
default-on value. GET and PATCH `/api/settings` expose the field; PATCH
requires the boolean, rejects unknown or incomplete settings as before, and
persists both `true` and `false`.

## UI

The existing Settings dialog adds one horizontal checkbox field below the
attention-selection option:

- Label: **Auto-deselect running agent terminals**
- Description: **Remove them from the workspace when their agent starts running.**

The control uses the same draft, cancel, save, and error behavior as the
existing attention-selection checkbox. No new visual language or layout system
is introduced.

## State Flow

`applySessionSnapshot` compares the previous and next session lists and stores
eligible IDs in a pending ref. The existing workspace reconciliation effect
consumes those IDs before agent-launch promotion and normal dynamic-filter
reconciliation. It updates React selection state and the URL together; in
shared-selection mode the existing selection write queue persists the same
state to the server.

The transition detector is a pure exported helper so its initial, repeated,
and status-change boundaries are directly testable. Existing agent-launch,
attention, filtering, and intentional-empty-selection behavior remains covered
by its current tests.

## Testing

- SQLite tests cover the default-on setting, persistence of `false`, and
  migration of a legacy settings table.
- Settings API tests cover the default field, both boolean values, and missing
  boolean rejection.
- App tests cover transition detection, default-on deselection, preserving a
  pinned terminal, leaving active filters intact, and the disabled setting.
- Playwright extends the Settings persistence flow and drives a running-agent
  transition through the existing hook API where the browser behavior benefits
  from transport coverage.
- The full Go suite, Web Vitest suite, typecheck, build, and focused Playwright
  tests run before integration.

## Alternatives Considered

### Remove every matching terminal, including pinned terminals

This would make pinning unreliable and conflict with the project's persistent
pin semantics. Pinned terminals therefore remain selected.

### Clear all filters when a running transition occurs

This would make a lifecycle event unexpectedly destroy a user's dynamic
workspace. Filters continue to behave as filters; only direct non-pinned
selection is removed by the setting.

### Infer running from the process state alone

The terminal's process state is already `running` while a shell is active and
cannot distinguish an agent doing work from an ordinary shell. The hook-backed
`agentStatus` transition is the authoritative boundary.
