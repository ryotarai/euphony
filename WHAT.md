# Euphony v0.1

Euphony is a web UI for coding agents. It can run locally or on a remote
machine for access while away from a desk.

The initial product is a tmux-like workspace in the browser, designed to run
terminal-based agents such as Claude Code CLI and Codex.

- On mobile, the active terminal fills the screen. A hamburger menu opens a
  drawer for switching terminals.
- Use ghostty-web if it is sufficiently mature and maintainable.
- Ship a Go API and a TypeScript/React frontend embedded in the Go binary.

The product will grow incrementally; v0.1 intentionally keeps the scope small.

