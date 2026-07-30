# Agent Instructions

- Do not pause to ask for design or plan approval. Make reasonable assumptions
  and continue through implementation and verification unless the user
  explicitly asks to pause, requests only a plan, or a decision would
  materially expand the requested scope.
- Use Playwright for frontend behavior verification when it provides stronger
  evidence than unit tests or source inspection.
- Improve these instructions continuously: when user feedback reveals a
  reusable workflow preference or lesson, add a concise rule to this file
  during the current task.
- Remove repetitive manual steps from development workflows when they can be
  automated safely.
- After implementing and verifying changes in a task worktree, commit and merge
  them back to the base branch automatically unless the user asks otherwise.
- Run end-to-end servers with an isolated test database so persisted local
  sessions cannot leak into browser tests.
- Preserve arbitrary terminal byte streams across JSON boundaries with a
  lossless encoding such as base64; never stringify independent PTY chunks.
- Run end-to-end tests that mutate shared server state with one worker, or give
  each worker an isolated backend.
- Keep terminal panes flush by default: use only separators between panes, and
  aggregate connection status at workspace level instead of repeating it per pane.
- Treat checked sidebar groups as persistent dynamic filters: automatically add
  and remove panes as sessions enter or leave the checked group.
- Reflect checked parent filters in child controls, and release or decompose an
  active parent filter when a child is unchecked.
- When a focused selected plain terminal becomes an identified agent session,
  clear group filters and other pane selections, then follow that session.
- Model unread attention independently from the agent's current status; never
  replace statuses such as `waiting` or `running` with an attention status.
- Give rendered Markdown tables explicit cell padding and borders so dense
  transcript data remains legible.
- Do not let agent lifecycle transitions reset a pane's user-selected Terminal
  or Agent log source.
