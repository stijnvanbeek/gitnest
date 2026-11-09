'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs/promises');
const git = require('./lib/git');

let win = null;

function configPath() {
  return path.join(app.getPath('userData'), 'gitnest-config.json');
}

async function readConfig() {
  try {
    return JSON.parse(await fs.readFile(configPath(), 'utf8'));
  } catch {
    return { roots: [] };
  }
}

async function writeConfig(cfg) {
  await fs.writeFile(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
}

// Open a file in the user's chosen editor ('default' or a command/app path).
function execDetached(cmd, args) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { detached: process.platform !== 'win32', stdio: 'ignore' },
      (err) => resolve(!err));
    child.on('error', () => resolve(false));
    child.unref();
  });
}

async function openInEditor(repo, relPath) {
  const full = path.join(repo, relPath);
  const cfg = await readConfig();
  const editor = ((cfg.editor || 'default') + '').trim() || 'default';
  let ok = false;
  if (editor === 'default') {
    if (process.platform === 'darwin') ok = await execDetached('open', [full]);
    else if (process.platform === 'win32') ok = await execDetached('cmd', ['/c', 'start', '', full]);
    else ok = await execDetached('xdg-open', [full]);
  } else if (process.platform === 'darwin' && /\.app\/?$/i.test(editor)) {
    ok = await execDetached('open', ['-a', editor.replace(/\/+$/, ''), full]);
  } else {
    const parts = editor.split(/\s+/);
    ok = await execDetached(parts[0], [...parts.slice(1), full]);
  }
  return ok ? { ok: true } : { ok: false, error: `Could not open "${editor}". Check it in Settings.` };
}

// Build the repo tree for all configured roots. Every found repo becomes a
// node; a repo nested inside another repo becomes a child of its nearest
// ancestor repo, so nap and nap/modules/... appear as parent and children.
async function buildTree(roots) {
  const tree = [];
  for (const root of roots) {
    let found = [];
    try {
      found = await git.findRepos(root);
    } catch {
      found = [];
    }
    const rootNode = {
      name: path.basename(root) || root,
      path: root,
      isRepo: await git.isRepo(root),
      children: [],
    };
    const repoNodes = new Map(); // repo path -> node
    for (const rp of found) {
      if (rp === root) continue; // the root itself is the rootNode, don't duplicate it
      repoNodes.set(rp, { name: path.basename(rp), path: rp, isRepo: true, children: [] });
    }
    for (const rp of found) {
      if (rp === root) continue;
      const node = repoNodes.get(rp);
      let parent = path.dirname(rp);
      let attached = false;
      while (parent === root || parent.startsWith(root + path.sep)) {
        if (repoNodes.has(parent)) {
          repoNodes.get(parent).children.push(node);
          attached = true;
          break;
        }
        const next = path.dirname(parent);
        if (next === parent) break;
        parent = next;
      }
      if (!attached) rootNode.children.push(node);
    }
    tree.push(rootNode);
  }
  return tree;
}

function registerHandlers() {
  ipcMain.handle('config:get', () => readConfig());

  ipcMain.handle('roots:add', async (e, p) => {
    const cfg = await readConfig();
    if (!cfg.roots.includes(p)) cfg.roots.push(p);
    await writeConfig(cfg);
    return cfg.roots;
  });

  ipcMain.handle('roots:remove', async (e, p) => {
    const cfg = await readConfig();
    cfg.roots = cfg.roots.filter((r) => r !== p);
    await writeConfig(cfg);
    return cfg.roots;
  });

  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  // Pick an editor application: on macOS an .app bundle, elsewhere an executable.
  ipcMain.handle('dialog:pickEditor', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'Applications / executables', extensions: ['app', 'exe', '*'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('config:set', async (e, patch) => {
    const cfg = await readConfig();
    Object.assign(cfg, patch);
    await writeConfig(cfg);
    return cfg;
  });

  ipcMain.handle('git:oplog', () => git.getOpLog());
  git.onOp((entry) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('git:op', entry);
    }
  });

  ipcMain.handle('repo:branches', (e, repo) => git.branches(repo));
  ipcMain.handle('repo:checkout', (e, repo, name) => git.checkout(repo, name));
  ipcMain.handle('repo:createbranch', (e, repo, name) => git.createBranch(repo, name));
  ipcMain.handle('repo:deletebranch', (e, repo, name) => git.deleteBranch(repo, name));
  ipcMain.handle('repo:merge', (e, repo, name) => git.merge(repo, name));
  ipcMain.handle('repo:revert', (e, repo, paths) => git.revert(repo, paths));
  ipcMain.handle('repo:revertcommit', (e, repo, hash) => git.revertCommit(repo, hash));
  ipcMain.handle('repo:cherrypick', (e, repo, hash) => git.cherryPick(repo, hash));

  // Popup menu on a history row: resolves to true when the user picked
  // "Revert", false when the menu was dismissed by clicking elsewhere.
  ipcMain.handle('menu:revertcommit', (e, repo, hash, subject) => new Promise((resolve) => {
    let picked = false;
    const menu = Menu.buildFromTemplate([
      {
        label: `Revert commit ${hash} ("${(subject || '').slice(0, 60)}")`,
        click: () => { picked = true; resolve(true); },
      },
    ]);
    menu.on('menu-will-close', () => setTimeout(() => resolve(picked), 0));
    menu.popup({ window: BrowserWindow.fromWebContents(e.sender) });
  }));

  // Popup menu on a row of the behind list: cherry-picks the commit from the
  // selected branch onto the checked-out branch. Clicking elsewhere closes
  // the menu without acting.
  ipcMain.handle('menu:cherrypick', (e, repo, hash, subject) => new Promise((resolve) => {
    let picked = false;
    const menu = Menu.buildFromTemplate([
      {
        label: `Cherry-pick commit ${hash} ("${(subject || '').slice(0, 60)}")`,
        click: () => { picked = true; resolve(true); },
      },
    ]);
    menu.on('menu-will-close', () => setTimeout(() => resolve(picked), 0));
    menu.popup({ window: BrowserWindow.fromWebContents(e.sender) });
  }));

  // Popup menu on a changes row: commit the selection (uses the commit
  // message box) or discard its changes. Resolves to 'commit', 'revert' or
  // null when dismissed by clicking elsewhere.
  ipcMain.handle('menu:changes', (e, n) => new Promise((resolve) => {
    let picked = null;
    const menu = Menu.buildFromTemplate([
      { label: `Commit ${n} file(s)`, click: () => { picked = 'commit'; resolve(picked); } },
      { label: `Revert changes in ${n} file(s)`, click: () => { picked = 'revert'; resolve(picked); } },
    ]);
    menu.on('menu-will-close', () => setTimeout(() => resolve(picked), 0));
    menu.popup({ window: BrowserWindow.fromWebContents(e.sender) });
  }));

  ipcMain.handle('repo:openineditor', (e, repo, relPath) => openInEditor(repo, relPath));

  ipcMain.handle('repos:scan', async () => {
    const cfg = await readConfig();
    return buildTree(cfg.roots);
  });

  // Batched dirty-state for every repo in the tree: one call from the renderer.
  ipcMain.handle('repos:statuses', async (e, repoPaths) => {
    const out = {};
    await Promise.all((repoPaths || []).map(async (rp) => {
      const s = await git.status(rp);
      out[rp] = s.error
        ? { dirty: 0, error: s.error }
        : { branch: s.branch, upstream: s.upstream, ahead: s.ahead, behind: s.behind, dirty: s.dirty };
    }));
    return out;
  });

  ipcMain.handle('repo:status', (e, repo) => git.status(repo));
  ipcMain.handle('repo:files', (e, repo) => git.files(repo));
  ipcMain.handle('repo:stage', (e, repo, paths) => git.stage(repo, paths));
  ipcMain.handle('repo:unstage', (e, repo, paths) => git.unstage(repo, paths));
  ipcMain.handle('repo:commit', (e, repo, message) => git.commit(repo, message));
  ipcMain.handle('repo:push', (e, repo) => git.push(repo));
  ipcMain.handle('repo:pull', (e, repo) => git.pull(repo));
  ipcMain.handle('repo:fetch', (e, repo) => git.fetchAll(repo));
  ipcMain.handle('repo:log', (e, repo, paths) => git.log(repo, 0, paths || []));
  ipcMain.handle('repo:logrange', (e, repo, range) => git.logRange(repo, range));
  ipcMain.handle('repo:show', (e, repo, hash) => git.show(repo, hash));
  ipcMain.handle('repo:diff', (e, repo, paths, cached) => git.diff(repo, paths, cached));
  ipcMain.handle('repo:commitdiff', (e, repo, hash, paths) => git.commitDiff(repo, hash, paths || []));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 650,
    title: 'GitNest',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  registerHandlers();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
