# CJK Punctuation Terminal Width Design

## Goal

Keep table columns aligned in the browser terminal when full-width Japanese
parentheses and punctuation such as `（）` and `、。` appear in a row.

## Root Cause

xterm 6 uses its DOM renderer to measure each glyph and applies a compensating
`letter-spacing` so rendered spans occupy their assigned terminal cells.
Chrome's default `text-spacing-trim: normal` compresses Japanese punctuation
during xterm's repeated-glyph measurement. The renderer then adds an excessive
spacing correction to punctuation spans: two ordinary full-width characters
occupy 33.73 px in the reproduction, while `（）` occupies 47.30 px and `、。`
occupies 40.30 px.

The xterm Unicode width table already assigns these code points two cells, and
Canvas font metrics show that their untrimmed advances match other Japanese
full-width glyphs. The defect is therefore browser text-spacing behavior in the
DOM renderer, not terminal byte decoding, Unicode cell classification, or the
font fallback list.

## Approach

Set `text-spacing-trim: space-all` on the xterm root inside `.terminal-host`.
The property is inherited by both rendered rows and xterm's hidden glyph
measurement elements, so measurement and visible rendering use the same
untrimmed full-width advances.

This is preferred over upgrading xterm because an upgrade has a wider
compatibility surface and does not guarantee a renderer fix. It is preferred
over changing fonts because the browser's punctuation trimming would still
make measurement context-dependent.

## Scope

- Apply the rule only inside the xterm terminal host.
- Do not alter the application typography, terminal font family, Unicode
  provider, byte stream, or shell output.
- Preserve existing terminal sizing and fitting behavior.

## Testing

A Chromium end-to-end test will create a real terminal session, print rows
whose first table cell contains `漢字`, `（）`, `、。`, and `ＡＢ`, then inspect
the xterm DOM renderer. The test will assert that the span containing the
following ASCII columns starts at the same horizontal coordinate for every
row. The test fails on the current renderer because the punctuation rows start
the following span farther to the right.
