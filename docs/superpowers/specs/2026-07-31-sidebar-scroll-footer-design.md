# Sidebar Scroll and Fixed Footer Design

## Problem

When the terminal tree is taller than the viewport, the sidebar grows to the
tree's intrinsic height. The **New terminal** and **Settings** actions then fall
below the viewport instead of remaining available.

Browser measurement identified the cause: the `.desktop-sidebar` rule overrides
the shadcn sidebar container's `position: fixed` and `height: 100svh` utilities
with `position: relative` and `height: 100%`. A 720 px viewport therefore
produces a 1,334 px sidebar container with no overflow in the terminal tree.

## Layout

The sidebar keeps its existing three-part column:

1. The collapse control remains in `SidebarHeader`.
2. `SidebarContent` becomes the single terminal-tree scroll container.
3. **New terminal** and **Settings** remain in `SidebarFooter`, outside the
   scroll container.

The project-specific sidebar styles must not override the shadcn container's
fixed positioning or viewport height. Header and footer are non-scrolling
siblings, while the content area consumes the remaining height with
`min-height: 0`.

## Overflow Fade

`SessionNavigationContent` observes the terminal-tree scroll element. It sets a
`data-overflow-bottom` attribute while:

```text
scrollTop + clientHeight < scrollHeight
```

A small tolerance avoids subpixel rounding errors. CSS applies a bottom mask
only while the attribute is present, fading the final 24 px of terminal-tree
content into the sidebar background. The mask disappears at the bottom so the
last terminal remains fully legible and clickable.

The state is recalculated on scroll, session-list changes, sidebar width or
collapsed-state changes, and `ResizeObserver` notifications. If
`ResizeObserver` is unavailable, scroll and render-driven recalculation still
provide correct behavior.

## Visual Direction

The existing Euphony dark palette, typography, spacing, selection treatment,
and footer controls remain unchanged. The fade is the only new visual element.
It acts as a quiet continuation cue rather than decoration.

## Accessibility

The fade is presentational and introduces no focusable element. Keyboard and
wheel scrolling continue to use the native scroll container. Footer actions
remain in the document's existing navigation order and always stay inside the
viewport.

## Verification

- A Playwright regression creates enough terminals to overflow a 720 px
  viewport, then proves the footer remains inside the viewport and the terminal
  tree is scrollable.
- The regression proves `data-overflow-bottom` is present at the top and absent
  after scrolling to the bottom.
- A component test verifies the overflow-state transition independently of
  browser layout.
- The full web unit suite, typecheck, production build, and the focused
  Playwright regression must pass.
- Screenshots at the top and bottom of the tree confirm the fade and footer
  treatment visually.
