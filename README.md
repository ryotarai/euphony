# Euphony

Euphony is a browser workspace for terminal-based coding agents. The v0.1
release runs real local PTY sessions, streams them over authenticated
WebSockets, and provides desktop and mobile session navigation.

## Requirements

- Go 1.24 or newer
- Node.js 22 or newer
- npm 10 or newer
- macOS or Linux

## Build

```sh
make build
```

The command produces `bin/euphony`. The executable contains the complete
frontend; Node.js is not needed at runtime.

## Run

Choose a strong access token and start the server:

```sh
EUPHONY_TOKEN='replace-with-a-long-random-token' bin/euphony
```

Open <http://127.0.0.1:8080> and enter the same token. The default listen
address can be changed:

```sh
EUPHONY_TOKEN='replace-with-a-long-random-token' \
EUPHONY_ADDR='0.0.0.0:8080' \
bin/euphony
```

Euphony does not terminate TLS. When the server is reachable outside a trusted
network, place it behind an HTTPS reverse proxy and restrict network access.

The token is stored in the browser's `sessionStorage`. Terminal WebSockets use
single-use tickets instead of placing the long-lived token in their URLs.

## Development

Run the API and Vite development server in separate terminals:

```sh
EUPHONY_TOKEN=development-token go run ./cmd/euphony
```

```sh
cd web
npm install
npm run dev
```

Vite proxies `/api` requests and WebSockets to `127.0.0.1:8080`.

Run all automated checks with:

```sh
make test
```

## v0.1 boundaries

Sessions live in server memory and do not survive a server restart. Browser
disconnects do not terminate their PTY processes. Split panes, multi-user
accounts, file management, and terminal-output replay are intentionally
outside the v0.1 scope.

