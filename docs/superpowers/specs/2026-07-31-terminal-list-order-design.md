# Terminal List Ordering Design

## Goal

Order terminal rows in the existing cwd-first sidebar by user attention and
lifecycle priority: Need attention, Blocked, Waiting, Running, then Terminal.

## Scope

This is a presentation-only change inside `SessionNavigation`. The cwd-first
tree, cwd heading order, status icons, attention semantics, selection controls,
API responses, and backend ordering remain unchanged.

## Design

`groupSessionsByCwd` keeps cwd groups in their existing first-seen order and
sorts the sessions inside each group with an explicit priority function:

1. `needsAttention === true`
2. `blocked`
3. `waiting`
4. `running`
5. `terminal`

Unknown lifecycle values sort after the built-in statuses. `needsAttention`
remains independent from `activity(session)`: it changes row order only and
does not replace the lifecycle status shown by the row icon. Equal-priority
rows retain their input order.

## Testing

Add a component regression test with all five categories in one cwd and assert
the rendered session button order. Run the focused component suite, the full
web unit suite, TypeScript type checking, the production build, and the
single-worker Playwright suite when dependencies and the local backend are
available.
