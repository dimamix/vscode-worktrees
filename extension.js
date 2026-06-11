'use strict';

const vscode = require('vscode');
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execFileAsync = promisify(execFile);

let lastRevealedFolder;

function followConfig() {
  return vscode.workspace.getConfiguration('worktrees.follow');
}

async function followTerminal(terminal) {
  if (!followConfig().get('enabled', true)) {
    return;
  }
  // Provided by VS Code shell integration; undefined until integration
  // attaches (a moment after the terminal opens) or if it's disabled.
  const cwd = terminal && terminal.shellIntegration && terminal.shellIntegration.cwd;
  if (!cwd) {
    return;
  }
  const folder = vscode.workspace.getWorkspaceFolder(cwd);
  if (!folder) {
    return;
  }
  // Re-revealing within the same root would collapse trees the user
  // expanded by hand, so only act when the terminal's root changes.
  if (folder.uri.toString() === lastRevealedFolder) {
    return;
  }
  lastRevealedFolder = folder.uri.toString();

  if (followConfig().get('collapseOthers', true)) {
    await vscode.commands.executeCommand('workbench.files.action.collapseExplorerFolders');
  }
  await vscode.commands.executeCommand('revealInExplorer', cwd);
  if (followConfig().get('restoreTerminalFocus', true) && terminal) {
    terminal.show();
  }
}

async function listWorktrees(folder) {
  try {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
      cwd: folder.uri.fsPath,
    });
    return stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).trim());
  } catch {
    // Not a git repository, or git is not installed.
    return [];
  }
}

async function addWorktreesToWorkspace() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) {
    vscode.window.showWarningMessage(
      'Open a folder inside a git repository first, then re-run this command.'
    );
    return;
  }

  const known = new Set(folders.map((f) => f.uri.fsPath));
  const discovered = new Set();
  for (const folder of folders) {
    for (const worktree of await listWorktrees(folder)) {
      discovered.add(worktree);
    }
  }

  const toAdd = [...discovered].filter((p) => !known.has(p));
  if (toAdd.length === 0) {
    vscode.window.showInformationMessage('All worktrees are already workspace folders.');
    return;
  }

  vscode.workspace.updateWorkspaceFolders(
    folders.length,
    0,
    ...toAdd.map((p) => ({ uri: vscode.Uri.file(p), name: path.basename(p) }))
  );
  vscode.window.showInformationMessage(
    `Added ${toAdd.length} worktree folder${toAdd.length === 1 ? '' : 's'} to the workspace.`
  );
}

function activate(context) {
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTerminal((terminal) => {
      followTerminal(terminal);
    }),
    // Catches the cwd becoming available right after a terminal opens, and
    // `cd` between worktrees inside an already-active terminal.
    vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal === vscode.window.activeTerminal) {
        followTerminal(event.terminal);
      }
    }),
    vscode.commands.registerCommand('worktrees.addWorktreesToWorkspace', addWorktreesToWorkspace)
  );

  followTerminal(vscode.window.activeTerminal);
}

function deactivate() {}

module.exports = { activate, deactivate };
