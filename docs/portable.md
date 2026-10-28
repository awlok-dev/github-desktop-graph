# GitHub Desktop Graph Portable

A customized build from [awlok-dev/github-desktop-graph](https://github.com/awlok-dev/github-desktop-graph).

## Run on Windows

1. Download the Windows x64 ZIP from this fork's Releases page.
2. Extract the entire ZIP to a writable folder.
3. Open `GitHubDesktopGraph.exe` in the extracted folder.
4. Add or clone a repository and click **Graph**, beside Changes and History.

The ZIP includes Electron, Git and Git LFS. No installer, Node.js installation,
or separate Git installation is required. It targets Windows 10/11 x64.
Future Windows versions need separate compatibility testing. Builds are unsigned.

## Graph actions

The graph displays local branches, remote branches, tags, and merge connections.
Right-click a branch label to check it out, push/pull a local branch,
fast-forward the current branch to the selected branch, merge, or rebase the
current branch onto the selected branch. Push/pull on another local branch
first checks it out; cancelling checkout prevents the remote operation.
Fast-forward refuses diverged history. Merge and rebase use Desktop's normal
confirmation and conflict workflows. Right-click a commit for commit actions.

Ctrl+Tab and Ctrl+Shift+Tab cycle Changes, History and Graph. Use Refresh to
reload external changes, search to highlight matching commits/branches, and
Load more to extend the history.

## Settings and updates

Settings, repository lists, caches and logs live in `Data` beside the executable.
Authentication credentials may be protected by Windows and should not be
assumed transferable to a different computer. Normal Git configuration and
browser sign-in protocol registration may also use your Windows user profile.

Automatic updates from upstream GitHub Desktop are disabled. For an update,
close the app, extract the new ZIP to a new folder, and copy your old `Data`
folder beside the new executable. Keep your repositories at their existing
paths. Never upload your Data folder with a release or bug report.

## Build and verification

Build tools are needed only by developers: use the Node version in `.node-version`,
then run `node vendor/yarn-1.21.1.js install --frozen-lockfile`, `yarn build:portable`,
`yarn test:portable`, and `yarn package:portable` on Windows x64.

The portable test opens the packaged executable with isolated settings and only
Windows system directories on PATH. It clicks the actual Graph tab and tests
branch actions against temporary local repositories. It does not use your
accounts or repositories. GitHub-hosted Windows checks do not replace testing
on every supported end-user OS.
