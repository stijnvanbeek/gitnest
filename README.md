# GitNest

A git frontend for people who work with nested repositories: add a main repo
and GitNest scans it (up to 5 levels deep) for any repository contained inside
it, including plain clones that are not official submodules. Everything shows
up as a tree, and every repo carries a badge with its number of uncommitted
changes, so you can see in one glance what is dirty anywhere in the hierarchy.

## Features

- Tree of repositories: nested repos appear as children of the repo they live in.
- Dirty badge per repo (count of changed/untracked entries), green dot when clean, ↑/↓ ahead-behind indicators.
- Click a repo: branch, upstream, staged / changes / untracked files on the right.
- Click a file row to stage it; click a staged row to unstage it.
- Commit, Push, Pull, Fetch buttons per repo.
- Commit history beside the status; click a commit for its message and changed files.
- Double-click a repo in the tree to fold out its file listing.

## Run it

Requires Node.js and git on your machine.

    npm install
    npm start

Then click **Add Repository…** and pick your main repo (e.g. `nap`). Nested
repos inside it are found automatically; you can also add several top-level
folders and they all appear in one tree.

## Package it as an app

Turn the project into a self-contained macOS application (GitNest.app):

    npm run package

The bundle is written to `dist/GitNest-darwin-<arch>/GitNest.app`. Copy it to
`/Applications` or anywhere you like; it needs nothing else on the machine.
It is not signed with a developer certificate, so macOS may show a Gatekeeper
warning the first time you open a copy that came from another machine
(right-click → Open, or run `xattr -cr` on the .app).

## Notes

- Repositories are found by the presence of a `.git` folder or `.git` file
  (submodules and worktrees both work). Hidden directories, `node_modules`,
  `build`, `dist` and a few other heavy folders are skipped while scanning.
- Plain nested clones that are not submodules are displayed the same way as
  submodules; git itself just reports them as nested repo entries.
- Scan depth is 5 levels; bump `maxDepth` in `lib/git.js` if you need more.
- Roots are stored in Electron's user-data folder, so they survive restarts.
