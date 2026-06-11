# Changelog

## 0.1.4

- Add a polling fallback (`worktrees.follow.pollIntervalMs`, default 2000ms, 0 disables): the active terminal is checked on an interval because terminal-switch events have been observed to not be delivered at all in some windows (see README "Known limitations"). Idle ticks are spawn-free when shell integration is available; OS lookups are TTL-cached; ticks skip while a follow is in flight; a fresh OS lookup is forced on the tick after a terminal switch.
- Harden in-flight follows: staleness now also means "no longer the active terminal", poll rejections are logged instead of unhandled, and the poll interval is clamped (min 500ms, max 2^31-1).

## 0.1.3

- Diagnostics: log every raw terminal event (active-terminal change, shell-integration update, open/close) and dump workspace folders, terminals, and the active terminal at activation.

## 0.1.2

- Fix: resolve the workspace folder by explicit longest-prefix match (case-folded on macOS/Windows, root-folder safe) so nested worktree roots (e.g. `<repo>/.worktrees/*`) win over the containing repo root.
- Fix: resolve the terminal's cwd from multiple sources — shell integration first, then the OS-reported shell cwd (`lsof` on macOS, `/proc` on Linux), then the creation cwd — grouped by physical directory so symlinked aliases deepen a match by relative depth but a stale source naming a different directory only serves as fallback.
- Fix (review): a generation counter cancels overlapping follows on rapid terminal switches (including switches to no terminal), and the same-folder guard is only recorded after a reveal fully completes.
- Fix (review): normalized, case-folded URI comparison when adding worktrees, so Windows separators or casing can't produce a duplicate that voids the whole update.
- Fix (review): folders containing only dotfiles expand via a hidden child (except `.git`).
- Log every follow decision — including suppressed same-folder switches — with the cwd source.

## 0.1.1

- Fix: revealing a workspace root only selected it without expanding; now a child of the terminal's cwd is revealed first so the tree actually opens.
- Fix: resolve the terminal's cwd from the OS (`lsof` on macOS, `/proc` on Linux) when shell integration hasn't reported one — e.g. when a TUI has been running since the terminal opened, or after a window reload restores terminals.
- Add "Worktree Terminal Follow" output channel for troubleshooting.

## 0.1.0

- Initial release.
- Explorer follows the active terminal's workspace folder (collapse + reveal), driven by terminal shell integration.
- `Worktrees: Add Git Worktrees as Workspace Folders` command to turn a repo's worktrees into workspace roots.
- Settings: `worktrees.follow.enabled`, `worktrees.follow.collapseOthers`, `worktrees.follow.restoreTerminalFocus`.
