# Command-K Only Quick Actions Design

## Goal

Open Quick Actions with Command+K, and allow Control+K to continue to the
focused terminal without opening the dialog.

## Context and Root Cause

The global Quick Actions keydown handler currently accepts either `metaKey` or
`ctrlKey` when the pressed key is `K`. On macOS, that makes Control+K collide
with terminal input even though Quick Actions is intended to use Command+K.

## Approaches

1. Restrict the existing handler to `metaKey`. This is the recommended option
   because it fixes the source condition without changing keybinding
   architecture or UI.
2. Introduce a reusable shortcut-matching helper. This would centralize modifier
   handling, but a one-off helper would add indirection without serving another
   current caller.
3. Add a configurable Quick Actions shortcut. This would expand settings,
   persistence, and conflict handling far beyond the requested correction.

## Design

The window-level handler will return unless the pressed key is `K` and
`event.metaKey` is true. Its existing dialog initialization and focus behavior
will remain unchanged.

No visual treatment, copy, persistence, API, or terminal behavior will change.
Control+P and Control+N will continue to navigate after Quick Actions is opened
with Command+K.

## Verification

A React behavior test will press Control+K and assert that Quick Actions remains
closed, then press Command+K and assert that the dialog opens. A Playwright test
will repeat the same browser-level interaction against the built application.
The frontend unit suite, typecheck, build, and focused end-to-end test will run
before completion.
