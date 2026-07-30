# Agent Launch Selection Design

## Goal

Keep the user's attention on the terminal where an agent was launched, instead
of allowing an active dynamic sidebar filter to remove that terminal when its
activity changes.

The same change removes the redundant boxed border around the Quick Actions
search field while preserving clear keyboard focus and separation from results.

## Selection Semantics

### Agent promotion

A session is promoted when all of the following are true between two polling
responses:

- the session existed in the previous response;
- its previous activity was `terminal`;
- its next activity is not `terminal`;
- its next representation identifies a coding agent;
- it is the currently focused, selected session.

When the focused session is promoted:

- replace the entire pane selection with the promoted session;
- keep that session focused;
- clear every status and cwd dynamic filter;
- clear dynamic-filter ownership and decomposed-filter provenance;
- replace the current workspace URL with one `terminal` value and no `status`
  or `cwd` values;
- do not add a browser history entry.

This transition applies whether the previous selection came from a status
filter, a cwd filter, or manual multi-selection. It preserves the user's
immediate intent: the shell where the command was entered becomes the agent
workspace.

### Transitions that do not take over selection

- A non-focused session becoming an agent does not take focus from the user.
- A coding-agent session moving between `running`, `waiting`, and `attention`
  continues to obey active dynamic filters.
- A plain terminal changing cwd remains governed by the existing cwd filter
  rules.
- A session that exits without identifying an agent does not take over
  selection.
- If multiple sessions become agents in one poll, only the focused selected
  session is eligible.

These boundaries preserve the existing promise that checked sidebar groups
dynamically add and remove their members.

## State Update Architecture

The polling boundary records session IDs promoted from plain terminals to
agent sessions before replacing the session list. The workspace-filter effect
consumes that pending transition before applying normal filter reconciliation.

Handling promotion inside the reconciliation effect avoids an intermediate
render that removes the promoted pane and then adds it back. The pane remains
mounted while React batches the selection, focus, and filter updates.

Promotion detection is based on session data, not terminal input text. This
supports aliases, wrappers, Claude, Codex, and future agents without parsing
shell commands.

## Quick Actions Input

### Visual direction

The existing Euphony palette and typography remain unchanged:

- canvas: `#050505`;
- surface: `#090909`;
- selected surface: `#171717`;
- divider: `#262626`;
- foreground: `#f5f5f5`;
- muted foreground: `#8a8a8a`;
- body and control type: Geist;
- terminal content: the existing terminal monospace face.

The input group becomes visually continuous with the command surface:

- no rectangular border;
- no focus ring around the input group;
- transparent input background;
- one subtle bottom divider between search and results;
- the insertion caret, search icon, and existing dialog focus trap remain.

This is intentionally a restrained correction rather than a new visual motif.
The command palette's signature remains its keyboard-first, full-width search
surface and selected action row.

## Alternatives Considered

### Keep a promoted pane as a manual exception

The dynamic filter could stop owning the promoted pane and preserve it beside
the remaining matches. This avoids losing the pane but leaves unrelated splits
visible, contradicting the requested behavior of selecting only the launched
agent.

### Infer agent launch commands from terminal input

Detecting `claude`, `codex`, or aliases would respond before polling, but shell
aliases, scripts, command chains, and future agents make text inference
unreliable. Session state is the authoritative boundary.

### Follow every status change

Following any focused status transition would undermine persistent dynamic
filters. Promotion is therefore limited to the `terminal` to identified-agent
boundary.

## Verification

Unit tests reproduce two plain terminals selected through a group filter,
promote the focused one to a waiting agent, and assert:

- only the promoted session remains rendered;
- the other terminal pane is removed;
- status and cwd filters disappear from the URL;
- focus and the sole `terminal` URL value point to the promoted session.

Existing tests continue to prove that ordinary agent status changes remain
dynamic.

Playwright drives the same transition through the agent hook API and waits for
the polling boundary. It also verifies that the Quick Actions input group has
no box border or shadow and retains only the wrapper's bottom divider.
