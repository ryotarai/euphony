# Sidebar Collapse Layout Design

## Goal

Make a collapsed desktop sidebar release all of its layout width, keep an
on-screen control for restoring it, and toggle the same state with Command-B
without intercepting Control-B.

## Root Cause

`SidebarProvider` correctly renders as `display: contents`, and the off-canvas
sidebar gap reaches zero width. However, the outer desktop `Sidebar` element is
itself the promoted workspace grid item. Chrome keeps that grid item at the
previous sidebar width even though its in-flow gap child is zero-width. A
Playwright diagnostic measured the provider at zero, the gap at zero, and the
outer sidebar grid item at 420px.

The only desktop trigger currently lives inside the fixed sidebar container.
Collapsing moves that container and its trigger to a negative horizontal
position. Playwright still considers the off-screen element visible because it
is rendered and has dimensions, so the existing assertion does not catch the
missing on-screen control.

## Design

Keep the current shadcn off-canvas sidebar and persisted `sidebarCollapsed`
setting. Give the provider wrapper a dedicated Euphony class and explicitly
transition its outer desktop sidebar child between the configured width and
zero. When collapsed, render a second `SidebarTrigger` outside the off-canvas
container. Position it at the left edge of the pane tab bar and add matching
tab-bar inset so it never overlaps the Terminal tab.

Use the provider's existing `toggleSidebar` state path for both buttons and the
keyboard shortcut. Configure the shortcut as Command-B only: require
`event.metaKey`, reject Control, Alt, and Shift modifiers, and prevent the
browser's default action. Control-B remains available to Euphony's configurable
terminal prefix handling.

This is a behavior repair, not a visual redesign. It retains the existing black
workspace palette, Geist interface typography, compact square controls, and
current sidebar animation.

## Accessibility

The external control is a real button labelled `Expand sidebar`, reports
`aria-expanded="false"`, and advertises `Meta+B` through
`aria-keyshortcuts`. The in-sidebar control advertises the same shortcut.
Keyboard focus remains on the invoking element unless the browser naturally
moves it after the off-canvas transition.

## Verification

- Component test: collapse by click, expand with Meta-B, collapse again with
  Meta-B, and prove Control-B does not alter sidebar state.
- Playwright test: after collapse, assert the terminal stage starts at the
  viewport's left edge, its width equals the viewport width, and the external
  expand button's bounding box is fully inside the viewport.
- Playwright test: assert Meta-B toggles collapse and expand while Control-B
  continues to open the configured prefix-command guide.
- Run the complete Web unit suite, typecheck, production build, Go suite, and
  one-worker end-to-end suite with an in-memory database.
