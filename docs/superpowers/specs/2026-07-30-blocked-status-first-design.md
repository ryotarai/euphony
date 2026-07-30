# Blocked Status First Design

## Goal

Show the `Blocked` session group above every other status group in the terminal
sidebar so sessions that cannot make progress are immediately visible.

## Scope

The change is limited to the existing client-side status ordering in
`SessionNavigation`. Labels, status detection, attention handling, filters,
session ordering within a group, and backend responses remain unchanged.

## Design

Add `blocked` as the first entry in the existing explicit activity priority
map. Move the current priorities down while preserving their relative order:

1. Blocked
2. Need attention
3. Running
4. Waiting
5. Terminal
6. Any other status, sorted alphabetically

This keeps ordering policy beside the sidebar rendering code and avoids
changing API semantics for a presentation-only requirement.

## Testing

Extend the existing ordered-status component test with a blocked session and a
literal expected heading sequence. The test must fail before the priority map
changes and pass afterward. Run the focused component test, the full web unit
suite, type checking, and the production build.
