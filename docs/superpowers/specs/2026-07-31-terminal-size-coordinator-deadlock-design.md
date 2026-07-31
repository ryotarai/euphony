# Terminal Size Coordinator Deadlock Design

## Problem

`terminalSizeCoordinator` currently holds its process-wide `mu` while it calls
the terminal group's `apply` callback. The production callback is
`Session.ResizeWithNotification`, which waits for the PTY pump to complete the
resize request. A stalled PTY resize therefore blocks every terminal's
subscribe, report, release, and unsubscribe operations, including the initial
control WebSocket setup that must send its resize and history frames.

## Goals

- Keep resize claims and accepted-size notifications serialized per terminal.
- Ensure a blocking PTY resize for one terminal cannot block coordinator
  operations for another terminal.
- Preserve the existing rollback behavior when `apply` returns an error.
- Preserve group cleanup when the last client unsubscribes.
- Add a regression test that fails with the current global-lock design.

## Non-goals

- Change PTY resize timeouts or repair a stalled PTY pump itself.
- Change the smallest-claim policy or WebSocket framing.
- Make concurrent resize requests for the same terminal run in parallel.

## Approaches considered

1. Queue all resize work asynchronously. This would isolate callers but would
   change the existing synchronous error and notification contract, so it is
   out of scope.
2. Drop the coordinator lock around `apply` without another lock. This removes
   the global stall but allows same-terminal resize transactions to overlap and
   breaks claim ordering and rollback.
3. Use a per-group mutex while retaining a short-lived coordinator mutex. This
   preserves same-terminal ordering and confines the blocking wait to one
   terminal. This is the selected approach.

## Design

`terminalSizeGroup` gains a mutex protecting its clients and accepted-size
state, plus an operation reference count. The coordinator mutex protects only
the terminal-ID map and the global client ID counter.

Each coordinator operation first increments the target group's reference count
under the coordinator mutex, releases that mutex, and then locks the group
mutex. It performs all state transitions and the potentially blocking `apply`
call while holding only the group mutex. It finally decrements the reference
count under the coordinator mutex. A group is removed from the map only when
there are no clients and no in-flight operation references.

Subscriptions use the same reference protocol while adding their client under
the group mutex. This prevents a concurrent last-client unsubscribe from
deleting the group while a subscription is being attached. A new subscription
can still acquire the group reference while an older operation is waiting on
the group mutex; it will wait only for that terminal's group, never for the
process-wide coordinator mutex.

The `apply` callback remains synchronous and is still invoked only after the
candidate accepted dimensions have been recorded. On error, the caller rolls
back the client claim and accepted dimensions while holding the group mutex,
then releases its operation reference.

## Invariants

- `terminalSizeCoordinator.mu` is never held while waiting for a group mutex or
  calling `group.apply`.
- A group's clients, accepted dimensions, and accepted-state flag are accessed
  only while holding that group's mutex.
- At most one `apply` callback runs for a terminal ID at a time.
- A group with active operation references remains in the map until all those
  operations finish.
- Existing error messages, dimension validation, and notification behavior are
  unchanged.

## Testing

Add a coordinator unit test that blocks `apply` for terminal A, waits until the
callback starts, and then reports a claim for terminal B with a bounded
timeout. The report for B must complete and publish its dimensions before A is
released. The test must fail before the change because the current global
mutex is held by A. Run the existing terminal-size tests and the full Go test
suite, including the race detector for the affected package.
