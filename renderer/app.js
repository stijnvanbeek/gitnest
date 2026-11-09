'use strict';
const api = window.gitnest;

const state = {
  tree: [],            // [{name, path, isRepo, children}]
  repoPaths: [],       // flat list of all repo paths
  statuses: {},        // repoPath -> {dirty, branch, ahead, behind}
  selected: null,      // repoPath
  expanded: new Set(), // repoPath / folder keys that are expanded
  fileTrees: {},       // repoPath -> built file tree
  log: [],
  selectedCommit: null,
  selectedFile: null,  // repo-relative path of the file selected in the tree
  currentBranch: null, // checked-out branch of the selected repo
  behindBranch: null,  // branch picked in the dropdown when the pane shows behind-commits
  branchPick: null,    // {repo, name}: branch picked in the dropdown, kept across auto-refresh
  logError: null,      // error from the last behind-log fetch, if any
  logTruncated: false, // history list hit the 100-commit display cap
  logTotal: null,      // real commit count behind the list, when known
  logSig: null,        // hash signature of the rendered log, to skip redundant rebuilds
  logQuery: '',        // history search text; filters the rows in the log list
  selection: new Set(),// change keys: "staged:<file>" | "unstaged:<file>" | "untracked:<file>"
  anchor: null,        // last clicked key, for shift-range selection
  rowOrder: [],        // keys in display order, for shift-range selection
  lastStatus: null,    // last status result, to know which files are untracked
  lastRepoClick: null, // {path, time} for double-click detection that survives tree re-renders
  lastFileClick: null, // {repoPath, relPath, time} for double-click detection on tree file rows
};

const $ = (id) => document.getElementById(id);

// ---------- helpers ----------

function relDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return d.toISOString().slice(0, 10);
}

function esc(s) {
  const div = document.createElement('div');
  div.textContent = s == null ? '' : String(s);
  return div.innerHTML;
}

function collectRepoPaths(nodes, out) {
  for (const n of nodes) {
    if (n.isRepo) out.push(n.path);
    if (n.children) collectRepoPaths(n.children, out);
  }
}

function findNode(nodes, path) {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children) {
      const hit = findNode(n.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

function setResult(text, isError) {
  const el = $('action-result');
  el.textContent = text || '';
  el.className = isError ? 'error' : 'ok';
}

// ---------- diff pane ----------

function setDiff(header, text) {
  $('diff-header').textContent = header;
  const lines = String(text).split('\n');
  $('diff-output').innerHTML = lines.map((l) => {
    const e = esc(l);
    if (l.startsWith('diff --git') || l.startsWith('+++') || l.startsWith('---')) {
      return `<span class="dl-file">${e}</span>`;
    }
    if (l.startsWith('@@')) return `<span class="dl-hunk">${e}</span>`;
    if (l.startsWith('+')) return `<span class="dl-add">${e}</span>`;
    if (l.startsWith('-')) return `<span class="dl-del">${e}</span>`;
    return e;
  }).join('\n');
}

function clearDiff(header) {
  $('diff-header').textContent = header;
  $('diff-output').textContent = '';
}

// Diff of the selected change files. Staged files diff against HEAD (--cached),
// the rest against the index; untracked files show a note (git diff skips them).
async function showChangesDiff() {
  if (!state.selected) return;
  const keys = [...state.selection];
  if (!keys.length) {
    clearDiff('Select one or more files to see their diff.');
    return;
  }
  state.selectedCommit = null;
  highlightLogSelection();

  const staged = [];
  const unstaged = [];
  const untracked = new Set((state.lastStatus && state.lastStatus.untracked) || []);
  // staged:<file> is the selection key; whether the file is actually staged
  // yet comes from the last status (a just-clicked file is staged right after).
  const stagedFiles = new Set(((state.lastStatus && state.lastStatus.staged) || []).map((x) => x.file));
  for (const k of keys) {
    const file = k.slice(k.indexOf(':') + 1);
    if (k.startsWith('untracked:')) { untracked.add(file); unstaged.push(file); }
    else if (stagedFiles.has(file)) staged.push(file);
    else unstaged.push(file);
  }

  const parts = [];
  if (staged.length) {
    const r = await api.diff(state.selected, staged, true);
    parts.push(r.error ? `error: ${r.error}` : r.text);
  }
  if (unstaged.length) {
    const r = await api.diff(state.selected, unstaged, false);
    if (r.error) parts.push(`error: ${r.error}`);
    else {
      parts.push(r.text);
      for (const f of unstaged) {
        if (untracked.has(f) && !r.text.includes(f)) {
          parts.push(`(untracked file, not yet added: ${f})`);
        }
      }
    }
  }
  setDiff(`${keys.length} file(s) selected`, parts.filter((p) => p && p.trim()).join('\n')
    || '(no diff for selection)');
}

// Diff introduced by one commit, limited to the selected file when one is picked.
async function showCommitDiff(c) {
  const paths = state.selectedFile ? [state.selectedFile] : [];
  const scope = state.selectedFile ? ` (${state.selectedFile})` : '';
  setDiff(`${c.hash} ${c.subject}${scope}`, 'Loading…');
  const r = await api.commitDiff(state.selected, c.hash, paths);
  setDiff(`${c.hash} ${c.subject}${scope}`, r.error ? `error: ${r.error}` : (r.text || '(empty commit)'));
}

// A file picked in the repository tree: its history in the top half of the
// history pane, its working-tree diff in the bottom half.
async function selectFile(repoPath, relPath) {
  if (state.selected !== repoPath) return;
  state.selectedFile = relPath;
  state.selectedCommit = null;
  state.behindBranch = null; // a file pick always shows the file's own history
  state.logError = null;
  applySelectionHighlight();
  updateSelToolbar();
  renderTree();
  $('history-pane').querySelector('.pane-header').textContent = `History — ${relPath}`;
  setDiff(`${relPath} (working tree diff)`, 'Loading…');
  const res = await api.log(repoPath, [relPath]);
  state.log = (res && res.entries) || [];
  state.logTruncated = !!(res && res.truncated);
  state.logTotal = res ? res.total : null;
  highlightLogSelection();
  renderLog();
  await showFileDiff();
}

async function showFileDiff() {
  if (!state.selected || !state.selectedFile) return;
  const r = await api.diff(state.selected, [state.selectedFile]);
  let text = r.error ? `error: ${r.error}` : r.text;
  if (!r.error && !text.trim()) {
    const untracked = ((state.lastStatus && state.lastStatus.untracked) || [])
      .some((u) => u.file === state.selectedFile);
    text = untracked ? `(untracked file, not yet added: ${state.selectedFile})` : '(no changes in this file)';
  }
  setDiff(`${state.selectedFile} (working tree diff)`, text);
}

// ---------- file trees ----------

function buildFileTree(paths) {
  // Prototype-less dirs: a real file or folder named "constructor" or
  // "__proto__" would otherwise resolve to an Object.prototype member and
  // crash the build (node.files undefined).
  const root = { dirs: Object.create(null), files: [] };
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue;
    const parts = p.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let child = node.dirs[parts[i]];
      if (!child || typeof child !== 'object') {
        child = node.dirs[parts[i]] = { dirs: Object.create(null), files: [] };
      }
      node = child;
    }
    node.files.push(parts[parts.length - 1]);
  }
  return root;
}

function renderFileTree(container, node, repoPath, prefix, depth) {
  const dirNames = Object.keys(node.dirs).sort();
  for (const dir of dirNames) {
    const key = `${repoPath}::${prefix}${dir}`;
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.style.paddingLeft = `${8 + depth * 14}px`;
    const isOpen = state.expanded.has(key);
    row.innerHTML = `<span class="tree-caret ${isOpen ? 'expanded' : ''}">▶</span>
      <span class="tree-icon folder-icon">▸</span><span class="repo-name" style="font-weight:500">${esc(dir)}</span>`;
    row.addEventListener('click', () => {
      if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key);
      renderTree();
    });
    container.appendChild(row);
    if (isOpen) {
      const sub = document.createElement('div');
      container.appendChild(sub);
      renderFileTree(sub, node.dirs[dir], repoPath, `${prefix}${dir}/`, depth + 1);
    }
  }
  for (const file of node.files) {
    const relPath = `${prefix}${file}`;
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.file = relPath;
    if (state.selectedFile === relPath) row.classList.add('selected');
    row.style.paddingLeft = `${8 + depth * 14 + 18}px`;
    row.innerHTML = `<span class="tree-icon file-icon">·</span><span>${esc(file)}</span>`;
    row.addEventListener('click', () => {
      // Same manual double-click detection as the repo rows: the single click
      // re-renders the tree, so a browser dblclick event would never arrive.
      const now = Date.now();
      const last = state.lastFileClick;
      state.lastFileClick = { repoPath, relPath, time: now };
      if (last && last.repoPath === repoPath && last.relPath === relPath && now - last.time < 500) {
        state.lastFileClick = null;
        openInEditor(repoPath, relPath);
        return;
      }
      selectFile(repoPath, relPath);
    });
    container.appendChild(row);
  }
}

// ---------- repo tree ----------

function renderTree() {
  const container = $('tree');
  container.innerHTML = '';
  renderTreeNodes(container, state.tree, 0);
}

function renderTreeNodes(container, nodes, depth) {
  for (const node of nodes) {
    const row = document.createElement('div');
    row.className = 'tree-row';
    if (node.path === state.selected) row.classList.add('selected');
    row.style.paddingLeft = `${8 + depth * 14}px`;

    const st = state.statuses[node.path];
    const hasChildren = node.isRepo && node.children && node.children.length > 0;
    const isOpen = state.expanded.has(node.path);

    let badge = '';
    if (node.isRepo && st) {
      if (st.dirty > 0) {
        badge = `<span class="dirty-badge">${st.dirty}</span>`;
      } else if (!st.error) {
        badge = `<span class="clean-badge" title="clean"></span>`;
      }
      if (st.ahead || st.behind) {
        const parts = [];
        if (st.ahead) parts.push(`↑${st.ahead}`);
        if (st.behind) parts.push(`↓${st.behind}`);
        badge += `<span class="ahead-behind">${parts.join(' ')}</span>`;
      }
    }

    row.innerHTML = `
      ${node.isRepo && hasChildren
        ? `<span class="tree-caret ${isOpen ? 'expanded' : ''}" data-caret="${esc(node.path)}">▶</span>`
        : '<span class="tree-caret"></span>'}
      <span class="tree-icon ${node.isRepo ? 'repo-icon' : 'folder-icon'}">${node.isRepo ? '⌂' : '▸'}</span>
      <span class="${node.isRepo ? 'repo-name' : 'root-name'}" title="${esc(node.path)}">${esc(node.name)}</span>
      ${badge}`;

    row.addEventListener('click', (ev) => {
      const onCaret = node.isRepo && hasChildren && ev.target.dataset && ev.target.dataset.caret !== undefined;
      if (onCaret) {
        // Single click on the caret: expand/collapse the nested repos only.
        state.lastRepoClick = null;
        if (state.expanded.has(node.path)) state.expanded.delete(node.path); else state.expanded.add(node.path);
        renderTree();
        return;
      }
      if (node.isRepo) {
        // A single click selects the repo. A double-click (detected manually:
        // the browser dblclick event is unreliable because the first click
        // selects the repo, which re-renders the tree and replaces the row)
        // additionally flips the file listing. The second click still lands
        // on the freshly rendered row, so only state carries across.
        const now = Date.now();
        const last = state.lastRepoClick;
        state.lastRepoClick = { path: node.path, time: now };
        if (last && last.path === node.path && now - last.time < 500) {
          state.lastRepoClick = null;
          toggleRepoFiles(node.path);
          return;
        }
        selectRepo(node.path);
      } else if (node.children && node.children.length) {
        // non-repo root: toggle its first repo's expansion via key on the root path
        state.lastRepoClick = null;
        const key = `root:${node.path}`;
        if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key);
        renderTree();
      }
    });

    container.appendChild(row);

    if (node.isRepo && hasChildren && isOpen) {
      const sub = document.createElement('div');
      container.appendChild(sub);
      renderTreeNodes(sub, node.children, depth + 1);
    }

    if (node.isRepo && state.expanded.has(`files:${node.path}`) && state.fileTrees[node.path]) {
      const filesBox = document.createElement('div');
      container.appendChild(filesBox);
      renderFileTree(filesBox, state.fileTrees[node.path], node.path, '', depth + 1);
    }

    // expand non-repo roots' children by default
    if (!node.isRepo && node.children && node.children.length && !state.expanded.has(`hidden:${node.path}`)) {
      const sub = document.createElement('div');
      container.appendChild(sub);
      renderTreeNodes(sub, node.children, depth + 1);
    }
  }
}

// Toggle the fold-out file listing of a repo row (double-click or caret use).
async function toggleRepoFiles(repoPath) {
  const key = `files:${repoPath}`;
  if (state.expanded.has(key)) {
    state.expanded.delete(key);
  } else {
    state.expanded.add(key);
    if (!state.fileTrees[repoPath]) await loadFileTree(repoPath);
  }
  renderTree();
}

async function loadFileTree(repoPath) {
  const paths = await api.files(repoPath);
  state.fileTrees[repoPath] = buildFileTree(Array.isArray(paths) ? paths : []);
}

// ---------- selection / status ----------

function highlightLogSelection() {
  for (const el of document.querySelectorAll('.log-row')) {
    el.classList.toggle('selected', el.dataset.hash === state.selectedCommit);
  }
}

// Keep selection sticky across a refresh: a key that vanished (e.g. the file
// moved from unstaged to staged after staging) is remapped to its new section.
function reconcileSelection(validKeys) {
  const valid = new Set(validKeys);
  const byFile = new Map();
  for (const k of validKeys) byFile.set(k.slice(k.indexOf(':') + 1), k);
  const next = new Set();
  for (const k of state.selection) {
    if (valid.has(k)) { next.add(k); continue; }
    const file = k.slice(k.indexOf(':') + 1);
    if (byFile.has(file)) next.add(byFile.get(file));
  }
  state.selection = next;
  // The anchor must stay a live row key too: staging a file changes its kind
  // prefix (untracked:x -> staged:x), and a stale anchor would silently turn
  // the next shift-click into a plain click.
  if (state.anchor && !valid.has(state.anchor)) {
    const file = state.anchor.slice(state.anchor.indexOf(':') + 1);
    state.anchor = byFile.get(file) || null;
  }
}

function applySelectionHighlight() {
  for (const el of document.querySelectorAll('.change-row')) {
    el.classList.toggle('selected', state.selection.has(el.dataset.key));
  }
}

function updateSelToolbar() {
  const n = state.selection.size;
  $('selection-info').textContent = n ? `${n} staged` : '';
}

// The selection IS the staged set: selecting a file stages it, deselecting
// unstages it. Conflicted files never take part (they need manual resolution).
async function syncStaging(prev) {
  if (!state.selected) return;
  const s = state.lastStatus;
  if (!s || s.error) return;
  const conflicted = new Set((s.conflicts || []).map((c) => c.file));
  const staged = new Set((s.staged || []).map((x) => x.file));
  const filesOf = (set) => [...set]
    .map((k) => k.slice(k.indexOf(':') + 1))
    .filter((f) => !conflicted.has(f));
  const prevFiles = filesOf(prev);
  const nextFiles = filesOf(state.selection);
  const nextSet = new Set(nextFiles);
  const toStage = nextFiles.filter((f) => !staged.has(f));
  const toUnstage = prevFiles.filter((f) => !nextSet.has(f) && staged.has(f));
  if (toStage.length) await api.stage(state.selected, toStage);
  if (toUnstage.length) await api.unstage(state.selected, toUnstage);
  if (toStage.length || toUnstage.length) {
    await Promise.all([refreshStatus(), refreshCounts()]);
  }
}

async function onChangeRowClick(key, ev) {
  if (state.selectedFile || state.behindBranch) {
    // a change click takes over from a tree-file selection or the behind view:
    // back to repo-wide history
    state.selectedFile = null;
    state.behindBranch = null;
    state.logError = null;
    renderTree();
    $('history-pane').querySelector('.pane-header').textContent = 'History';
    refreshLog();
  }
  const prev = new Set(state.selection);
  if (ev.shiftKey && state.anchor && state.rowOrder.includes(state.anchor)) {
    const a = state.rowOrder.indexOf(state.anchor);
    const b = state.rowOrder.indexOf(key);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    if (ev.metaKey || ev.ctrlKey) {
      // shift+cmd: add the range between the two clicked rows to the selection
      for (let i = lo; i <= hi; i++) state.selection.add(state.rowOrder[i]);
    } else {
      // plain shift: the range between the two clicked rows becomes the selection
      state.selection = new Set();
      for (let i = lo; i <= hi; i++) state.selection.add(state.rowOrder[i]);
    }
  } else if (ev.metaKey || ev.ctrlKey) {
    if (state.selection.has(key)) state.selection.delete(key); else state.selection.add(key);
  } else {
    state.selection = state.selection.has(key) && state.selection.size === 1
      ? new Set() : new Set([key]);
  }
  state.anchor = key;
  applySelectionHighlight();
  updateSelToolbar();
  showChangesDiff();
  await syncStaging(prev);
}

async function refreshStatus() {
  if (!state.selected) return;
  const s = await api.status(state.selected);
  state.lastStatus = s;
  const list = $('changes-list');
  list.innerHTML = '';
  state.rowOrder = [];

  if (s.error) {
    list.innerHTML = `<div class="pane-empty">${esc(s.error)}</div>`;
    $('repo-branch').textContent = '';
    reconcileSelection([]);
    updateSelToolbar();
    return;
  }

  const ab = [];
  if (s.ahead) ab.push(`↑${s.ahead}`);
  if (s.behind) ab.push(`↓${s.behind}`);
  $('repo-branch').textContent =
    `${s.branch || 'detached'}${s.upstream ? ' → ' + s.upstream : ''}${ab.length ? '  ' + ab.join(' ') : ''}`;

  // One flat list of the selected repo's changed files: staged and unstaged
  // merged, conflicts and untracked included with their markers. Sorted by
  // path so nothing jumps around when staging or unstaging; the selection IS
  // the staged set, the list itself never changes on select/unselect.
  const items = new Map();
  for (const item of s.staged) {
    items.set(item.file, { file: item.file, orig: item.orig, status: item.status, kind: 'staged' });
  }
  for (const item of s.unstaged) {
    if (!items.has(item.file)) items.set(item.file, { file: item.file, status: item.status, kind: 'unstaged' });
  }
  for (const item of s.untracked) {
    if (!items.has(item.file)) items.set(item.file, { file: item.file, status: 'untracked', kind: 'untracked' });
  }
  for (const item of s.conflicts) {
    if (!items.has(item.file)) items.set(item.file, { file: item.file, status: item.status, kind: 'conflicts' });
  }
  const flat = [...items.values()].sort((a, b) => a.file.localeCompare(b.file));

  let total = 0;
  for (const item of flat) {
    const key = item.kind;
    const selKey = `${key}:${item.file}`;
    state.rowOrder.push(selKey);
    total++;
    const row = document.createElement('div');
    row.className = 'change-row';
    row.dataset.key = selKey;
    if (state.selection.has(selKey)) row.classList.add('selected');
    if (key === 'conflicts') {
      row.innerHTML = `
        <span class="conflict-mark" title="Unresolved merge conflict (${esc(item.status)})">!</span>
        <span class="path conflicted" title="${esc(item.file)} — unresolved merge conflict">${esc(item.file)}</span>
        <button class="resolve-btn" title="Resolve the conflict in your editor first, then click to stage the file">Mark resolved</button>`;
      row.querySelector('.resolve-btn').addEventListener('click', async (ev) => {
        ev.stopPropagation();
        await api.stage(state.selected, [item.file]);
        await Promise.all([refreshStatus(), refreshCounts()]);
      });
    } else {
      const letter = key === 'untracked' ? 'untracked' : item.status;
      row.innerHTML = `
        <span class="status-letter sl-${esc(letter)}">${esc(letter[0].toUpperCase())}</span>
        <span class="path" title="${esc(item.file)}">${esc(item.file)}</span>`;
    }
    row.addEventListener('click', (ev) => onChangeRowClick(selKey, ev));
    row.addEventListener('dblclick', () => openInEditor(state.selected, item.file));
    row.addEventListener('contextmenu', async (ev) => {
      ev.preventDefault();
      // Right-clicking a row outside the selection selects it first (standard
      // behaviour), so the menu acts on what the user pointed at.
      if (!state.selection.has(selKey)) {
        const prev = new Set(state.selection);
        state.selection = new Set([selKey]);
        state.anchor = selKey;
        applySelectionHighlight();
        updateSelToolbar();
        showChangesDiff();
        await syncStaging(prev);
      }
      const act = await api.popupChangesMenu(state.selection.size);
      if (act === 'commit') {
        if (!$('btn-commit').disabled) $('btn-commit').click();
      } else if (act === 'revert') {
        $('btn-revert').click();
      }
    });
    list.appendChild(row);
  }

  if (!total) {
    list.innerHTML = '<div class="pane-empty">No changes. Working tree clean.</div>';
  }
  reconcileSelection(state.rowOrder);
  // The selection mirrors the staged set: pre-staged files (e.g. staged in a
  // previous session or before a repo switch) show as selected.
  if (!state.selection.size) {
    for (const f of s.staged) state.selection.add(`staged:${f.file}`);
  }
  applySelectionHighlight();
  updateSelToolbar();
  // Auto-refresh must not steal the diff pane back from a picked commit or
  // tree file; clicking a change row hands it back to the changes diff.
  if (state.selection.size && !state.selectedCommit && !state.selectedFile) await showChangesDiff();
  // during a merge a commit completes the merge even with an empty index
  $('btn-commit').disabled = !s.staged.length && !s.merging;
}

async function refreshLog() {
  if (!state.selected) return;
  if (state.behindBranch) return; // the behind view owns the list; applyHistoryMode fills it
  const res = await api.log(state.selected);
  state.log = (res && res.entries) || [];
  state.logTruncated = !!(res && res.truncated);
  state.logTotal = res ? res.total : null;
  // A picked commit stays picked across auto-refreshes while it is still in
  // the log; clearing it here would reset the highlight and let the diff
  // pane fall back to the changes view every 5 seconds.
  if (state.selectedCommit && !state.log.some((c) => c.hash === state.selectedCommit)) {
    state.selectedCommit = null;
  }
  // The log is uncapped and can be thousands of rows: when nothing changed,
  // skip the rebuild so the 5-second refresh stays cheap (large logs only —
  // small ones keep re-rendering so their relative dates stay fresh).
  const sig = state.log.map((c) => c.hash).join(',');
  if (sig === state.logSig && state.log.length > 300) return;
  renderLog();
}

function renderLog() {
  state.logSig = state.log.map((c) => c.hash).join(',');
  const list = $('log-list');
  list.innerHTML = '';
  if (!state.log.length) {
    list.innerHTML = state.behindBranch
      ? (state.logError ? `<div class="pane-empty">error: ${esc(state.logError)}</div>`
        : '<div class="pane-empty">Already up to date: nothing to merge.</div>')
      : '<div class="pane-empty">No commits yet.</div>';
    return;
  }
  // history search: filter over the whole (uncapped) list, matching subject,
  // author, hash and tag names
  const q = state.logQuery.trim().toLowerCase();
  const shown = q
    ? state.log.filter((c) =>
        c.subject.toLowerCase().includes(q)
        || c.author.toLowerCase().includes(q)
        || c.hash.toLowerCase().includes(q)
        || (c.tags || []).some((t) => t.toLowerCase().includes(q)))
    : state.log;
  if (q && !shown.length) {
    list.innerHTML = `<div class="pane-empty">No commits match "${esc(state.logQuery.trim())}".</div>`;
    return;
  }
  for (const c of shown) {
    const row = document.createElement('div');
    row.className = 'log-row';
    row.dataset.hash = c.hash;
    if (state.selectedCommit === c.hash) row.classList.add('selected');
    const tagBadges = (c.tags || []).map((t) => `<span class="tag-badge">${esc(t)}</span>`).join('');
    row.innerHTML = `
      <div class="subject">${tagBadges}${esc(c.subject)}</div>
      <div class="meta"><span class="hash">${esc(c.hash)}</span> · ${esc(c.author)} · ${esc(relDate(c.date))}</div>`;
    row.addEventListener('click', () => {
      state.selectedCommit = c.hash;
      highlightLogSelection();
      showCommitDiff(c);
    });
    // right-click: in behind mode cherry-pick the commit onto the checked-out
    // branch, otherwise revert it with a new "Revert ..." commit
    row.addEventListener('contextmenu', async (ev) => {
      ev.preventDefault();
      if (!state.selected) return;
      if (state.behindBranch) {
        const go = await api.popupCherryMenu(state.selected, c.hash, c.subject);
        if (!go) return;
        const r = await api.cherryPick(state.selected, c.hash);
        if (r.ok) {
          setResult(`Cherry-picked ${c.hash} onto ${state.currentBranch}.`, false);
          await Promise.all([refreshStatus(), refreshCounts()]);
          await applyHistoryMode(); // the commit is now in both branches: refresh the list
        } else if (r.conflicted) {
          setResult(`Cherry-pick has conflicts. Conflicted files are marked with "!" in the changes list.\n${r.output || r.error}`, true);
        } else {
          setResult(`Cherry-pick failed:\n${r.error || r.output || ''}`, true);
        }
        return;
      }
      const go = await api.popupRevertMenu(state.selected, c.hash, c.subject);
      if (!go) return;
      const r = await api.revertCommit(state.selected, c.hash);
      if (r.ok) {
        setResult(`Reverted ${c.hash} in a new commit.`, false);
        await Promise.all([refreshStatus(), refreshLog(), refreshBranches()]);
        await refreshCounts();
      } else {
        setResult(`Revert failed:\n${r.error || r.output || ''}`, true);
      }
    });
    list.appendChild(row);
  }
  if (state.logTruncated) {
    const note = document.createElement('div');
    note.className = 'log-truncated';
    note.textContent = state.logTotal
      ? `showing ${state.log.length} of ${state.logTotal.toLocaleString()}, older commits hidden`
      : `showing the latest ${state.log.length} commits, older ones hidden`;
    list.appendChild(note);
  } else if (q) {
    const note = document.createElement('div');
    note.className = 'log-truncated';
    note.textContent = `${shown.length.toLocaleString()} of ${state.log.length.toLocaleString()} commits match`;
    list.appendChild(note);
  }
}

// ---------- global refresh ----------

// Overlap guard: a refresh that is still running is never started again,
// no matter whether it came from the button or the auto-refresh timer.
let refreshing = false;

async function refreshCounts() {
  const statuses = await api.statuses(state.repoPaths);
  state.statuses = statuses;
  renderTree();
}

async function fullRefresh({ keepSelection = true, showIndicator = true } = {}) {
  if (refreshing) return;
  refreshing = true;
  try {
    if (showIndicator) $('scan-indicator').textContent = 'Scanning…';
    const tree = await api.scan();
    state.tree = Array.isArray(tree) ? tree : [];
    state.repoPaths = [];
    collectRepoPaths(state.tree, state.repoPaths);
    await refreshCounts();
    if (showIndicator) $('scan-indicator').textContent = '';
    if (keepSelection && state.selected && state.repoPaths.includes(state.selected)) {
      await Promise.all([refreshStatus(), refreshLog(), refreshBranches()]);
    } else if (state.selected && !state.repoPaths.includes(state.selected)) {
      state.selected = null;
      $('status-empty').hidden = false;
      $('status-content').hidden = true;
      $('history-empty').hidden = false;
      $('history-content').hidden = true;
    }
    if (!state.tree.length) showTreeHint();
    else renderTree();
  } finally {
    refreshing = false;
  }
}

// Background refresh: everything the Refresh button does, every 5 seconds,
// silently (no "Scanning…" indicator) and never overlapping a running one.
setInterval(() => { fullRefresh({ showIndicator: false }); }, 5000);

// ---------- repo actions ----------

async function runAction(label, fn) {
  setResult(`${label}…`);
  const r = await fn();
  if (r && r.ok) {
    setResult(`${label} done.`);
  } else {
    setResult(`${label} failed:\n${(r && r.error) || 'unknown error'}`, true);
  }
  await fullRefresh();
  return r;
}

// ---------- toolbar / init ----------

$('btn-add').addEventListener('click', async () => {
  const folder = await api.pickFolder();
  if (!folder) return;
  await api.addRoot(folder);
  await fullRefresh({ keepSelection: false });
});

$('btn-refresh').addEventListener('click', () => fullRefresh());

$('btn-remove-root').addEventListener('click', async () => {
  if (!state.selected) return;
  let root = state.selected;
  while (true) {
    const parent = findParentRoot(root);
    if (!parent) break;
    root = parent;
  }
  await api.removeRoot(root);
  state.selected = null;
  await fullRefresh({ keepSelection: false });
});

function findParentRoot(repoPath) {
  const roots = state.tree.map((n) => n.path);
  for (const r of roots) {
    if (repoPath !== r && repoPath.startsWith(r)) return r;
  }
  return null;
}

$('btn-fetch').addEventListener('click', () => runAction('Fetch', () => api.fetch(state.selected)));
$('btn-pull').addEventListener('click', () => runAction('Pull', () => api.pull(state.selected)));
$('btn-push').addEventListener('click', () => runAction('Push', () => api.push(state.selected)));

// ---------- branches ----------

async function refreshBranches() {
  const sel = $('branch-select');
  // A branch picked for the behind view must survive a rebuild: auto-refresh
  // calls this every 5 seconds and would otherwise snap back to the
  // checked-out branch while the user is reading the behind list.
  const pick = state.branchPick && state.branchPick.repo === state.selected
    ? state.branchPick.name : null;
  if (!state.selected) return;
  const r = await api.branches(state.selected);
  if (r.error || !r.branches || !r.branches.length) {
    sel.innerHTML = '';
    sel.dataset.sig = '';
    const o = document.createElement('option');
    o.textContent = r.error || '(no branches)';
    sel.appendChild(o);
    return;
  }
  // Signature of the branch list. Auto-refresh calls this every 5 seconds:
  // when the list is unchanged the dropdown's DOM is left alone entirely, so
  // it does not flicker (a select whose options are replaced visibly flashes,
  // and it also closes an open popup).
  const sig = r.branches.map((b) => b.name + (b.current ? '*' : '')).join('|')
    + '|' + (r.upstream || []).map((b) => b.name).join('|')
    + '|' + (r.origin || []).map((b) => b.name).join('|');
  const want = pick && [...sel.options].some((o) => o.value === pick)
    ? pick : r.current;
  if (sel.dataset.sig === sig) {
    state.currentBranch = r.current;
    if (want && sel.value !== want) {
      sel.value = want;
      applyHistoryMode();
    }
    return;
  }
  sel.dataset.sig = sig;
  sel.innerHTML = '';
  for (const b of r.branches) {
    const o = document.createElement('option');
    o.value = b.name;
    o.textContent = b.current ? `${b.name} (current)` : b.name;
    sel.appendChild(o);
  }
  // remote-only branches under their own groups. The value is the full
  // upstream/<name> or origin/<name>; checkout turns it into a local branch
  // tracking it, merge and the behind view (git log current..origin/name)
  // accept the full name. origin/ lists only branches with no local twin,
  // so a locally checked-out branch is never shown twice.
  for (const [key, label] of [['upstream', 'upstream'], ['origin', 'origin']]) {
    if (r[key] && r[key].length) {
      const group = document.createElement('optgroup');
      group.label = label;
      for (const b of r[key]) {
        const o = document.createElement('option');
        o.value = b.name;
        o.textContent = b.name;
        group.appendChild(o);
      }
      sel.appendChild(group);
    }
  }
  // restore the picked branch when it still exists, else show the current one
  if (want) sel.value = want;
  state.currentBranch = r.current;
  sel.onchange = () => {
    state.branchPick = { repo: state.selected, name: sel.value };
    applyHistoryMode();
  };
  applyHistoryMode();
}

// History pane mode: with a branch other than the checked-out one picked in
// the dropdown, the panel becomes "BEHIND <branch>" and lists the commits the
// current branch is behind it, the ones Merge would bring in. Picking the
// current branch again (or checking out, merging, ...) restores the normal
// history view.
async function applyHistoryMode() {
  if (!state.selected) return;
  const picked = $('branch-select').value;
  if (!picked || !state.currentBranch || picked === state.currentBranch) {
    if (state.behindBranch) {
      state.behindBranch = null;
      state.logError = null;
      state.selectedCommit = null;
      restoreHistoryPane();
    }
    return;
  }
  state.behindBranch = picked;
  state.logError = null;
  state.selectedCommit = null;
  state.selectedFile = null;
  renderTree();
  $('history-pane').querySelector('.pane-header').textContent = `Behind ${picked}`;
  setDiff(`Commits in ${picked} not in ${state.currentBranch}`, 'Loading…');
  const res = await api.logRange(state.selected, `${state.currentBranch}..${picked}`);
  if (state.behindBranch !== picked) return; // selection changed while fetching
  if (res && res.error) {
    state.logError = res.error;
    state.log = [];
    state.logTruncated = false;
    state.logTotal = null;
  } else {
    state.log = (res && res.entries) || [];
    state.logTruncated = !!(res && res.truncated);
    state.logTotal = res ? res.total : null;
  }
  highlightLogSelection();
  renderLog();
  const behind = state.logTotal != null ? state.logTotal : state.log.length;
  setDiff(`Commits in ${picked} not in ${state.currentBranch}`,
    state.logError ? `error: ${state.logError}`
      : behind ? `${behind} commit(s) will be merged into ${state.currentBranch}. Select one to see its diff.`
        : 'Already up to date: nothing to merge.');
}

// Back to the normal history view after behind mode: file history when a tree
// file is picked, repo history otherwise.
function restoreHistoryPane() {
  if (state.selectedFile) {
    $('history-pane').querySelector('.pane-header').textContent = `History — ${state.selectedFile}`;
    api.log(state.selected, [state.selectedFile]).then((res) => {
      if (state.behindBranch) return;
      state.log = (res && res.entries) || [];
      state.logTruncated = !!(res && res.truncated);
      state.logTotal = res ? res.total : null;
      highlightLogSelection();
      renderLog();
    });
  } else {
    $('history-pane').querySelector('.pane-header').textContent = 'History';
    refreshLog();
  }
}

$('btn-checkout').addEventListener('click', async () => {
  const name = $('branch-select').value;
  if (!name || !state.selected) return;
  await runAction(`Checkout ${name}`, () => api.checkout(state.selected, name));
  state.branchPick = null; // the dropdown follows the new current branch
  await refreshBranches();
});

$('btn-new-branch').addEventListener('click', () => {
  const inp = $('branch-name');
  inp.hidden = false;
  inp.value = '';
  inp.focus();
});

$('branch-name').addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') { $('branch-name').hidden = true; return; }
  if (e.key !== 'Enter') return;
  const name = $('branch-name').value.trim();
  if (!name || !state.selected) return;
  $('branch-name').hidden = true;
  await runAction(`Create branch ${name}`, () => api.createBranch(state.selected, name));
  state.branchPick = null; // the dropdown follows the new current branch
  await refreshBranches();
});

$('btn-delete-branch').addEventListener('click', async () => {
  const name = $('branch-select').value;
  if (!name || !state.selected) return;
  const r = await api.branches(state.selected);
  const cur = (r.branches || []).find((b) => b.current);
  if (cur && cur.name === name) {
    setResult('Cannot delete the current branch. Check out another one first.', true);
    return;
  }
  if (name.startsWith('upstream/') || name.startsWith('origin/')) {
    setResult('Cannot delete a remote branch from here. Check it out to get a local branch, then delete that.', true);
    return;
  }
  if (!confirm(`Delete branch "${name}"? Local only, the remote is never touched.`)) return;
  await runAction(`Delete branch ${name}`, () => api.deleteBranch(state.selected, name));
  await refreshBranches();
});

$('btn-merge').addEventListener('click', async () => {
  const name = $('branch-select').value;
  if (!name || !state.selected) return;
  const r0 = await api.branches(state.selected);
  const cur = (r0.branches || []).find((b) => b.current);
  if (!cur || cur.name === name) {
    setResult('Pick a different branch to merge into the current one.', true);
    return;
  }
  if (!confirm(`Merge "${name}" into "${cur.name}"?`)) return;
  setResult(`Merging ${name}…`);
  const r = await api.merge(state.selected, name);
  if (r.ok) {
    setResult(`Merged ${name} into ${cur.name}.`);
  } else if (r.conflicted) {
    setResult(`Merged with conflicts. Conflicted files are marked with "!" in the changes list.\n${r.output || r.error}`, true);
  } else {
    setResult(`Merge failed:\n${r.error || 'unknown error'}`, true);
  }
  await fullRefresh();
  await refreshBranches();
});

// ---------- settings / editor ----------

async function openSettings() {
  const cfg = await api.getConfig();
  $('settings-editor').textContent = (cfg && cfg.editor) || 'System default';
  $('settings-modal').hidden = false;
}

$('btn-settings').addEventListener('click', openSettings);
$('btn-close-settings').addEventListener('click', () => { $('settings-modal').hidden = true; });
$('settings-modal').addEventListener('click', (e) => {
  if (e.target === $('settings-modal')) $('settings-modal').hidden = true;
});
$('btn-pick-editor').addEventListener('click', async () => {
  const p = await api.pickEditor();
  if (!p) return;
  await api.setConfig({ editor: p });
  $('settings-editor').textContent = p;
});
$('btn-default-editor').addEventListener('click', async () => {
  await api.setConfig({ editor: 'default' });
  $('settings-editor').textContent = 'System default';
});

async function openInEditor(repoPath, relPath) {
  if (!repoPath || !relPath) return;
  const r = await api.openInEditor(repoPath, relPath);
  if (!r || !r.ok) setResult((r && r.error) || `Could not open ${relPath}.`, true);
}

// ---------- operation log ----------

function appendOpRow(entry) {
  const list = $('oplog-list');
  const empty = list.querySelector('.oplog-empty');
  if (empty) empty.remove();
  const row = document.createElement('div');
  row.className = `oplog-row ${entry.ok ? 'ok' : 'fail'}`;
  const time = entry.time ? new Date(entry.time).toLocaleTimeString() : '';
  row.title = `${entry.command}\n${entry.response || '(no output)'}`;
  row.innerHTML =
    `<span class="op-meta">${esc(time)} · ${esc(entry.repo || '')}</span>` +
    `<span class="op-cmd">${esc(entry.command)}</span>` +
    (entry.response ? `<span class="op-resp"> — ${esc(entry.response)}</span>` : '');
  list.prepend(row);
  while (list.children.length > 300) list.removeChild(list.lastChild);
}

function initOpLog() {
  api.getOpLog().then((entries) => {
    for (const e of (entries || []).slice().reverse()) appendOpRow(e);
  });
  api.onOp((entry) => appendOpRow(entry));
}

$('btn-commit').addEventListener('click', async () => {
  const msg = $('commit-message').value.trim();
  if (!msg) { setResult('Type a commit message first.', true); return; }
  await runAction('Commit', () => api.commit(state.selected, msg));
  $('commit-message').value = '';
});

// Revert discards the selected (staged) changes: tracked files go back to
// HEAD, untracked and staged-new files are deleted. Ask first, it's final.
$('btn-revert').addEventListener('click', async () => {
  if (!state.selected || !state.selection.size) return;
  const s = state.lastStatus || {};
  const conflicted = new Set((s.conflicts || []).map((c) => c.file));
  const files = [...state.selection]
    .map((k) => k.slice(k.indexOf(':') + 1))
    .filter((f) => !conflicted.has(f));
  if (!files.length) { setResult('Conflicted files need manual resolution first.', true); return; }
  const lines = files.slice(0, 20).join('\n');
  const more = files.length > 20 ? `\n… and ${files.length - 20} more` : '';
  if (!confirm(`Revert changes in ${files.length} file(s)?\n\n${lines}${more}\n\nTracked files go back to HEAD, untracked files are deleted. This cannot be undone.`)) return;
  const r = await api.revert(state.selected, files);
  if (r.ok) {
    setResult('Reverted.', false);
    state.selection = new Set();
    state.anchor = null;
    await fullRefresh();
  } else {
    setResult(`Revert failed:\n${r.error}`, true);
  }
});

// Enter without shift commits (like GitHub Desktop)
$('commit-message').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!$('btn-commit').disabled) $('btn-commit').click();
  }
});

// History search: filter the log list as you type. Escape clears and gives
// the focus back so keyboard scrolling of the list keeps working.
$('log-search').addEventListener('input', () => {
  state.logQuery = $('log-search').value;
  renderLog();
});
$('log-search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    $('log-search').value = '';
    state.logQuery = '';
    renderLog();
    $('log-search').blur();
  }
});

async function selectRepo(repoPath) {
  state.selected = repoPath;
  state.selectedCommit = null;
  state.selectedFile = null;
  state.behindBranch = null;
  state.currentBranch = null;
  state.logError = null;
  state.logTruncated = false;
  state.logTotal = null;
  state.logQuery = '';
  $('log-search').value = '';
  state.logSig = null;
  state.selection = new Set();
  state.anchor = null;
  $('history-pane').querySelector('.pane-header').textContent = 'History';
  $('history-empty').hidden = true;
  $('history-content').hidden = false;
  clearDiff('Select a file or a commit to see its diff.');
  $('status-empty').hidden = true;
  $('status-content').hidden = false;

  const node = findNode(state.tree, repoPath);
  $('repo-name').textContent = node ? node.name : repoPath;
  $('commit-message').value = '';
  setResult('');

  await Promise.all([refreshStatus(), refreshLog(), refreshBranches()]);
  renderTree();
}

// ---------- resizable panes ----------

// Drag a splitter to resize; double-click resets to the stylesheet default.
function setupSplitters() {
  const colResize = (splitterId, paneId) => {
    const el = $(splitterId);
    const pane = $(paneId);
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      el.classList.add('dragging');
      const startX = e.clientX;
      const startW = pane.getBoundingClientRect().width;
      const move = (ev) => {
        const w = Math.max(180, startW + ev.clientX - startX);
        pane.style.flex = 'none';
        pane.style.width = `${w}px`;
      };
      const up = () => {
        el.classList.remove('dragging');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    el.addEventListener('dblclick', () => { pane.style.flex = ''; pane.style.width = ''; });
  };
  colResize('split-tree', 'tree-pane');
  colResize('split-status', 'status-pane');

  const h = $('hsplit');
  const top = $('log-list');
  h.addEventListener('mousedown', (e) => {
    e.preventDefault();
    h.classList.add('dragging');
    const startY = e.clientY;
    const startH = top.getBoundingClientRect().height;
    const move = (ev) => {
      const parentH = top.parentElement.getBoundingClientRect().height;
      const hh = Math.min(Math.max(60, startH + ev.clientY - startY), Math.max(60, parentH - 80));
      top.style.flex = `0 0 ${hh}px`;
    };
    const up = () => {
      h.classList.remove('dragging');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  h.addEventListener('dblclick', () => { top.style.flex = ''; });

  // splitter between the repo tree and the git op-log in the left pane
  const h2 = $('hsplit-tree');
  const oplog = $('oplog-pane');
  h2.addEventListener('mousedown', (e) => {
    e.preventDefault();
    h2.classList.add('dragging');
    const startY = e.clientY;
    const startH = oplog.getBoundingClientRect().height;
    const move = (ev) => {
      const hh = Math.min(Math.max(60, startH - (ev.clientY - startY)), 600);
      oplog.style.height = `${hh}px`;
    };
    const up = () => {
      h2.classList.remove('dragging');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  h2.addEventListener('dblclick', () => { oplog.style.height = ''; });
}

function showTreeHint() {
  $('tree').innerHTML =
    '<div class="pane-empty">No repositories yet.<br><br>' +
    'Click "Add Repository…" above and pick your main repo (e.g. nap). ' +
    'Nested repos inside it are found automatically.</div>';
}

(async function init() {
  setupSplitters();
  initOpLog();
  const cfg = await api.getConfig();
  if (cfg && cfg.roots && cfg.roots.length) {
    await fullRefresh({ keepSelection: false });
  } else {
    showTreeHint();
  }
})();
