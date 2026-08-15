# Remaining Euphony TODO Design

## Scope

Complete the two unchecked items in the active section of `Euphony TODO.md`:

- Make Agent Log Markdown lists render as readable lists.
- Remove the permanent session information pane and replace it with a delayed session information card near the hovered agent-list item.

The `Pending` section is intentionally unchanged. Its information-pane layout item conflicts with the active requirement to remove that pane and is not part of this implementation.

## Agent Log lists

Keep `react-markdown` and the existing `remark-gfm` pipeline unchanged. Add focused Agent Log Markdown styles for unordered and ordered lists, including nested lists, so browsers receive an explicit marker style, indentation, and spacing inside transcript message content. The styles must remain scoped to Agent Log content and must not alter terminal or application-wide lists.

The component test will continue to assert semantic list roles and will also assert the scoped class used by the Markdown container. Browser-level verification will confirm that the rendered list has visible marker styling and readable spacing.

## Hover session information

Extract the existing session-information presentation into a reusable `SessionInfoCard`. `App` no longer renders `SessionInfoPane` or reserves a grid column/resizer for it. The agent-list session-row components (`ProjectSidebar` for the current project UI and the legacy `SessionNavigation` list) own the hover/focus interaction because they own the session items:

- Start a 500ms timer on pointer entry or keyboard focus.
- Cancel the timer and hide the card when the item is left, blurred, replaced, or when Escape is pressed.
- Store the latest pointer coordinates and position the card using fixed viewport coordinates.
- Clamp the card within the viewport with a small margin so it remains readable near all four edges.
- Preserve normal selection, link/button behavior, and accessible labels. Focused items expose the same information card without requiring a pointer.

Only one card may be visible at a time, and a session update must not leave a stale card for a different item.

## Testing

Add a failing Agent Log test for the scoped Markdown list container and a failing navigation test covering the 500ms delay, cancellation, card content, viewport positioning, Escape, and focus behavior. Run focused tests during each red-green cycle, then run the complete Go suite, complete Web Vitest suite, typecheck, production build, and the relevant Playwright smoke coverage. Update only the two active unchecked TODO boxes after all verification succeeds.
