'use strict';

const vscode = require('vscode');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
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

// All known cwd sources, most-trustworthy first. Shell integration leads:
// it updates at every prompt render, follows nested shells (nix develop,
// subshells) the OS lookup cannot see, and reports logical (symlink-aware)
// paths. Deliberate trade-off, not an accident of ordering: when present,
// integration's value stays correct under a TUI (a TUI never changes the
// shell's cwd) and across window reloads (the processes survive), whereas
// the OS lookup only sees the ROOT shell — provably wrong under nested
// shells. The OS cwd covers terminals where integration never attached and
// is consulted whenever integration maps outside every workspace folder;
// the static creation cwd is the last resort.
async function cwdCandidates(terminal) {
  const candidates = [];
  const integrationCwd = terminal.shellIntegration && terminal.shellIntegration.cwd;
  if (integrationCwd) {
    candidates.push({ cwd: integrationCwd, source: 'shell integration' });
  }
  try {
    const osCwd = await processCwd(terminal);
    if (osCwd) {
      candidates.push({ cwd: osCwd, source: 'os' });
    }
  } catch (err) {
    log(`OS cwd lookup failed: ${err && err.message}`);
  }
  const created = terminal.creationOptions && terminal.creationOptions.cwd;
  if (created) {
    candidates.push({
      cwd: typeof created === 'string' ? vscode.Uri.file(created) : created,
      source: 'creation options',
    });
  }
  return candidates;
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
  const candidates = await cwdCandidates(terminal);
  if (generation !== followGeneration) {
    return;
  }
  if (candidates.length === 0) {
    log(`(${reason}) no cwd resolvable for terminal "${terminal.name}"`);
    return;
  }
  // Candidates group by the physical directory they name; groups keep
  // source order, so a fresher source's directory is preferred and a later
  // group is only a fallback when earlier ones map to no workspace folder.
  // Within a group (symlinked aliases of one directory), the match with the
  // fewest path segments between folder root and cwd wins — 0 means the cwd
  // IS that root. Path-string length is meaningless across alias namespaces.
  const physicalPath = (p) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return p;
    }
  };
  const relativeDepth = (cwd, folderUri) =>
    cwd.fsPath.slice(folderUri.fsPath.length).split(path.sep).filter(Boolean).length;
  const groups = [];
  for (const candidate of candidates) {
    const physical = physicalPath(candidate.cwd.fsPath);
    let group = groups.find((g) => g.physical === physical);
    if (!group) {
      group = { physical, members: [] };
      groups.push(group);
    }
    group.members.push(candidate);
  }
  let folder;
  let resolved;
  let bestDepth = Infinity;
  for (const group of groups) {
    for (const member of group.members) {
      const match = workspaceFolderFor(member.cwd);
      if (!match) {
        continue;
      }
      const depth = relativeDepth(member.cwd, match.uri);
      if (!folder || depth < bestDepth) {
        folder = match;
        resolved = member;
        bestDepth = depth;
      }
    }
    if (folder) {
      break;
    }
  }
  if (!folder) {
    log(
      `(${reason}) "${terminal.name}" no candidate cwd inside a workspace folder: ` +
        candidates.map((c) => `${c.cwd.fsPath} [${c.source}]`).join(', ')
    );
    return;
  }
  log(
    `(${reason}) "${terminal.name}" cwd ${resolved.cwd.fsPath} [${resolved.source}] -> ` +
      `workspace folder "${folder.name}"`
  );
  // Re-revealing within the same root would collapse trees the user
  // expanded by hand, so only act when the terminal's root changes.
  if (folder.uri.toString() === lastRevealedFolder) {
    log(`(${reason}) already on "${folder.name}"; nothing to do`);
    return;
  }
  // Cleared for the whole mutation: if this invocation is superseded
  // half-done, the guard must not claim the reveal happened.
  lastRevealedFolder = undefined;

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
  // updateWorkspaceFolders reject the whole batch. Case-fold the comparison
  // key on case-insensitive platforms — Uri normalizes the drive letter but
  // preserves component casing.
  const compareKey = (uri) =>
    process.platform === 'win32' || process.platform === 'darwin'
      ? uri.toString().toLowerCase()
      : uri.toString();
  const known = new Set(folders.map((f) => compareKey(f.uri)));
  const discovered = new Map();
  for (const folder of folders) {
    for (const worktree of await listWorktrees(folder)) {
      const uri = vscode.Uri.file(worktree);
      discovered.set(compareKey(uri), uri.toString());
    }
  }

  const toAdd = [...discovered.entries()]
    .filter(([key]) => !known.has(key))
    .map(([, uri]) => uri);
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
