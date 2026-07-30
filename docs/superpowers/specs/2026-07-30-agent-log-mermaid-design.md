# Agent Log Mermaid Design

## Summary

Render fenced Markdown code blocks labeled `mermaid` as diagrams inside agent
logs. Keep every other code block unchanged, preserve the diagram source while
rendering, and fall back to that source with a concise error message when a
diagram is invalid.

## Approach

Use Mermaid's browser `render` API from a focused React component. This is
preferred over rescanning the whole transcript with `mermaid.run`, which would
couple unrelated log entries and make polling updates harder to isolate, and
over server-side rendering, which would add a browser-oriented diagram runtime
to the Go service.

`react-markdown` already exposes fenced-code language classes through its
`code` renderer. When the class is exactly `language-mermaid`, pass the block
source to `MermaidDiagram`. Inline code and every other fenced language keep
the existing renderer.

`MermaidDiagram` dynamically imports Mermaid only after the first diagram is
mounted. The module is initialized once with:

- `startOnLoad: false`, because React owns the diagram lifecycle;
- `securityLevel: "strict"`, so transcript content cannot enable HTML or click
  behavior;
- `suppressErrorRendering: true`, so invalid syntax cannot leave Mermaid's
  global error SVG in the document;
- a dark theme derived from the existing agent-log palette.

Each component uses a stable, DOM-safe ID for `mermaid.render`. An effect
rerenders when the source changes and ignores stale asynchronous results after
unmount or replacement.

## States and Error Handling

While Mermaid loads and renders, the original fenced source remains readable
and the diagram region is marked busy. On success, the generated SVG replaces
the source. On failure, the source remains and a local message says that the
diagram could not be rendered. A bad diagram never prevents the rest of the
transcript from rendering.

## Visual Direction

The diagram surface continues the existing local operator-console design:

- Signal black: `#050505`
- Raised black: `#0B0D0F`
- Hairline: `#262626`
- Paper white: `#F5F5F5`
- Instrument gray: `#8A8A8A`
- Codex mint accent: `#A3E635`

Geist remains the diagram label face and the existing monospace stack remains
the source fallback face. The diagram is a recessed instrument surface rather
than a new card style. Its container scrolls horizontally within the pane, and
the SVG retains a legible minimum width instead of widening the workspace.

## Testing

- React tests prove a `mermaid` fence becomes SVG, ordinary fences stay code,
  and a rejected render preserves the source with an error message.
- Playwright feeds a real Mermaid fence through the isolated transcript
  fixture, verifies that Mermaid produces an SVG, checks the diagram container
  stays horizontally contained, and captures the rendered Agent Log. The
  fixture derives its Claude root from the dedicated E2E port so parallel test
  servers read only their own transcripts.
- The full web unit suite, TypeScript build, production build, Go suite, and
  focused Playwright scenario run before integration.

## Out of Scope

- Mermaid editing, zoom controls, export, or source toggles.
- Rendering Mermaid in terminal output or tool-result `<pre>` blocks.
- Enabling Mermaid links, click callbacks, raw HTML, or loose security mode.
- Server-side diagram rendering.
