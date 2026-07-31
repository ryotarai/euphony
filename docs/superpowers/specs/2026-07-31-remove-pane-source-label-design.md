# Remove Pane Source Label Design

## Goal

Hide the decorative pane-source text shown at the right side of the source
rail, including combined labels such as `Terminal + Workspace files`.

## Scope

- Make only the visible source-name label transparent in the pane rail.
- Keep source tabs, split-source behavior, attention state, and the pane
  selection checkbox unchanged.
- Keep `sourceLabel` because it provides accessible names for split regions.
- Keep the label's layout footprint because removing it changes transcript
  wrapping and breaks scroll-position preservation.
- Keep the label excluded from the accessibility tree with `aria-hidden`.

## Verification

Update the split-source component test to assert that the decorative text is
not visible while the primary tab, secondary split, and resize separator
remain available. Run the focused component test, the full web test suite, the
typecheck, the transcript scroll-position end-to-end test, and a Playwright
browser check.
