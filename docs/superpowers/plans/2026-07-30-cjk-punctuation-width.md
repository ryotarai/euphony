# CJK Punctuation Terminal Width Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep xterm table columns aligned when Japanese full-width punctuation is rendered in Chrome.

**Architecture:** Preserve xterm's Unicode cell widths and font configuration. Override Chrome's CJK punctuation trimming at the terminal root so xterm's hidden width measurements and visible DOM rows use identical full-width advances.

**Tech Stack:** React 19, xterm 6 DOM renderer, CSS Text, Playwright, Chromium

## Global Constraints

- Scope the CSS rule to xterm instances inside `.terminal-host`.
- Do not change terminal bytes, Unicode width classification, or the font stack.
- Verify actual column geometry in a real Chromium renderer.
- Run end-to-end tests with one worker and an isolated in-memory database.

---

### Task 1: Preserve full-width punctuation spacing

**Files:**
- Modify: `web/e2e/terminal-reliability.spec.ts`
- Modify: `web/src/styles.css`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: xterm's `.xterm`, `.xterm-rows`, and hidden width-measurement descendants
- Produces: identical following-column coordinates for ordinary full-width glyphs and Japanese punctuation

- [ ] **Step 1: Write the failing browser regression test**

Create a shell session through the authenticated API, select its terminal,
enter this command through xterm, and wait for all rows:

```sh
printf "%s\n" "│ 漢字 │ aa │" "│ （） │ aa │" "│ 、。 │ aa │" "│ ＡＢ │ aa │"
```

Read the four matching `.xterm-rows > div` elements. For each row, find the
rendered span whose text starts with ` │ aa │`, record its
`getBoundingClientRect().left`, and assert that all four values are equal
within 0.1 CSS pixel.

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
npx playwright test e2e/terminal-reliability.spec.ts --grep "keeps table columns aligned for full-width Japanese punctuation"
```

Expected: FAIL because the following span begins approximately 13.56 px later
for `（）` and 6.56 px later for `、。`.

- [ ] **Step 3: Implement the minimal CSS correction**

Add this terminal-scoped rule beside the existing xterm host styles:

```css
.terminal-host .xterm {
  text-spacing-trim: space-all;
}
```

Add a concise project invariant to `AGENTS.md` requiring untrimmed CJK
punctuation spacing in terminal renderers.

- [ ] **Step 4: Run the focused test to verify it passes**

Run the focused Playwright command from Step 2.

Expected: PASS, with all following-column positions equal within 0.1 CSS pixel.

- [ ] **Step 5: Run regression verification**

Run:

```bash
npm test -- --run
npm run build
go test ./...
npx playwright test
```

Expected: all Vitest, Go, build, and Chromium end-to-end checks complete with
zero failures.

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md docs/superpowers/specs/2026-07-30-cjk-punctuation-width-design.md docs/superpowers/plans/2026-07-30-cjk-punctuation-width.md web/e2e/terminal-reliability.spec.ts web/src/styles.css
git commit -m "fix: align CJK punctuation in terminal tables"
```
