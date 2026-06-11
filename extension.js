'use strict';

const vscode = require('vscode');
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execFileAsync = promisify(execFile);

let output;
let lastRevealedFolder;
// Rapid terminal switches overlap in followTerminal's awaits; only the
// newest invocation is allowed to touch the Explorer or focus.
let followGeneration = 0;

function log(message) {
  if (output) {
    output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }
}

function followConfig() {
  return vscode.workspace.getConfiguration('worktrees.follow');
}

// The shell's cwd as the OS sees it — ground truth. Shell integration's cwd
// can be stale: terminals revived after a window reload, or a TUI running
// since before integration attached, keep reporting an old directory.
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
  try {
    const osCwd = await processCwd(terminal);
    if (osCwd) {
      return { cwd: osCwd, source: 'os' };
    }
  } catch (err) {
    log(`OS cwd lookup failed: ${err && err.message}`);
  }
  const integrationCwd = terminal.shellIntegration && terminal.shellIntegration.cwd;
  if (integrationCwd) {
    return { cwd: integrationCwd, source: 'shell integration' };
  }
  // Last resort: the (static) cwd the terminal was created with.
  const created = terminal.creationOptions && terminal.creationOptions.cwd;
  if (created) {
    return {
      cwd: typeof created === 'string' ? vscode.Uri.file(created) : created,
      source: 'creation options',
    };
  }
  return undefined;
}

// Explicit longest-prefix match over workspace folders. With nested roots —
// a repo plus its worktrees under <repo>/.worktrees/ — the innermost folder
// must win, and this must not depend on getWorkspaceFolder's tie-breaking.
function workspaceFolderFor(uri) {
  // Trailing separator prevents /a/b matching /a/bc; roots like / or C:\
  // already end with one. macOS and Windows filesystems are case-insensitive
  // by default, so compare case-folded there. Known trade-off: on an opt-in
  // case-SENSITIVE volume, sibling folders differing only by case conflate.
  const normalize = (p) => {
    const cased =
      process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p;
    return cased.endsWith(path.sep) ? cased : cased + path.sep;
  };
  const target = normalize(uri.fsPath);
  let best;
  let bestLength = -1;
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const prefix = normalize(folder.uri.fsPath);
    if (target.startsWith(prefix) && prefix.length > bestLength) {
      best = folder;
      bestLength = prefix.length;
    }
  }
  return best;
}

// Revealing a folder only selects it; revealing something inside it is what
// forces the Explorer to expand the chain down to the cwd.
async function expandTarget(cwd) {
  try {
    const entries = await vscode.workspace.fs.readDirectory(cwd);
    const names = entries.map(([name]) => name).sort();
    const pick =
      names.find((name) => !name.startsWith('.')) ||
      // Dotfile fallback for hidden-only dirs; .git stays out because the
      // Explorer hides it by default and won't reveal it.
      names.find((name) => name !== '.git' && name !== '.DS_Store');
    if (pick) {
      return vscode.Uri.joinPath(cwd, pick);
    }
  } catch (err) {
    log(`readDirectory failed for ${cwd.fsPath}: ${err && err.message}`);
  }
  return cwd;
}

async function followTerminal(terminal, reason) {
  // Bump first even when bailing: switching to "no terminal" must cancel
  // any follow still in flight for a previous terminal.
  const generation = ++followGeneration;
  if (!terminal || !followConfig().get('enabled', true)) {
    return;
  }
  const resolved = await terminalCwd(terminal);
  if (generation !== followGeneration) {
    return;
  }
  if (!resolved) {
    log(`(${reason}) no cwd resolvable for terminal "${terminal.name}"`);
    return;
  }
  const folder = workspaceFolderFor(resolved.cwd);
  log(
    `(${reason}) "${terminal.name}" cwd ${resolved.cwd.fsPath} [${resolved.source}] -> ` +
      (folder ? `workspace folder "${folder.name}"` : 'no workspace folder')
  );
  if (!folder) {
    return;
  }
  // Re-revealing within the same root would collapse trees the user
  // expanded by hand, so only act when the terminal's root changes.
  if (folder.uri.toString() === lastRevealedFolder) {
    log(`(${reason}) already on "${folder.name}"; nothing to do`);
    return;
  }

  if (followConfig().get('collapseOthers', true)) {
    await vscode.commands.executeCommand('workbench.files.action.collapseExplorerFolders');
  }
  const target = await expandTarget(resolved.cwd);
  if (generation !== followGeneration) {
    return;
  }
  await vscode.commands.executeCommand('revealInExplorer', target);
  if (generation !== followGeneration) {
    return;
  }
  await vscode.commands.executeCommand('revealInExplorer', resolved.cwd);
  if (generation !== followGeneration) {
    return;
  }
  // Recorded only after the reveal really happened — a canceled invocation
  // must not suppress the next switch back to this folder.
  lastRevealedFolder = folder.uri.toString();
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

  // Compare normalized Uris, not raw paths: on Windows git emits forward
  // slashes while fsPath uses backslashes, and one duplicate would make
  // updateWorkspaceFolders reject the whole batch.
  const known = new Set(folders.map((f) => f.uri.toString()));
  const discovered = new Set();
  for (const folder of folders) {
    for (const worktree of await listWorktrees(folder)) {
      discovered.add(vscode.Uri.file(worktree).toString());
    }
  }

  const toAdd = [...discovered].filter((uri) => !known.has(uri));
  if (toAdd.length === 0) {
    vscode.window.showInformationMessage('All worktrees are already workspace folders.');
    return;
  }

  vscode.workspace.updateWorkspaceFolders(
    folders.length,
    0,
    ...toAdd.map((uri) => {
      const parsed = vscode.Uri.parse(uri);
      return { uri: parsed, name: path.basename(parsed.fsPath) };
    })
  );
  vscode.window.showInformationMessage(
    `Added ${toAdd.length} worktree folder${toAdd.length === 1 ? '' : 's'} to the workspace.`
  );
}

function activate(context) {
  output = vscode.window.createOutputChannel('Worktree Terminal Follow');
  context.subscriptions.push(output);
  log(`activated v${context.extension.packageJSON.version}`);

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
