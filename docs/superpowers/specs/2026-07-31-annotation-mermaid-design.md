# Annotation Mermaid Design

## Summary

Render fenced Markdown blocks labeled `mermaid` as diagrams in the
`euphony annotate` review document. Preserve ordinary code blocks, the
existing annotation workflow, and a readable source fallback when Mermaid
cannot render a diagram.

## Approach

Reuse the existing client-side `MermaidDiagram` component that renders Mermaid
for Agent Log Markdown. `AnnotationView` will provide a focused
`react-markdown` `pre` renderer:

- a fenced block whose code element has `className="language-mermaid"` passes
  its source to `MermaidDiagram`;
- all other fenced blocks render as ordinary `<pre><code>` content;
- inline code remains unchanged.

This keeps Mermaid loading, strict security configuration, stable render IDs,
dark theme, asynchronous cleanup, and error fallback in one implementation.
It avoids both a second Mermaid lifecycle and a post-render DOM scan.

## Rendering and Safety

Mermaid continues to load only when a diagram mounts and uses
`securityLevel: "strict"` with error SVG suppression. Raw HTML remains disabled
for Markdown annotations. A valid diagram replaces its fenced source with an
SVG. While rendering, or after a render failure, the original source stays
visible. A failure is local to its diagram and does not hide the rest of the
review document.

Generated SVG text participates in the same document selection flow as other
rendered annotation text. The existing quote and rendered-text offsets remain
the annotation anchor contract.

## Visual Direction

The diagram uses the existing recessed black Mermaid surface, hairline border,
Geist labels, and horizontally contained SVG. Shared Mermaid styles become
context-independent so Agent Log and Annotation render the same diagram
without leaking Agent Log font-size variables into Annotation. No new controls,
cards, colors, or motion are introduced.

## Testing

- A React test proves a valid Mermaid fence in an Annotation renders an SVG
  instead of `code.language-mermaid`.
- The existing annotation Markdown test continues to prove GFM and selection
  comments work.
- Existing Agent Log Mermaid tests continue to cover ordinary fences and
  failed-render source fallback for the shared component.
- The annotation CLI Playwright scenario includes a real Mermaid fence and
  verifies an SVG is visible in the Annotation document.
- The focused unit tests, web typecheck, production build, full Go suite, and
  focused Playwright scenario run before integration.

## Out of Scope

- Mermaid rendering for HTML annotations.
- Diagram editing, zoom, export, source toggles, or click callbacks.
- Server-side Mermaid rendering.
- Changing annotation offsets from their current rendered-text semantics.
