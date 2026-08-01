# Agent Instructions

## Workflow

- Do not pause to ask for design or plan approval. Make reasonable assumptions
  and continue through implementation and verification unless the user
  explicitly asks to pause, requests only a plan, or a decision would
  materially expand the requested scope.
- Improve these instructions continuously: when user feedback reveals a
  reusable workflow preference or lesson, add a concise rule to this file
  during the current task.
- Remove repetitive manual steps from development workflows when they can be
  automated safely.
- After implementing and verifying changes in a task worktree, commit and merge
  them back to the base branch automatically unless the user asks otherwise.
- Before asking users to install integrations, explain what each hook or skill
  does and that existing settings are preserved.

## Testing and isolation

- Use Playwright for frontend behavior verification when it provides stronger
  evidence than unit tests or source inspection.
- Run end-to-end servers with an isolated test database so persisted local
  sessions cannot leak into browser tests.
- When coding agents run in parallel, give each agent an isolated database and
  dedicated network ports for development and verification.
- Run end-to-end tests that mutate shared server state with one worker, or give
  each worker an isolated backend.
- Exercise public automation features through the built CLI against both the
  Unix socket and TCP API; do not treat handler-only tests as transport proof.

## Terminal and process data

- Preserve arbitrary terminal byte streams across JSON boundaries with a
  lossless encoding such as base64; never stringify independent PTY chunks.
- Bound browser-owned terminal size claims with server-driven WebSocket
  Ping/Pong; do not rely on JavaScript heartbeat timers for liveness.
- Read agent metadata that hooks do not carry from the artifacts they point at
  (for example a transcript path), and bound such reads to a tail window so
  multi-megabyte files stay cheap to poll.
- Keep derived terminal facts such as the working directory self-healing:
  sample them from the live process on read, and never let a browser keystroke
  be the only trigger, or a terminal driven through the automation API or
  restored after a restart shows a directory it left long ago. An agent hook
  still wins, because an agent knows its project directory where its process
  only knows the worktree it entered.

## Sidebar filters, pins, and attention

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
- Toggle the desktop sidebar with Meta+B only; keep Control+B available for
  terminal prefix commands.

## Pane layout and source behavior

- Keep terminal panes flush by default: use only separators between panes, and
  aggregate connection status at workspace level instead of repeating it per
  pane.
- Do not let agent lifecycle transitions reset a pane's user-selected Terminal
  or Agent log source.
- Read agent metadata that hooks do not carry from the artifacts they point at
  (for example a transcript path), and bound such reads to a tail window so
  multi-megabyte files stay cheap to poll.
- Treat Ctrl-C as an interrupt request, not proof that an agent stopped; change
  lifecycle status only after a matching agent-confirmed stop or abort event.
- Treat Codex permission-request hooks as transient approval prompts; reconcile a
  `blocked` status from Codex's rollout transcript before assuming it remains
  blocked.
- Keep a terminal's negotiated size claim while switching to a non-terminal
  in-pane source; hidden Terminal, Agent Log, Git Changes, Files, and
  Annotation tabs must not resize the PTY.
- Let Command-clicking a pane source tab open it as a secondary split with a
  draggable divider. While Terminal is visible in that split, renegotiate the
  PTY to the terminal track's live width and restore it when the split closes.

## Rendering and terminal geometry

- Give rendered Markdown tables explicit cell padding and borders so dense
  transcript data remains legible.
- Keep CJK punctuation spacing untrimmed inside terminal renderers so every
  full-width glyph occupies the same cell geometry.
- Keep mounted xterm panes measurable when they are not visible; use
  layout-preserving visibility and inertness instead of `hidden`/`display:
  none`, so xterm width measurement and full-width glyph layout remain stable.
- Center a negotiated shared terminal grid in quiet, unmarked letterbox space;
  do not imitate tmux's dotted filler or scale terminal cells.
