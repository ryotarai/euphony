# Black Terminal Workspace Design

## Purpose

Euphony is a terminal-session switcher for developers who need to scan agent
state, compose panes, and move between live terminals without decorative
application chrome competing with terminal output.

## Visual Direction

The workspace uses a neutral black system:

- Canvas: `#050505`
- Sidebar: `#090909`
- Elevated control: `#111111`
- Divider: `#262626`
- Primary text: `#F5F5F5`
- Muted text: `#8A8A8A`

Geist remains the interface face and the system monospace stack remains the
terminal and metadata face. The selected session and focused pane use a single
one-pixel light rule instead of a colored fill, glow, card border, or rounded
container. This is the design signature: topology is visible through rules,
not decoration.

## Layout

Desktop uses a flush two-column shell. The shadcn/ui Sidebar occupies the left
edge and the terminal stage fills all remaining space. Terminal panes have no
outer padding, gap, radius, or surrounding border. Adjacent panes are separated
only by one vertical divider.

Mobile uses the shadcn Sidebar sheet behavior and a compact trigger bar. The
active pane fills the remaining viewport.

## Sidebar Composition

The navigation is composed directly from `SidebarProvider`, `Sidebar`,
`SidebarHeader`, `SidebarContent`, `SidebarGroup`, `SidebarGroupLabel`,
`SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton`, `SidebarMenuAction`,
`SidebarMenuBadge`, `SidebarFooter`, `SidebarTrigger`, and `SidebarRail`.

The old `EU` mark is removed. Header controls contain only settings and the
collapse trigger. Navigation uses the hierarchy `status > cwd > terminal`.
Status checkboxes dynamically track every terminal with that status. Each cwd
checkbox tracks the narrower `status × cwd` group, automatically adding and
removing panes as sessions enter or leave that group. Session rows use the
standard menu active state and action affordances while retaining the
split-selection checkbox and agent identity.

## Connection Feedback

Connected terminals render no connection label. Connecting or disconnected
states are aggregated into one workspace-level status, never repeated inside
individual panes. A disconnected aggregate exposes one reconnect action that
retries affected terminals.

## Quick Actions

The `Cmd/Ctrl+K` quick action surface uses the shadcn/ui Command composition.
The shortcut description is superseded by the Command+K-only behavior in
`2026-07-31-command-k-only-design.md`.
The filtered result list has one controlled active item. Arrow Up/Down and
`Ctrl+P/N` move the active item with wraparound; Enter invokes it. Escape
closes the surface. The active option remains visible and is exposed through
the command item selection state.

## Verification

Component tests cover the shadcn Sidebar composition, the missing `EU` mark,
global connection aggregation, reconnect behavior, and quick-action keyboard
selection. Playwright verifies flush pane geometry, one divider between panes,
the absence of connected labels, quick-action navigation, desktop sidebar
behavior, and the mobile sheet.
