# Pane Changes Tab Design

## Goal

Add a read-only `Changes` source to every terminal pane so developers can
inspect the Git worktree associated with that terminal without leaving
Euphony.

## Scope

- Show the repository branch, upstream, ahead/behind counts, total additions,
  total deletions, and changed-file count.
- Show tracked, staged, deleted, renamed, and untracked files.
- Let the user select a file and inspect a structured unified diff with old and
  new line numbers.
- Refresh only while the Changes source is visible.
- Keep Terminal, Agent log, and Annotation mounted and preserve the pane's
  selected source and terminal size claim while switching sources.
- Keep the feature read-only. Editing, staging, committing, pushing, and
  opening historical commits are out of scope.

## Architecture

### Git reader

Create `internal/gitchanges`, a package that receives a trusted repository root
from terminal metadata and runs Git without a shell. It reads porcelain v2
status records with NUL delimiters, then asks Git for a unified patch per
changed path. The package converts patches into transport-safe files, hunks,
and lines rather than exposing arbitrary command output to the browser.

The reader caps the number of returned files and bytes retained from each Git
command. Oversized patches remain selectable and show a visible truncation
state. Untracked files are diffed against `/dev/null` through `git diff
--no-index`; paths come only from Git status output and are passed as separate
process arguments.

### HTTP API

Add:

```text
GET /api/sessions/{terminal-id}/git-changes
```

The bearer-authenticated handler resolves the terminal and uses its stored
`repoRoot`. It returns:

- `404 session_not_found` for a missing terminal;
- `404 git_repository_not_found` when the terminal is not inside a Git
  worktree;
- `500 git_changes_read_failed` when Git status or patch parsing fails;
- `200` with a normalized snapshot otherwise.

The response is read-only and uses `Cache-Control: private, no-cache`.

### Pane source

Add a permanent Changes tab after Agent log. The existing pane-local source
state and shortcut cycle include it. Annotation remains conditional and is
appended when available. Returning to Terminal follows the existing fit-version
path, while switching to or from Changes does not alter the PTY capacity claim.

`GitChangesView` polls every two seconds only while active. It retains the
selected path across refreshes when that path still exists and otherwise
selects the first changed file.

## Visual Direction

The subject is a local developer control surface, and the tab's single job is
to make uncommitted work legible at terminal-pane scale.

Palette:

- Console black `#050505`
- Raised rail `#0B0D0F`
- Hairline `#262626`
- Paper `#F5F5F5`
- Instrument gray `#8F8F8F`
- Addition green `#2EA043`
- Deletion red `#F85149`

Use the existing Geist face for labels and the existing terminal monospace
stack for paths, line numbers, and patches. The signature is a flush
two-instrument layout: a narrow file navigator and a line-precise diff surface,
with no cards or decorative chrome. At narrow container widths the file
navigator becomes a short horizontal header region above the diff.

## States and Accessibility

- Loading uses a compact skeleton, not a blank pane.
- A clean worktree explains that there are no local changes.
- A non-repository terminal explains that Changes requires a Git worktree.
- Refresh failures keep the last snapshot visible and show a concise status.
- The file collection is an accessible list; each file is a button whose
  selected state is exposed with `aria-current`.
- The diff is a table-like region with a descriptive label, and color is never
  the only indication of addition or deletion because every line retains its
  `+` or `-` prefix.

## Testing

- Go package tests cover porcelain records, spaces, rename records, untracked
  files, line numbers, and patch truncation.
- Server tests cover missing sessions, non-repositories, successful snapshots,
  and authentication through the registered protected route.
- React API and component tests cover request construction, source switching,
  polling activation, file selection, empty/error states, and line rendering.
- Playwright creates an isolated temporary Git repository, opens a terminal in
  it, selects Changes, verifies file selection and diff content, and captures a
  screenshot for visual review.

