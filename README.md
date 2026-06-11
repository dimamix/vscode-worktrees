# Worktree Terminal Follow

A tiny VS Code extension for people who work with **multiple git worktrees in one window**, one integrated-terminal tab per worktree.

VS Code's Explorer is per-window state — it has no concept of "follow the active terminal." This extension adds that: when you click between terminal tabs (or `cd` between worktrees), the Explorer collapses and reveals the workspace folder that the active terminal is sitting in.

## Zero dependencies, by design

This project uses **no npm packages at all** — not at runtime, not for building. The extension is a single plain-JavaScript file using only the `vscode` API and Node builtins, and the `.vsix` package is assembled by a small POSIX shell script (`package.sh`) using `zip`. What you read in this repo is exactly what runs.

## How it works

1. Open your repo's worktrees as **workspace folders** in one window (multi-root workspace). The included command does this for you — see below.
2. Switch between your terminal tabs. The extension reads the active terminal's current directory from VS Code's [shell integration](https://code.visualstudio.com/docs/terminal/shell-integration), maps it to a workspace folder, collapses the rest, and reveals it.

## Setup

### 1. Add your worktrees as workspace folders

Run **`Worktrees: Add Git Worktrees as Workspace Folders`** from the Command Palette. It discovers every worktree of every repo already open in the window (`git worktree list`) and adds the missing ones as workspace folders.

VS Code will offer to save this layout as a `.code-workspace` file — worth doing so the layout persists.

You can also add folders by hand (`File → Add Folder to Workspace…`); the extension only cares that each worktree is a workspace root.

### 2. There is no step 2

Click a terminal, watch the Explorer follow.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `worktrees.follow.enabled` | `true` | Master switch for the follow behavior. |
| `worktrees.follow.collapseOthers` | `true` | Collapse all Explorer folders before revealing the active one. Turn off if you'd rather just scroll to it. |
| `worktrees.follow.restoreTerminalFocus` | `true` | Hand focus back to the terminal after the reveal (the reveal itself focuses the Explorer). |

## Requirements

- VS Code **1.93+**.
- **Terminal shell integration** must be active (it is by default for bash/zsh/fish/pwsh). If `terminal.integrated.shellIntegration.enabled` is `false`, or your prompt setup breaks the injection, the extension can't see the terminal's cwd and does nothing. Quick check: if your terminal tab titles show the current folder name, shell integration is working.

## Install

Not on the Marketplace (yet). Build the VSIX with the shell script and install it:

```bash
./package.sh
code --install-extension vscode-worktrees-0.1.0.vsix
```

Or skip packaging entirely and symlink the repo into your extensions folder:

```bash
ln -s "$(pwd)" ~/.vscode/extensions/dimamix.vscode-worktrees-0.1.0
```

(Then reload VS Code. Remove the symlink to uninstall.)

## License

[MIT](LICENSE)
