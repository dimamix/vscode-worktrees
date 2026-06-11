# Changelog

## 0.1.2

- Fix: resolve the workspace folder by explicit longest-prefix match so nested worktree roots (e.g. `<repo>/.worktrees/*`) win over the containing repo root.
- Fix: prefer the OS-reported shell cwd over shell integration's, which can be stale for revived terminals or terminals running a TUI.
- Fix (review): guard against overlapping follow operations on rapid terminal switches with a generation counter.
- Fix (review): compare normalized URIs when adding worktrees so Windows path separators can't produce duplicates that void the whole update.
- Fix (review): expand folders containing only dotfiles by falling back to a hidden child (except `.git`).
- Log every follow decision, including suppressed same-folder switches.

## 0.1.1

- Fix: revealing a workspace root only selected it without expanding; now a child of the terminal's cwd is revealed first so the tree actually opens.
- Fix: resolve the terminal's cwd from the OS (`lsof` on macOS, `/proc` on Linux) when shell integration hasn't reported one — e.g. when a TUI has been running since the terminal opened, or after a window reload restores terminals.
- Add "Worktree Terminal Follow" output channel for troubleshooting.

## 0.1.0

- Initial release.
- Explorer follows the active terminal's workspace folder (collapse + reveal), driven by terminal shell integration.
- `Worktrees: Add Git Worktrees as Workspace Folders` command to turn a repo's worktrees into workspace roots.
- Settings: `worktrees.follow.enabled`, `worktrees.follow.collapseOthers`, `worktrees.follow.restoreTerminalFocus`.
