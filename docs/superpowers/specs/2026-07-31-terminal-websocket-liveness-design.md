# Terminal WebSocket Liveness Design

## Goal

Remove stale shared-terminal size claims when a browser connection disappears
without completing a WebSocket close handshake.

## Design

The server will monitor each terminal WebSocket with protocol-level Ping/Pong
frames. After an initial interval, it sends a Ping and waits for the browser's
automatic Pong response. A missing Pong cancels the existing connection
context, which lets the terminal handler follow its normal deferred cleanup
path and unsubscribe that connection's size claim.

The browser will not send an application-level heartbeat. Protocol control
frames avoid background-tab timer throttling and do not require a new message
schema. Normal input, output, resize, and close behavior remains unchanged.

## Timing

- Ping interval: 15 seconds
- Pong timeout: 5 seconds
- Maximum stale-claim lifetime after a silent disconnect: approximately
  20 seconds

The liveness loop accepts explicit timing values so tests can run
deterministically without waiting for production intervals.

## Failure Handling

A failed or timed-out Ping cancels only the affected WebSocket. The terminal
session remains running. Existing deferred cleanup removes the connection from
the terminal size coordinator, which recalculates and publishes the minimum
size of the surviving claims.

Cancellation caused by normal handler shutdown is not logged as a liveness
failure. No terminal data, credentials, or bearer tokens are included in
liveness logs.

## Verification

Unit tests will prove that:

- a successful Pong keeps monitoring active;
- a failed Ping cancels the connection;
- canceling the parent context stops monitoring promptly.

Existing coordinator and terminal WebSocket integration tests continue to
prove that disconnecting a smaller client grows the PTY to the surviving
client's reported size.
