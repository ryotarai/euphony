# Codex Blocked Status Grace Period Design

## Problem

Codex invokes Euphony's PermissionRequest hook with blocked before an
Auto Approver can approve the request and continue the turn. The session
manager currently publishes that status immediately, marks the terminal as
needing attention, and causes the browser to play its attention sound. A
subsequent running hook can correct the status, but the notification has
already been emitted.

The existing Codex transcript watcher prevents some stale blocked states by
waiting for durable rollout activity after a blocked status is published. It
does not prevent the initial status transition or attention notification.

## Goal

Delay publication of a Codex blocked hook for 10 seconds. If no later agent
hook arrives for the terminal during that period, publish the blocked update
and its normal attention transition. If any later agent hook arrives first,
cancel the pending blocked update and process the later hook normally; the
transient blocked hook must not be observable as a status or notification.

## Scope and non-goals

- Apply the grace period to Codex blocked agent updates, which cover the
  Auto Approver case.
- Keep Claude and non-blocked agent hooks immediate.
- Keep the public hook payload and HTTP response shape unchanged.
- Keep the existing transcript-based Codex activity reconciliation after a
  blocked status has been confirmed.
- Do not add browser timers or change the notification implementation. The
  browser already notifies only when needsAttention transitions to true, so
  delaying the backend transition prevents the sound at its source.

## Design

Add one pending blocked-status watch to each session entry. A watch stores the
original AgentUpdate and a cancellation function. Manager.UpdateAgent
recognizes a Codex update whose trimmed status is blocked, cancels any older
pending watch, starts a new 10-second watch, and returns the current metadata
without saving or emitting a change.

Every other agent hook cancels the pending watch before applying its update.
The timer callback verifies that the session still exists, the manager is not
closing, and the entry still owns the same watch. It then applies the stored
update through the normal metadata/persistence/change path with delayed
classification disabled, so the callback cannot recursively schedule itself.

The default delay is stored on Manager as blockedStatusGracePeriod, with a
production value of exactly 10 * time.Second. Tests may use a short value
without changing the production behavior.

Pending watches are cancelled when a session exits, is deleted, or the manager
closes. A stale timer callback is a no-op when a later hook has already
replaced or cancelled its watch.

## Data flow

~~~text
Codex PermissionRequest hook (blocked)
  -> keep current metadata
  -> start 10s pending watch
  -> later hook arrives: cancel watch, apply later hook
  -> no later hook: apply stored blocked update
       -> set blocked + NeedsAttention
       -> emit change
       -> existing transcript watcher may reconcile durable activity
       -> browser sees the attention transition and may notify once
~~~

## Error and lifecycle handling

- The pending update is never persisted before the grace period completes.
- A later hook is serialized by the existing per-session metadata save lock,
  so it cannot race a timer callback into publishing an obsolete blocked
  update.
- A timer that loses the entry/watch identity check does nothing.
- Store errors use the existing UpdateAgent persistence and change-delivery
  behavior.
- Closing, deleting, or exiting a session cancels the watch so no goroutine can
  publish metadata for a dead entry.

## Testing

Add manager regression coverage for:

1. A Codex blocked hook leaves the current status and attention flag unchanged
   before the delay, then publishes blocked with attention after the delay.
2. A later Codex running hook cancels the pending blocked update, leaving the
   terminal running with no blocked transition or attention notification.
3. Claude blocked hooks retain their existing immediate attention behavior.
4. The existing Codex transcript reconciliation still changes a confirmed
   blocked state to running after durable rollout progress.

Run the focused session tests, the complete Go suite, and the existing web
focused tests/build to confirm that the notification path remains unchanged.
