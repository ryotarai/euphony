# Pierre Diffs and Trees Integration Design

## Goal

Replace the hand-built code surfaces in the terminal pane's `Changes` and
`Files` sources with Pierre's maintained rendering primitives:

- `@pierre/diffs/react` renders Git patches and read-only workspace files.
- `@pierre/trees/react` renders the workspace navigator.

The existing read-only server APIs, pane source lifecycle, selected paths,
refresh behavior, and PTY sizing behavior remain unchanged.

## Scope and constraints

- Keep the Go Git and workspace readers unchanged unless an integration bug
  makes their existing normalized response unusable.
- Do not add editing, staging, drag-and-drop, rename, or context-menu actions.
- Keep the current server-side workspace search because it searches the full
  bounded workspace, while the tree model only contains directories that have
  been loaded by the existing lazy loader.
- Preserve the current binary, empty, partial, loading, and request-failure
  messages around the Pierre surfaces.
- Keep the selected file path as the browser-facing identity; directory paths
  are converted to Pierre's canonical trailing-slash form only at the tree
  boundary.

## Architecture

### Changes

`GitChangesView` continues to request a summary first and one selected patch on
subsequent requests. A small pure adapter reconstructs a bounded unified patch
string from the normalized `GitChangedFile` hunks already returned by the API.
The selected file is rendered with `PatchDiff` from `@pierre/diffs/react`,
wrapped in `WorkerPoolContextProvider`. The adapter emits Git file headers for
added, deleted, renamed, and modified files so Pierre can infer the correct
language and change type. Binary files, unloaded patches, and empty textual
patches continue to use the existing explicit states.

### Files

`WorkspaceFilesView` keeps its reducer and API effects for root loading,
directory loading, search, refresh generations, and file selection. All paths
known to the reducer are flattened into Pierre's path-first input format:
directory paths end in `/`, while file paths do not. The model is reset after
each root or child-directory response and receives the current expanded
directory set as `initialExpandedPaths`.

The Pierre tree owns row rendering and keyboard navigation. A composed click
handler on the tree host observes the clicked canonical path, triggers the
existing lazy directory request for unloaded folders, and re-expands the folder
after its children arrive. `onSelectionChange` opens selected files through the
existing file request effect. Search results remain the existing accessible
button list and open files through the same selection path.

The read-only file surface uses Pierre's `File` component with the existing
5,000-line display cap applied before constructing `FileContents`. The current
file header and binary/truncation notices remain outside the component.

### Styling

Use the existing Euphony console palette and terminal monospace font. Override
Pierre CSS custom properties for background, foreground, selection, borders,
focus, addition/deletion colors, and compact density. Keep the current
responsive layout: the Files navigator remains on the right on wide panes and
moves above the file surface in narrow panes. Pierre host elements fill their
existing scroll tracks and do not resize the terminal.

## Error handling and accessibility

- Keep the existing empty and error regions with their current labels.
- Preserve `aria-label`/`aria-current` semantics for the file list and search
  results; Pierre's tree supplies its own row roles and keyboard focus.
- Show a status row when a lazy directory request fails and keep a retry action
  outside the shadow DOM tree.
- If Pierre cannot parse a synthesized patch, render the existing concise
  `No textual changes`/unavailable message instead of exposing a runtime error.

## Testing

- Add unit tests for normalized Git hunk to patch conversion, including
  modified, added, deleted, renamed, and metadata lines.
- Update Changes tests to assert `PatchDiff` receives a patch and that the
  existing summary, selection, polling, and empty-state behavior remains.
- Update Files tests to assert the Pierre tree host receives loaded paths,
  lazy directory loading still occurs, file selection still requests content,
  and binary/truncation/search behavior remains.
- Run focused Vitest tests, the complete frontend test suite, TypeScript
  typechecking, the production build, and a Playwright smoke test that exercises
  the real shadow-DOM Pierre surfaces.

## Alternatives considered

1. Keep the hand-built surfaces and only install the packages. Rejected because
   it would not actually use either library and would leave the performance and
   syntax-highlighting problems unchanged.
2. Replace the server APIs with a new full-workspace/raw-patch protocol.
   Rejected because the current bounded normalized APIs already enforce the
   safety limits and are sufficient for adapting to Pierre.
3. Preload the entire workspace before creating the tree. Rejected because it
   removes the existing lazy-loading safety and makes large workspaces pay the
   full traversal cost before the user opens a folder.
