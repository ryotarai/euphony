# Sidebar Terminal Update Order Design

## Goal

Make the left terminal sidebar surface the most actionable and recently
changed sessions first: Need attention, Blocked, Running, Waiting, then the
remaining terminal states. Within each priority, the session with the newest
last metadata update appears first.

## Scope

This is a presentation-oriented change backed by one new session metadata
timestamp. The existing cwd-first grouping, attention semantics, lifecycle
icons, selection behavior, and backend session list order remain unchanged.

The timestamp covers persisted session metadata changes such as agent status,
attention, title, cwd, process label, and rename changes. Terminal output by
itself does not change metadata and therefore does not reorder a row.

## Design

Add `UpdatedAt` / `updatedAt` to session metadata. New sessions initialize it
to their creation time. The manager stamps every `ChangeUpdated` metadata
change immediately before publishing and persisting the change. The SQLite
store persists the value in `updated_at`; existing databases receive the new
column with an empty default, and an empty legacy value reads as `createdAt`.

The sidebar keeps the current explicit priority map:

1. `needsAttention === true`
2. `blocked`
3. `running`
4. `waiting`
5. `terminal`
6. any other lifecycle value

The comparator first compares that priority and then compares the effective
update timestamp descending. A missing or invalid client timestamp falls back
to `createdAt`, and equal timestamps retain the input order through the
existing stable array sort. Attention remains an independent flag and does
not replace the lifecycle status shown by the row icon.

## Testing

Add a component regression test with multiple sessions in each requested
priority and intentionally mixed input order. Assert that rows are ordered by
attention/status first and newest `updatedAt` within each group. Add backend
tests that verify manager updates stamp `UpdatedAt`, SQLite round-trips the
timestamp, and legacy databases fall back to `CreatedAt`.

Run the focused Go and web tests, the full Go suite, the focused web suite,
web type checking, the production build, and the single-worker Playwright
suite when the local environment permits it. Record any unrelated baseline
failures separately from this change.
