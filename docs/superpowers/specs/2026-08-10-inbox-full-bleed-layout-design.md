# Inbox Full-Bleed Layout Design

## Goal

Make the Inbox mailbox occupy the complete dashboard pane, matching the provided reference where the tabs, message list, and selected-message detail are the primary surface instead of a centered card surrounded by page whitespace.

## Design

When a terminal is selected alongside Inbox, the existing workspace carousel provides the third horizontal pane. Terminal rendering remains in that carousel; Inbox does not embed or duplicate a terminal.

The Inbox becomes a full-height flex column. Its top rail contains the Inbox/Done tabs and the existing attention count and refresh control. The page-level breadcrumb, subtitle, and oversized title are removed from the visual layout, while an accessible `h1` remains in the document structure. The mailbox grid becomes the flexible remaining region, with the existing approximately 38/62 list/detail split preserved.

The list's section headings are treated as mailbox metadata rather than page headings: `Needs your action`, `Agent updates`, and `Done` use a compact monospace label sized for a dense message ledger. They must not compete with the selected message detail.

The visual language stays consistent with the existing Euphony terminal UI: near-black surfaces, hairline dividers, amber attention state, and monospace utility labels. No new dependency, color system, or navigation behavior is introduced.

## Behavior and accessibility

- Refresh remains available as the `Refresh all agent summaries` button in the compact rail.
- Inbox and Done tabs retain their existing keyboard navigation and ARIA relationships.
- The `Inbox` heading remains available to assistive technology as the page heading.
- Section headings remain semantic headings while using a compact visual treatment.
- The list/detail selection, action buttons, URL routes, and terminal lock behavior are unchanged.
- Selecting Inbox and a terminal together produces the horizontal A | B | C workspace arrangement: Inbox list, Inbox detail, and the normal terminal pane.
- At mobile widths, the mailbox continues to stack the list above the detail surface.

## Verification

- Component tests verify the compact rail still exposes the refresh control and the mailbox structure.
- Playwright verifies the rendered Inbox has zero page padding, no centered max-width constraint, a full-height mailbox surface, and compact list section headings.
