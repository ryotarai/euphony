# Terminal Empty State and Running Notice Design

## Goal

Bring the empty terminal workspace and automatic-deselection notice into the same visual language as the existing `Delete terminal?` confirmation dialog.

## Design direction

- Keep the existing black workspace palette and use the dialog's popover surface, border, radius, and muted footer treatment as the shared visual vocabulary.
- Render the empty state as a compact centered card with a small context label, a clear empty-state title, supporting copy, and the existing `Start a terminal` action using the shared `Button` component.
- Restyle the automatic-deselection notice as a non-modal dialog-like notice: quiet popover surface, rounded border, title/description hierarchy, and a footer-like action area. Keep its current timer and `Cancel` behavior unchanged.
- Preserve all existing English copy used by tests and users unless a new supporting label is required for hierarchy. Do not change session creation, deselection, or API behavior.

## Accessibility and responsive behavior

- Keep the notice as `role="status"` with its current accessible name and preserve the focusable `Cancel` button.
- Keep the empty-state action as a native button with visible focus styling.
- The card and notice must remain readable on narrow screens; the notice may stack its action below the copy when its available width is small.
- Respect the existing reduced-motion rules.

## Testing

- Add component-level assertions for the empty-state card structure and shared button semantics.
- Add component-level assertions for the running notice's dialog-like structure while retaining its status role, accessible name, copy, and cancel action.
- Run the focused App tests, TypeScript build, and the relevant Playwright flows at desktop and mobile widths when the local E2E server is available.

## Scope

Only `web/src/App.tsx`, `web/src/styles.css`, and the relevant App/E2E tests are implementation files. The existing delete confirmation behavior and shared dialog primitives are not changed.
