# Pane Tab Split Implementation Plan

**Goal:** Add a per-pane, draggable two-source view opened by Command-clicking
tab icons without changing terminal capacity during source navigation.

1. Add failing `TerminalPane` tests for Command-click split toggling, source
   activity, terminal capacity retention, and divider pointer/keyboard input.
2. Replace mutually exclusive tab panels with one mounted source stage that can
   assign each source to a primary or secondary grid track.
3. Add split state, tab pointer handling, annotation cleanup, and accessible
   divider state to `TerminalPane`.
4. Add restrained split-tab and divider styling to `styles.css`.
5. Run focused tests, all frontend tests, type checking, build, and an affected
   Playwright test; inspect the rendered split at desktop width.
6. Review the diff, commit the worktree branch, and merge it into the base
   branch while preserving unrelated base-worktree changes.
