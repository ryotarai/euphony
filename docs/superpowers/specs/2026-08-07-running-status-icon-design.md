# Running Status Icon Design

## Problem

The sidebar currently renders the `running` state with a `LoaderCircleIcon`. The
icon's rotation animation was intentionally disabled to avoid persistent GPU
work, but the remaining static partial ring looks like a frozen loading spinner.
That makes a healthy, actively running Codex or Claude session look broken.

## Goals

- Make the `running` state read as active work rather than stalled loading.
- Keep the indicator static so the GPU optimization is preserved.
- Preserve the existing compact sidebar geometry and status colors.
- Keep the state distinguishable from `starting`, `waiting`, `blocked`, and
  terminal lifecycle states.

## Design

Replace the `running` status icon with a static `CircleDot` icon. The icon will
retain the existing blue `#60a5fa` status color and 1rem box so session rows do
not shift. A filled center communicates an active process without implying that
the UI is waiting for an indeterminate operation to finish.

Use a static `Clock3` icon for `starting`, separating connection/launching from
an already-running agent. Keep the existing waiting, blocked, terminal, exited,
and failed indicators unchanged.

| State | Icon | Meaning | Motion |
| --- | --- | --- | --- |
| running | CircleDot | Process is actively working | None |
| starting | Clock3 | Process is being launched | None |
| waiting | CirclePause | Process needs or is awaiting input | None |
| blocked | Existing stop indicator | Process is blocked | None |
| terminal | SquareTerminal | Plain shell terminal | None |
| exited | CircleCheck | Process completed | None |
| failed | CircleX | Process failed | None |

## Accessibility

Keep the existing `role="img"` and state-specific `aria-label` values. The
visual replacement must not change the accessible status vocabulary or session
row labels.

## Implementation scope

- Update the icon imports and `sessionStatusIcon` switch in
  `web/src/components/SessionNavigation.tsx`.
- Update or extend the SessionNavigation tests for the running and starting
  icons without changing selection behavior.
- Keep `.session-status-running` static and reuse the current layout/color CSS.
- Update the stylesheet test only if the selector or animation assertion needs
  to reflect the new icon semantics.

## Verification

- Unit tests assert the running and starting status icons expose their existing
  labels and use the new static icons.
- Existing SessionNavigation and full web test suites pass.
- The terminal reliability E2E suite passes.
- A browser screenshot confirms the icon no longer resembles a frozen spinner,
  while sidebar spacing remains unchanged.
