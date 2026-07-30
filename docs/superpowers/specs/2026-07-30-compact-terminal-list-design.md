# Compact Terminal List Design

## Goal

Reduce the vertical space consumed by the terminal navigation so it has the
compact rhythm of the Codex app reference while preserving Euphony's existing
status, cwd, selection, attention, and pin behavior.

## Chosen Approach

Keep the current three-level navigation structure and tighten only the
component-specific spacing in `web/src/styles.css`. Terminal rows become
32 CSS pixels tall, while status and cwd headings use 24–26 pixel rhythms.
Vertical gaps and padding between nested groups are reduced without changing
the existing 8 pixel indentation at each hierarchy level.

This is preferred over changing the shared shadcn sidebar primitives, which
would affect unrelated sidebar controls, or flattening the hierarchy, which
would remove useful status and cwd context.

## Visual Direction

Retain Euphony's black terminal chrome, Geist typography, amber pinned
checkboxes, attention dot, and white active-row rail. The list should feel
denser through disciplined spacing rather than smaller, harder-to-read text.
Selected rows keep their existing restrained rectangular surface.

## Interaction and Accessibility

All checkbox, row selection, pinning, hover, focus, delete, and mobile drawer
behavior remains unchanged. Checkbox controls stay 16 CSS pixels square so
their target remains legible within the more compact rows.

## Verification

- A Playwright regression test measures a real terminal row and requires it to
  be no taller than 32 CSS pixels at the default 16 pixel interface font size.
- The existing Playwright hierarchy test continues to require exactly 8 pixels
  of indentation per level.
- Component tests, type checking, production build, and the full one-worker
  Playwright suite remain green.
