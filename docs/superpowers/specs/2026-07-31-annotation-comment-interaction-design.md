# Annotation Comment Interaction Design

## Summary

Refine annotation review so a global comment is a single document-wide draft
without an intermediate Add action, and a selection comment editor opens only
after the reviewer explicitly clicks a floating `Comment` button beside the
selected text.

## Interaction

### Selection comments

When the reviewer finishes a non-empty selection inside the rendered document,
Euphony records the existing quote and rendered-text offsets but does not open
the comment editor. It instead positions a compact amber `Comment` button near
the selection's last visible rectangle. The button remains inside the
annotation view bounds.

Clicking `Comment` opens the existing selection form in the comment rail,
focuses its textarea, and removes the floating action. Adding the selection
comment keeps the current saved-comment behavior. Making another valid
selection replaces a pending, unopened selection action.

### Global comment

The comment rail always contains one `Global comment` textarea. There is no
`Add global comment` button and global comments do not appear in the removable
saved-comment list. On `Send comments`, the current trimmed global draft is
appended to the saved selection comments when non-empty.

The ready count includes a non-empty global draft as one comment. Sending with
no comments remains valid. A failed send preserves both saved selection
comments and the global draft.

## Visual Direction

Preserve the existing black operator-console palette, Geist typography,
hairline separators, and amber annotation color. The floating action is the
only new visual signature: a small high-contrast amber button attached to the
selected passage, visually connecting the source text to the comment rail.

## Accessibility

The floating action is a real button named `Comment`, uses the existing visible
focus treatment, and can be activated by keyboard after selection. The
selection textarea is inserted only after activation and receives focus.

## Testing

- Vitest verifies that selection shows `Comment` but not the textarea, clicking
  opens and focuses the textarea, and a selection comment can still be saved.
- Vitest verifies that no `Add global comment` button exists and Send includes
  the current global draft exactly once.
- Playwright exercises the same selection-to-button-to-editor interaction and
  direct global draft submission through the public CLI/API workflow.

