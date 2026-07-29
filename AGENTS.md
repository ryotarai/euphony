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
