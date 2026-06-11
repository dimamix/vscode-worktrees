'use strict';

const vscode = require('vscode');
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execFileAsync = promisify(execFile);

let output;
let lastRevealedFolder;

function log(message) {
  if (output) {
    output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }
}

function followConfig() {
  return vscode.workspace.getConfiguration('worktrees.follow');
}

// The shell's cwd as the OS sees it. Works even when shell integration is
// silent (e.g. a TUI has been running since before integration attached).
async function processCwd(terminal) {
  const pid = await terminal.processId;
  if (!pid) {
    return undefined;
  }
  if (process.platform === 'linux') {
    const { stdout } = await execFileAsync('readlink', ['-f', `/proc/${pid}/cwd`]);
    return vscode.Uri.file(stdout.trim());
  }
  if (process.platform === 'darwin') {
    const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const line = stdout.split('\n').find((l) => l.startsWith('n'));
    if (line) {
      return vscode.Uri.file(line.slice(1));
    }
  }
  return undefined;
}

async function terminalCwd(terminal) {
  const integrationCwd = terminal.shellIntegration && terminal.shellIntegration.cwd;
  if (integrationCwd) {
    return integrationCwd;
  }
  log('shell integration cwd unavailable; querying the OS');
  try {
    const osCwd = await processCwd(terminal);
    if (osCwd) {
      return osCwd;
    }
  } catch (err) {
    log(`OS cwd lookup failed: ${err && err.message}`);
  }
  // Last resort: the (static) cwd the terminal was created with.
  const created = terminal.creationOptions && terminal.creationOptions.cwd;
  if (created) {
    return typeof created === 'string' ? vscode.Uri.file(created) : created;
  }
  return undefined;
}

// Revealing a folder only selects it; revealing something inside it is what
// forces the Explorer to expand the chain down to the cwd.
async function expandTarget(cwd) {
  try {
    const entries = await vscode.workspace.fs.readDirectory(cwd);
    const visible = entries
      .map(([name]) => name)
      .filter((name) => !name.startsWith('.'))
      .sort();
    if (visible.length > 0) {
      return vscode.Uri.joinPath(cwd, visible[0]);
    }
  } catch (err) {
    log(`readDirectory failed for ${cwd.fsPath}: ${err && err.message}`);
  }
  return cwd;
}

async function followTerminal(terminal, reason) {
  if (!followConfig().get('enabled', true) || !terminal) {
    return;
  }
  const cwd = await terminalCwd(terminal);
  if (!cwd) {
    log(`(${reason}) no cwd resolvable for terminal "${terminal.name}"`);
    return;
  }
  const folder = vscode.workspace.getWorkspaceFolder(cwd);
  if (!folder) {
    log(`(${reason}) cwd ${cwd.fsPath} is not inside any workspace folder`);
    return;
  }
  // Re-revealing within the same root would collapse trees the user
  // expanded by hand, so only act when the terminal's root changes.
  if (folder.uri.toString() === lastRevealedFolder) {
    return;
  }
  lastRevealedFolder = folder.uri.toString();
  log(`(${reason}) cwd ${cwd.fsPath} -> revealing workspace folder "${folder.name}"`);

  if (followConfig().get('collapseOthers', true)) {
    await vscode.commands.executeCommand('workbench.files.action.collapseExplorerFolders');
  }
  await vscode.commands.executeCommand('revealInExplorer', await expandTarget(cwd));
  await vscode.commands.executeCommand('revealInExplorer', cwd);
  if (followConfig().get('restoreTerminalFocus', true)) {
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
  output = vscode.window.createOutputChannel('Worktree Terminal Follow');
  context.subscriptions.push(output);
  log('activated');

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTerminal((terminal) => {
      followTerminal(terminal, 'active terminal changed');
    }),
    // Catches the cwd becoming available right after a terminal opens, and
    // `cd` between worktrees inside an already-active terminal.
    vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal === vscode.window.activeTerminal) {
        followTerminal(event.terminal, 'shell integration update');
      }
    }),
    vscode.commands.registerCommand('worktrees.addWorktreesToWorkspace', addWorktreesToWorkspace)
  );

  followTerminal(vscode.window.activeTerminal, 'startup');
}

function deactivate() {}

module.exports = { activate, deactivate };
