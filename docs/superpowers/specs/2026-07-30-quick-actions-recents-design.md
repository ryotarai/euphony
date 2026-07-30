# Quick Actions Recents Design

## Goal

Make repeated Quick Actions faster to reach by showing the five most recently
executed, currently available actions at the top of the palette. Increase the
palette height so the extra section does not reduce access to the full action
list.

## Behavior

- Record an action only when it is executed, whether by click or keyboard.
- Store at most five unique action values in most-recent-first order in
  `localStorage`, so the list survives a reload in the same browser.
- Ignore malformed stored data and discard stored values whose dynamic action
  no longer exists, such as a removed terminal.
- With an empty query, render available recent actions under `Recent`, then
  render the remaining actions under their existing `Actions` and `Terminals`
  groups. An action appears only once.
- With a non-empty query, omit `Recent` and search all available actions in the
  existing group order.
- Keyboard navigation follows the visible order. Opening the palette selects
  the first visible item, including the most recent item when one exists.

## Layout

Keep the established monochrome command palette, typography, and compact action
rows. Give this Quick Actions dialog a responsive fixed height of up to 40rem
and 80vh, position it with safe viewport margins, and let the command list fill
the remaining space and scroll. Small viewports remain bounded by the viewport.

## Implementation Boundaries

`web/src/App.tsx` owns the recent-value state, persistence, visible grouping,
and execution wrapper because the action catalog is already composed there.
The shared command component remains unchanged; height overrides apply only to
this Quick Actions instance.

## Verification

Vitest will cover ordering, deduplication, five-item truncation, persistence,
stale-value removal, search behavior, and keyboard execution order. Playwright
will verify the rendered dialog is taller, scrollable, and displays `Recent`
above the other groups after an action is executed.
