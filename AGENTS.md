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
- When coding agents run in parallel, give each agent an isolated database and
  dedicated network ports for development and verification.
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
- Support pinning at terminal, cwd, and status checkbox levels, and represent
  pins with an amber checkbox state instead of a separate pin glyph.
- Use Alt-click (Option-click on macOS), not Shift-click, to pin sidebar
  checkboxes.
- When a focused selected plain terminal becomes an identified agent session,
  clear group filters and other pane selections, then follow that session.
- Model unread attention independently from the agent's current status; never
  replace statuses such as `waiting` or `running` with an attention status.
- Automatically selecting an attention-needing terminal must not move focus;
  acknowledge attention only after the user explicitly focuses that terminal.
- Give rendered Markdown tables explicit cell padding and borders so dense
  transcript data remains legible.
- Do not let agent lifecycle transitions reset a pane's user-selected Terminal
  or Agent log source.
- Read agent metadata that hooks do not carry from the artifacts they point at
  (for example a transcript path), and bound such reads to a tail window so
  multi-megabyte files stay cheap to poll.
- Keep CJK punctuation spacing untrimmed inside terminal renderers so every
  full-width glyph occupies the same cell geometry.
- Center a negotiated shared terminal grid in quiet, unmarked letterbox space;
  do not imitate tmux's dotted filler or scale terminal cells.
- Keep a terminal's negotiated size claim while switching its in-pane source;
  Terminal, Agent Log, Git Changes, and Annotation tabs must not resize the PTY.
- Bound browser-owned terminal size claims with server-driven WebSocket
  Ping/Pong; do not rely on JavaScript heartbeat timers for liveness.
- Exercise public automation features through the built CLI against both the
  Unix socket and TCP API; do not treat handler-only tests as transport proof.
