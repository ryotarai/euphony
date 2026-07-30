# Pane Files Tab Design

## Summary

Add a read-only Files source to every terminal pane. The source presents the
terminal's workspace as a searchable, lazily loaded tree and opens text files in
a line-numbered viewer without changing the terminal process or its negotiated
PTY size.

## Goals

- Add a permanent Files tab to the pane source rail.
- Resolve the workspace from server-owned terminal metadata.
- Prefer the Git worktree root when the terminal cwd is inside a repository and
  otherwise use the terminal cwd.
- Load directory entries on demand and search from the workspace root.
- Display bounded UTF-8 text files with line numbers.
- Explain empty directories, binary files, truncated files, missing paths, and
  request failures in place.
- Preserve the selected pane source across terminal lifecycle updates.

## Non-goals

- Editing, saving, renaming, creating, or deleting files.
- Following filesystem changes in real time.
- A full language server, syntax engine, or Git-aware editor.
- Browsing paths outside the terminal workspace.

## Interaction

The Files tab uses the folder-tree icon and participates in the source shortcut
cycle after Changes and before Annotation. Activating it leaves the terminal
mounted and merely hides the terminal surface, preserving PTY capacity and
history.

The Files view follows the supplied Codex reference: the file viewer occupies
the main area and the navigator sits on the right. A container query moves the
navigator above the viewer in narrow panes. The navigator includes a search
field, expandable directories, a refresh action, and a path label. Search
returns a bounded flat list of matching workspace paths.

Selecting a text file opens a line-numbered, read-only view. Binary files show a
clear unsupported state. Files larger than the read limit show their readable
prefix and a truncation notice.

## Server API

Two authenticated session-scoped endpoints are added:

- `GET /api/sessions/{id}/workspace?path=<relative-directory>`
- `GET /api/sessions/{id}/workspace/search?query=<text>`
- `GET /api/sessions/{id}/workspace/file?path=<relative-file>`

All roots come from terminal metadata. Browser-provided absolute paths and
relative paths that escape the resolved root are rejected. The reader holds an
`os.Root` handle so opens remain confined during concurrent renames and symlink
changes. Relative symlinks may only resolve inside that root.

Directory listings are sorted with directories first and capped at 500 entries.
Search skips large implementation directories such as `.git` and
`node_modules`, visits at most 10,000 entries, and returns at most 200 matches.
File reads are capped at 1 MiB plus one detection byte. A partial UTF-8 rune at
the boundary is removed without classifying the file as binary. NUL-containing
or otherwise invalid UTF-8 content is reported as binary and is never embedded
in JSON. The viewer renders at most 5,000 lines from the bounded response.

## Failure handling

- Missing session: `404 session_not_found`
- Invalid or escaping path: `400 workspace_path_invalid`
- Missing filesystem path: `404 workspace_path_not_found`
- Wrong path kind: `400 workspace_path_type_mismatch`
- Other read errors: `500 workspace_read_failed`

The frontend keeps the last successful root visible during refreshes,
invalidates child-directory caches, reloads the selected file and active
search, and ignores stale request completions from older refresh generations.
Failed initial and child-directory loads offer retry actions, while empty child
directories have an explicit empty row.

## Verification

- Package tests cover root resolution, traversal rejection, symlink
  containment, sorting, search bounds, binary detection, and truncation.
- Handler tests cover authentication, session lookup, metadata-rooted access,
  and error responses.
- Frontend tests cover tab switching, shortcut order, directory expansion,
  search, file rendering, binary/truncated states, and stale request handling.
- A production build and Playwright smoke test verify the responsive pane UI.
