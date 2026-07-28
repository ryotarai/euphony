# Euphony v0.2

既存のtab, paneの概念を刷新する。

まず、ターミナルを1st citizenとし、そのリストを左サイドバーに置く。
そのリストのアイテムにはcwdを表示する。
ターミナルでCodex, Claudeを起動している場合は、そのステータス（Runningなど）とsession titleも表示する。これはHerdrがやっているようにhooksを利用して行う。ターミナルを起動するときに環境変数をセットすることでどのterminalなのかを判断する必要がある。

itemをクリックすると、そのターミナルに切り替わる（1 pane）
Cmdを押しながらterminal itemクリックすると、複数選択になり複数pane表示（横並び）になる
ターミナルリストはStatus (Runningなど）でグルーピングされており、そのステータスのチェックボックスを入れている状態にすると、マッチするターミナルの複数pane表示になる（statusが変わると自動で追加される）

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
