'use strict';
// Git operations for GitNest. Plain child_process git, no dependencies,
// so the same module works in Electron's main process and in plain node (tests).

const { execFile } = require('child_process');
const fsp = require('fs/promises');
const path = require('path');

const SKIP_DIRS = new Set([
  'node_modules', 'build', 'dist', 'out', 'target', 'bin', 'obj',
  '.venv', 'venv', '__pycache__', '.gradle', '.idea', '.cache', 'DerivedData',
]);

// When GitNest is launched from Finder it inherits the minimal Finder PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), so git helpers installed by Homebrew are
// invisible to git: filters like "git-lfs filter-process" (used by .gitattributes)
// fail with "git-lfs: command not found". Prepend the common prefix locations.
function gitEnv() {
  const cur = process.env.PATH || '';
  const have = new Set(cur.split(':'));
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/local/sbin'].filter((d) => !have.has(d));
  return { ...process.env, PATH: [...extra, cur].filter(Boolean).join(':') };
}

// Run a git command, never throws: resolves { ok, code, stdout, stderr }
function run(cwd, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout, windowsHide: true, env: gitEnv() },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: stdout || '',
          stderr: stderr || '',
        });
      });
  });
}

// ---- operation log -------------------------------------------------------
// Only commands that modify the repository are logged (stage, commit, push,
// branch operations, ...). Informative calls (status, log, diff) are not.
const opLog = [];
const opListeners = [];

function onOp(cb) { opListeners.push(cb); }

function getOpLog() { return opLog.slice(); }

function logOp(cwd, args, r) {
  // Staging via the selection spams the log with git add / git reset (and the
  // no-commits fallback git rm --cached); leave those quiet calls out.
  if (args[0] === 'add' || args[0] === 'reset' || (args[0] === 'rm' && args.includes('--cached'))) return;
  const entry = {
    time: new Date().toISOString(),
    repo: path.basename(cwd) || cwd,
    command: ['git', ...args].join(' '),
    ok: r.ok,
    response: (r.stderr || r.stdout || '').trim(),
  };
  opLog.unshift(entry);
  if (opLog.length > 300) opLog.length = 300;
  for (const cb of opListeners) {
    try { cb(entry); } catch { /* listener errors never break the op */ }
  }
}

// Run a git command that modifies the repository, and log it.
async function mutating(cwd, args, timeout) {
  const r = await run(cwd, args, timeout);
  logOp(cwd, args, r);
  return r;
}

async function isRepo(dir) {
  try {
    const st = await fsp.lstat(path.join(dir, '.git'));
    return true; // .git may be a directory or a file (submodules, worktrees)
  } catch {
    return false;
  }
}

// Walk rootPath and return every directory containing a .git entry.
// A repo nested inside another repo is found too: detection happens per
// directory, and we keep descending so nap/modules/... style trees come out whole.
async function findRepos(rootPath, maxDepth = 5) {
  const found = [];
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '.git')) found.push(dir);
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === '.git' || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      await walk(path.join(dir, e.name), depth + 1);
    }
  }
  await walk(rootPath, 0);
  return found.sort();
}

function parseStatus(text) {
  const result = { branch: null, upstream: null, ahead: 0, behind: 0, entries: [] };
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      const m = line.slice(3);
      const branchPart = m.split(' [')[0];
      const [local, remote] = branchPart.split('...');
      result.branch = local.trim();
      result.upstream = remote ? remote.trim() : null;
      const ab = m.match(/ahead (\d+)/);
      if (ab) result.ahead = parseInt(ab[1], 10);
      const bb = m.match(/behind (\d+)/);
      if (bb) result.behind = parseInt(bb[1], 10);
    } else if (line.length >= 3 && line !== '#') {
      const x = line[0];
      const y = line[1];
      let file = line.slice(3);
      let orig = null;
      const arrow = file.indexOf(' -> ');
      if (arrow !== -1) {
        orig = file.slice(0, arrow);
        file = file.slice(arrow + 4);
      }
      result.entries.push({ x, y, file, orig });
    }
  }
  return result;
}

// Porcelain xy pairs that mean the path has an unresolved merge conflict.
const CONFLICT_PAIRS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

// True while a merge is in progress (MERGE_HEAD exists): a commit is then
// meaningful even with an empty index, because it completes the merge.
async function mergeInProgress(repoPath) {
  const g = await run(repoPath, ['rev-parse', '--git-path', 'MERGE_HEAD']);
  if (!g.ok || !g.stdout.trim()) return false;
  try {
    await fsp.access(path.resolve(repoPath, g.stdout.trim()));
    return true;
  } catch {
    return false;
  }
}

// Files inside a nested repository belong to that repo: it has its own entry
// in the tree and its own status, so its files never show up in the parent's
// changes lists. Cached briefly; the scan already walks the same tree.
const nestedCache = new Map(); // repoPath -> { at, rels }
const NESTED_TTL = 60000;

async function nestedRepoRels(repoPath) {
  const key = path.resolve(repoPath);
  const hit = nestedCache.get(key);
  if (hit && Date.now() - hit.at < NESTED_TTL) return hit.rels;
  const found = await findRepos(repoPath);
  const rels = found
    .map((p) => path.resolve(p))
    .filter((p) => p !== key)
    .map((p) => path.relative(key, p));
  nestedCache.set(key, { at: Date.now(), rels });
  return rels;
}

function inNestedRepo(file, rels) {
  return rels.some((nr) => file === nr || file.startsWith(nr + '/'));
}

async function status(repoPath) {
  const r = await run(repoPath, ['status', '--porcelain=v1', '-b']);
  if (!r.ok) return { error: r.stderr.trim(), branch: null, staged: [], unstaged: [], untracked: [], conflicts: [], dirty: 0 };
  const s = parseStatus(r.stdout);
  const nested = await nestedRepoRels(repoPath);
  s.staged = [];
  s.unstaged = [];
  s.untracked = [];
  s.conflicts = [];
  let dirty = 0;
  for (const e of s.entries) {
    // skip files that live inside a nested repo (and rename sources there)
    if (inNestedRepo(e.file, nested) || (e.orig && inNestedRepo(e.orig, nested))) continue;
    dirty++;
    if (e.x === '?' && e.y === '?') {
      s.untracked.push({ file: e.file, status: 'untracked' });
    } else if (CONFLICT_PAIRS.has(e.x + e.y)) {
      s.conflicts.push({ file: e.file, status: e.x + e.y });
    } else {
      if (e.x !== ' ' && e.x !== '?') s.staged.push({ file: e.file, orig: e.orig, status: e.x });
      if (e.y !== ' ' && e.y !== '?') s.unstaged.push({ file: e.file, status: e.y });
    }
  }
  s.dirty = dirty;
  s.merging = await mergeInProgress(repoPath);
  return s;
}

async function stage(repoPath, filesToStage) {
  if (!filesToStage.length) return { ok: true };
  const r = await mutating(repoPath, ['add', '--', ...filesToStage]);
  return { ok: r.ok, error: r.stderr.trim() };
}

async function unstage(repoPath, filesToUnstage) {
  if (!filesToUnstage.length) return { ok: true };
  let r = await mutating(repoPath, ['reset', '-q', 'HEAD', '--', ...filesToUnstage]);
  if (!r.ok) {
    // Repository without any commits yet: fall back to removing from the index.
    r = await mutating(repoPath, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...filesToUnstage]);
  }
  return { ok: r.ok, error: r.stderr.trim() };
}

async function commit(repoPath, message) {
  const msg = (message || '').trim();
  if (!msg) return { ok: false, error: 'Empty commit message.' };
  const r = await mutating(repoPath, ['commit', '-m', msg]);
  return { ok: r.ok, error: r.stderr.trim() };
}

async function push(repoPath) {
  // A new local branch has no upstream yet: push with --set-upstream so the
  // remote branch is created and tracking is set in one go. Plain push
  // otherwise. Origin is preferred, else the first configured remote.
  let remote = 'origin';
  const rm = await run(repoPath, ['remote']);
  const remotes = rm.ok ? rm.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  if (!remotes.includes('origin') && remotes.length) remote = remotes[0];
  let args = ['push'];
  const cur = await run(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = cur.ok ? cur.stdout.trim() : '';
  const hasUpstream = await run(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (branch && branch !== 'HEAD' && !hasUpstream.ok) args = ['push', '--set-upstream', remote, branch];
  const r = await mutating(repoPath, args, 120000);
  return { ok: r.ok, error: r.stderr.trim() };
}

async function pull(repoPath) {
  const r = await mutating(repoPath, ['pull', '--no-edit'], 120000);
  return { ok: r.ok, error: r.stderr.trim() };
}

async function fetchAll(repoPath) {
  const r = await mutating(repoPath, ['fetch', '--all', '--prune'], 120000);
  return { ok: r.ok, error: r.stderr.trim() };
}

// ---- branches ------------------------------------------------------------

// All local branches; current marks the checked-out one. Branches that only
// exist on a remote are returned too, so the dropdown shows everything the
// repository knows about:
// - upstream/* (the fork convention) always, under their own group;
// - origin/* only when there is no local branch with the same name (a local
//   twin already appears once; origin/stable with no local stable is the
//   case that was missing before). Both are flagged remote:true with the
//   full remote/... name and the short name, so they can be merged, checked
//   out locally or diffed against.
async function branches(repoPath) {
  const r = await run(repoPath, ['branch', '--format=%(refname:short)%09%(HEAD)']);
  if (!r.ok) return { error: r.stderr.trim() };
  const list = r.stdout.split('\n').filter(Boolean).map((l) => {
    const [name, head] = l.split('\t');
    return { name, current: head === '*' };
  });
  const current = (list.find((b) => b.current) || {}).name || null;
  const localNames = new Set(list.map((b) => b.name));
  const rm = await run(repoPath, ['remote']);
  const remotes = rm.ok ? rm.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  let upstream = [];
  let origin = [];
  if (remotes.length) {
    const rr = await run(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/']);
    if (rr.ok) {
      const refs = rr.stdout.split('\n').map((s) => s.trim()).filter((n) => n && !n.endsWith('/HEAD'));
      upstream = refs
        .filter((n) => n.startsWith('upstream/'))
        .map((n) => ({ name: n, short: n.slice('upstream/'.length), remote: true, current: false }));
      origin = refs
        .filter((n) => n.startsWith('origin/') && !localNames.has(n.slice('origin/'.length)))
        .map((n) => ({ name: n, short: n.slice('origin/'.length), remote: true, current: false }));
    }
  }
  return { branches: list, current, upstream, origin };
}

async function checkout(repoPath, name) {
  let args = ['checkout', name];
  // A remote branch (upstream/x for forks, origin/x otherwise) is checked out
  // as a local branch tracking it: plain "git checkout origin/x" detaches
  // HEAD, and for forks the same name always also exists on origin, so
  // "git checkout x" would pick that one instead.
  if (name.startsWith('upstream/') || name.startsWith('origin/')) {
    const short = name.slice(name.indexOf('/') + 1);
    const local = await run(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${short}`]);
    args = local.ok
      ? ['checkout', short] // a local branch with that name exists already
      : ['checkout', '-b', short, '--track', name];
  }
  const r = await mutating(repoPath, args);
  return { ok: r.ok, error: r.stderr.trim() };
}

async function createBranch(repoPath, name) {
  const r = await mutating(repoPath, ['checkout', '-b', name]);
  return { ok: r.ok, error: r.stderr.trim() };
}

// Local only: never touches a remote.
async function deleteBranch(repoPath, name) {
  const r = await mutating(repoPath, ['branch', '-D', name]);
  return { ok: r.ok, error: r.stderr.trim() };
}

async function merge(repoPath, name) {
  const r = await mutating(repoPath, ['merge', name], 120000);
  const conflicted = !r.ok && /conflict/i.test(r.stdout + r.stderr);
  return { ok: r.ok, error: r.stderr.trim(), output: (r.stdout || '').trim(), conflicted };
}

function parseLogOutput(stdout) {
  return stdout
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [hash, author, date, subject, body, refs] = chunk.split('\x1f');
      const tags = (refs || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.startsWith('tag: '))
        .map((s) => s.slice(5));
      return { hash, author, date, subject, body: (body || '').trim(), tags };
    });
}

// maxCount 0 (the default) means uncapped: every commit is returned. When a
// cap is set, one extra entry is fetched so the caller can tell the list was
// cut off, and rev-list gives the real total for a "showing x of y" note.
//
// Uncapped results are cached against the repo's HEAD hash and its refs: the
// history of a repo only changes when HEAD or a ref moves (new commits,
// amend, rebase, new or moved tags), so with both unchanged the previous
// parse is served straight back instead of re-running git log. This is what
// keeps the 5-second refresh cheap on repos with tens of thousands of commits.
const logCache = new Map(); // "repo|paths" -> { sig, result }

async function log(repoPath, maxCount = 0, paths = []) {
  const capped = maxCount > 0;
  if (!capped) {
    const key = `${path.resolve(repoPath)}|${paths.join('\u0000')}`;
    const [headR, refsR] = await Promise.all([
      run(repoPath, ['rev-parse', 'HEAD']),
      run(repoPath, ['for-each-ref', '--format=%(refname)%09%(objectname)']),
    ]);
    if (headR.ok && refsR.ok) {
      const sig = `${headR.stdout.trim()}\n${refsR.stdout}`;
      const hit = logCache.get(key);
      if (hit && hit.sig === sig) return hit.result;
      const result = await runLog(repoPath, maxCount, paths);
      logCache.set(key, { sig, result });
      return result;
    }
  }
  return runLog(repoPath, maxCount, paths);
}

async function runLog(repoPath, maxCount = 0, paths = []) {
  const capped = maxCount > 0;
  const args = [
    'log', ...(capped ? [`--max-count=${maxCount + 1}`] : []), '--date=iso-strict',
    '--pretty=format:%h%x1f%an%x1f%ad%x1f%s%x1f%b%x1f%D%x1e',
  ];
  if (paths.length) { args.push('--'); args.push(...paths); }
  const [r, countR] = await Promise.all([
    run(repoPath, args),
    capped
      ? run(repoPath, ['rev-list', '--count', 'HEAD', ...(paths.length ? ['--', ...paths] : [])])
      : Promise.resolve({ ok: true, stdout: '' }),
  ]);
  if (!r.ok) {
    // Fresh repository without commits: not an error, just an empty history.
    if (/does not have any commits yet|bad revision/i.test(r.stderr)) {
      return { entries: [], truncated: false, total: 0 };
    }
    return { error: r.stderr.trim() };
  }
  const all = parseLogOutput(r.stdout);
  return {
    entries: capped ? all.slice(0, maxCount) : all,
    truncated: capped && all.length > maxCount,
    total: capped ? (countR.ok ? parseInt(countR.stdout.trim(), 10) : null) : all.length,
  };
}

// Commits in a range such as "main..feature": the ones the second branch has
// that the first does not, i.e. what a merge of the second branch would bring in.
// maxCount+1 entries are fetched so the caller can tell the list was cut off.
async function logRange(repoPath, range, maxCount = 0) {
  // maxCount 0 (the default) means uncapped: every commit in the range.
  const capped = maxCount > 0;
  const args = [
    'log', ...(capped ? [`--max-count=${maxCount + 1}`] : []), '--date=iso-strict',
    '--pretty=format:%h%x1f%an%x1f%ad%x1f%s%x1f%b%x1f%D%x1e',
    range,
  ];
  const [r, countR] = await Promise.all([
    run(repoPath, args),
    capped ? run(repoPath, ['rev-list', '--count', range]) : Promise.resolve({ ok: true, stdout: '' }),
  ]);
  if (!r.ok) return { error: r.stderr.trim() };
  const all = parseLogOutput(r.stdout);
  return {
    entries: capped ? all.slice(0, maxCount) : all,
    truncated: capped && all.length > maxCount,
    total: capped ? (countR.ok ? parseInt(countR.stdout.trim(), 10) : null) : all.length,
  };
}

async function show(repoPath, hash) {
  const msg = await run(repoPath, ['log', '-1', '--pretty=format:%H%n%an%n%ad%n%B', hash]);
  const filesR = await run(repoPath, ['show', '--name-status', '--pretty=format:', hash]);
  if (!msg.ok) return { error: msg.stderr.trim() };
  const [hashFull, author, date, ...bodyLines] = msg.stdout.split('\n');
  const changed = [];
  for (const line of filesR.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t').filter(Boolean);
    if (parts.length >= 2) changed.push({ status: parts[0], file: parts[parts.length - 1] });
  }
  return { hash: hashFull, author, date, body: bodyLines.join('\n').trim(), changed };
}

// All tracked files, plus untracked ones so the tree is complete.
async function files(repoPath) {
  const r = await run(repoPath, ['ls-files', '-z']);
  if (!r.ok) return { error: r.stderr.trim() };
  const set = new Set(r.stdout.split('\0').filter(Boolean));
  const st = await status(repoPath);
  for (const u of st.untracked || []) set.add(u.file.endsWith('/') ? u.file.slice(0, -1) : u.file);
  return [...set].sort();
}

// Unified diff for the given paths; cached=true diffs the staged (index) state.
async function diff(repoPath, paths, cached = false) {
  if (!paths.length) return { text: '' };
  const args = ['diff', '--no-color'];
  if (cached) args.push('--cached');
  args.push('--');
  args.push(...paths);
  const r = await run(repoPath, args);
  return r.ok ? { text: r.stdout } : { error: r.stderr.trim() };
}

// Unified diff introduced by one commit (patch only, no commit message),
// optionally limited to the given paths.
async function commitDiff(repoPath, hash, paths = []) {
  const args = ['show', '--no-color', '--format=', hash];
  if (paths.length) { args.push('--'); args.push(...paths); }
  const r = await run(repoPath, args);
  return r.ok ? { text: r.stdout } : { error: r.stderr.trim() };
}

// Revert (discard) the given paths' changes back to HEAD: tracked files are
// restored, staged-new and untracked files are removed from index and disk.
async function revert(repoPath, paths) {
  if (!paths.length) return { ok: true };
  const st = await status(repoPath);
  const untracked = new Set((st.untracked || []).map((u) => u.file.replace(/\/$/, '')));
  const added = new Set((st.staged || []).filter((x) => x.status === 'A').map((x) => x.file));
  const base = paths.map((p) => p.replace(/\/$/, ''));
  const fresh = base.filter((p) => untracked.has(p) || added.has(p));
  const tracked = base.filter((p) => !fresh.includes(p));
  let ok = true;
  let error = '';
  if (tracked.length) {
    const r = await mutating(repoPath, ['checkout', '-q', 'HEAD', '--', ...tracked]);
    if (!r.ok) { ok = false; error = r.stderr.trim(); }
  }
  if (fresh.length) {
    // staged-new files first leave the index; untracked ones are just deleted
    const r = await mutating(repoPath, ['clean', '-q', '-f', '-d', '--', ...fresh]);
    if (!r.ok) { ok = false; error = r.stderr.trim(); }
    const still = fresh.filter((p) => added.has(p));
    if (still.length) {
      const r2 = await mutating(repoPath, ['rm', '-q', '-f', '--', ...still]);
      if (!r2.ok && ok) { ok = false; error = r2.stderr.trim(); }
    }
  }
  return { ok, error };
}

// Create a commit that undoes the given commit's changes.
async function revertCommit(repoPath, hash) {
  const r = await mutating(repoPath, ['revert', '--no-edit', hash], 120000);
  const conflicted = !r.ok && /conflict/i.test(r.stdout + r.stderr);
  return { ok: r.ok, error: r.stderr.trim(), output: (r.stdout || '').trim(), conflicted };
}

// Cherry-pick the given commit onto the currently checked-out branch.
async function cherryPick(repoPath, hash) {
  const r = await mutating(repoPath, ['cherry-pick', hash], 120000);
  const conflicted = !r.ok && /conflict/i.test(r.stdout + r.stderr);
  return { ok: r.ok, error: r.stderr.trim(), output: (r.stdout || '').trim(), conflicted };
}

module.exports = {
  run, isRepo, findRepos, status, stage, unstage, commit,
  push, pull, fetchAll, log, logRange, show, files, diff, commitDiff,
  branches, checkout, createBranch, deleteBranch, merge,
  revert, revertCommit, cherryPick,
  onOp, getOpLog,
};
