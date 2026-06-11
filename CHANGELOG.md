# Changelog

## 0.1.1

- Fix: revealing a workspace root only selected it without expanding; now a child of the terminal's cwd is revealed first so the tree actually opens.
- Fix: resolve the terminal's cwd from the OS (`lsof` on macOS, `/proc` on Linux) when shell integration hasn't reported one — e.g. when a TUI has been running since the terminal opened, or after a window reload restores terminals.
- Add "Worktree Terminal Follow" output channel for troubleshooting.

## 0.1.0

- Initial release.
- Explorer follows the active terminal's workspace folder (collapse + reveal), driven by terminal shell integration.
- `Worktrees: Add Git Worktrees as Workspace Folders` command to turn a repo's worktrees into workspace roots.
- Settings: `worktrees.follow.enabled`, `worktrees.follow.collapseOthers`, `worktrees.follow.restoreTerminalFocus`.
