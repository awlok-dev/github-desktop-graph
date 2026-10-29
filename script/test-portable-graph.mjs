import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  copyFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const root = path.resolve(import.meta.dirname, '..')
const appRoot = path.join(root, 'dist', 'GitHubDesktopGraph-win32-x64')
const executablePath = path.join(appRoot, 'GitHubDesktopGraph.exe')
const gitPath = path.join(appRoot, 'resources', 'app', 'git', 'cmd', 'git.exe')
const scratch = mkdtempSync(path.join(tmpdir(), 'desktop-graph-test-'))
const repo = path.join(scratch, 'repository')
const remote = path.join(scratch, 'remote.git')
const data = path.join(scratch, 'Data')
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: path.join(scratch, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Graph Test',
  GIT_AUTHOR_EMAIL: 'graph-test@example.com',
  GIT_COMMITTER_NAME: 'Graph Test',
  GIT_COMMITTER_EMAIL: 'graph-test@example.com',
}
// The application must work with neither Node nor an external Git on PATH.
for (const key of Object.keys(env)) {
  if (key.toLowerCase() === 'path') delete env[key]
}
env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`
delete env.ELECTRON_RUN_AS_NODE
mkdirSync(repo)
function git(args, cwd = repo) {
  return execFileSync(gitPath, args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
}
function commit(file, message) {
  writeFileSync(path.join(repo, file), `${message}\n`)
  git(['add', '--', file])
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', message])
}
git(['init', '-b', 'main'])
writeFileSync(path.join(repo, 'old-name.txt'), 'Keep this renamed content\n')
writeFileSync(path.join(repo, 'deleted.txt'), 'Deleted historical content\n')
git(['add', '--', '.'])
commit('README.md', 'Initial graph commit')
const rootSha = git(['rev-parse', 'HEAD'])
git(['checkout', '-b', 'feature'])
commit('feature.txt', 'Graph feature commit')
const featureSha = git(['rev-parse', 'HEAD'])
git(['checkout', 'main'])
git(['checkout', '-b', 'target'])
commit('target.txt', 'Graph rebase target')
const targetSha = git(['rev-parse', 'HEAD'])
git(['checkout', 'main'])
git(['checkout', '-b', 'changes-demo'])
git(['mv', 'old-name.txt', 'renamed.txt'])
git(['rm', 'deleted.txt'])
writeFileSync(path.join(repo, 'README.md'), 'Updated README content\n')
writeFileSync(path.join(repo, 'second.txt'), 'Second file added content\n')
writeFileSync(path.join(repo, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
git(['add', '--', '.'])
git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Inspect multiple files'])
const changesSha = git(['rev-parse', 'HEAD'])
git([
  '-c',
  'commit.gpgsign=false',
  'commit',
  '--allow-empty',
  '-m',
  'Empty graph test commit',
])
const emptySha = git(['rev-parse', 'HEAD'])
git([
  '-c',
  'commit.gpgsign=false',
  'merge',
  '--no-ff',
  'target',
  '-m',
  'Merge graph test commit',
])
const mergeSha = git(['rev-parse', 'HEAD'])
git(['checkout', 'main'])

git(['checkout', '-b', 'image-demo', rootSha])
const svgBefore =
  '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#2454a0"/><circle cx="220" cy="250" r="130" fill="#ffc857"/></svg>'
copyFileSync(
  path.join(root, 'app/static/common/logo-64x64@2x.png'),
  path.join(repo, 'preview.PNG')
)
writeFileSync(path.join(repo, 'drawing.svg'), svgBefore)
git(['add', '--', '.'])
git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Add preview images'])
const imageAddedSha = git(['rev-parse', 'HEAD'])
copyFileSync(
  path.join(root, 'app/static/common/windows-logo-64x64@2x.png'),
  path.join(repo, 'preview.PNG')
)
writeFileSync(
  path.join(repo, 'drawing.svg'),
  svgBefore.replace('220', '520').replace('#2454a0', '#793e90')
)
git(['add', '--', '.'])
git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Change preview images'])
const imageChangedSha = git(['rev-parse', 'HEAD'])
git(['mv', 'drawing.svg', 'renamed.svg'])
git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Rename preview image'])
const imageRenamedSha = git(['rev-parse', 'HEAD'])
git(['rm', 'preview.PNG', 'renamed.svg'])
git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Delete preview images'])
const imageDeletedSha = git(['rev-parse', 'HEAD'])
git(['checkout', 'main'])

const rootTree = git(['rev-parse', `${rootSha}^{tree}`])
const denseParents = Array.from({ length: 64 }, (_, index) => {
  const name = `stress/branch-${String(index).padStart(2, '0')}`
  const sha = git(['commit-tree', rootTree, '-p', rootSha, '-m', name])
  git(['branch', name, sha])
  return sha
})
const denseSha = git([
  'commit-tree',
  rootTree,
  ...denseParents.flatMap(sha => ['-p', sha]),
  '-m',
  'Many branch merge',
])
git(['branch', 'dense-merge', denseSha])
for (let index = 0; index < 40; index++) {
  git(['branch', `alias/${String(index).padStart(2, '0')}`, denseSha])
}

git(['init', '--bare', remote])
git(['remote', 'add', 'origin', remote])
git(['push', '-u', 'origin', 'main'])

const app = await electron.launch({
  executablePath,
  args: [
    `--user-data-dir=${data}`,
    '--no-protocol-registration',
    `--cli-open=${repo}`,
  ],
  env,
  timeout: 60000,
})
let page
const errors = []
async function waitFor(check, description) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out: ${description}`)
}
try {
  page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('a.skip-button').click({ timeout: 30000 })
  await page.locator('input[placeholder="Your Name"]').fill('Graph Test')
  await page
    .locator('input[placeholder="your-email@example.com"]')
    .fill('graph-test@example.com')
  await page.getByRole('button', { name: 'Finish', exact: true }).click()
  await page.locator('#welcome').waitFor({ state: 'hidden' })
  const addDialog = page.locator('dialog#add-existing-repository')
  await waitFor(
    async () =>
      (await page.locator('#graph-tab').isVisible()) ||
      (await addDialog.isVisible()),
    'repository or add dialog'
  )
  if (await addDialog.isVisible()) {
    await addDialog.locator('input[placeholder="repository path"]').fill(repo)
    await addDialog.getByRole('button', { name: /^Add repository$/i }).click()
  }
  await page.locator('#graph-tab').click()
  await page.locator('#commit-graph-view').waitFor({ state: 'visible' })
  await page.getByText('Many branch merge', { exact: true }).first().waitFor()
  assert.equal(
    await page
      .getByRole('tab', { name: 'Graph', exact: true })
      .getAttribute('aria-selected'),
    'true'
  )
  await page.locator('#history-tab').click()
  await page.locator('#commit-graph-view').waitFor({ state: 'hidden' })
  await page.locator('#graph-tab').click()
  await page.locator('#commit-graph-view').waitFor({ state: 'visible' })
  await page.keyboard.press('Control+Tab')
  await page.locator('#commit-graph-view').waitFor({ state: 'hidden' })
  await page.keyboard.press('Control+Shift+Tab')
  await page.locator('#commit-graph-view').waitFor({ state: 'visible' })

  const details = page.locator('.commit-graph-details')
  const graphScroller = page.locator(
    '.commit-graph-scroll .ReactVirtualized__Grid'
  )
  async function selectCommit(sha) {
    const button = page.locator(`.commit-graph-commit[data-sha="${sha}"]`)
    const settleScroll = () =>
      page.evaluate(
        () =>
          new Promise(resolve =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
          )
      )
    await graphScroller.evaluate(element => {
      element.scrollTop = 0
      element.scrollLeft = 0
    })
    await settleScroll()
    await waitFor(async () => {
      const bounds = (await button.count()) ? await button.boundingBox() : null
      const viewport = await graphScroller.boundingBox()
      if (
        bounds &&
        viewport &&
        bounds.y + bounds.height / 2 >= viewport.y &&
        bounds.y + bounds.height / 2 < viewport.y + viewport.height - 16
      ) {
        return true
      }
      await graphScroller.evaluate(element => {
        element.scrollTop += 150
      })
      await settleScroll()
      return false
    }, `find graph commit ${sha}`)
    await button.click()
  }
  async function selectFile(name) {
    await details.getByRole('option', { name: new RegExp(`^${name} `) }).click()
  }
  async function assertDiff(text) {
    await waitFor(
      async () =>
        (await details.locator('.diff-container').innerText()).includes(text),
      `diff shows ${text}`
    )
  }

  await selectCommit(denseSha)
  const selectedRow = page.locator('.commit-graph-row.selected')
  assert.equal((await selectedRow.boundingBox()).height, 28)
  const compactWidth = await selectedRow.locator('svg').getAttribute('width')
  assert.ok(Number(compactWidth) < 900)
  const compactToggle = page.getByRole('checkbox', {
    name: 'Compact',
    exact: true,
  })
  await compactToggle.uncheck()
  await waitFor(
    async () => (await selectedRow.boundingBox()).height === 38,
    'roomy graph spacing'
  )
  await compactToggle.check()
  await waitFor(
    async () => (await selectedRow.boundingBox()).height === 28,
    'compact graph spacing'
  )
  await graphScroller.evaluate(element => {
    element.scrollLeft = element.scrollWidth
  })
  await waitFor(
    async () =>
      await graphScroller.evaluate(element => element.scrollLeft > 100),
    'wide graph scrolls horizontally'
  )
  const viewport = await graphScroller.boundingBox()
  const summaryBounds = await selectedRow
    .locator('.commit-graph-summary')
    .boundingBox()
  assert.ok(
    summaryBounds.x >= viewport.x &&
      summaryBounds.x + summaryBounds.width <= viewport.x + viewport.width
  )
  await page.screenshot({
    path: path.join(root, 'dist', 'portable-graph-many-branches.png'),
  })

  async function assertImages(count) {
    await waitFor(async () => {
      const images = details.locator('.panel.image img')
      return (
        (await images.count()) === count &&
        (await images.evaluateAll(elements =>
          elements.every(
            element =>
              element.complete &&
              element.naturalWidth > 0 &&
              element.getBoundingClientRect().width > 0
          )
        ))
      )
    }, `${count} image previews loaded`)
  }
  await selectCommit(imageChangedSha)
  await selectFile('preview.PNG')
  await details.getByRole('tab', { name: 'Side by side', exact: true }).click()
  await assertImages(2)
  const imageSources = await details
    .locator('.panel.image img')
    .evaluateAll(images => images.map(image => image.src))
  assert.notEqual(imageSources[0], imageSources[1])
  await page.screenshot({
    path: path.join(root, 'dist', 'portable-graph-image-side-by-side.png'),
  })
  await selectFile('drawing.svg')
  await assertImages(2)
  await details.getByRole('tab', { name: 'Onion Skin', exact: true }).click()
  await assertImages(2)
  const opacity = details.getByRole('slider', {
    name: 'Image overlay opacity',
    exact: true,
  })
  assert.equal(await opacity.inputValue(), '50')
  await page.screenshot({
    path: path.join(root, 'dist', 'portable-graph-image-onion-skin.png'),
  })
  await opacity.press('Home')
  await waitFor(
    async () =>
      (await details
        .locator('.image-diff-onion-skin .image-diff-current')
        .evaluate(element => element.style.opacity)) === '0',
    'onion skin shows old image'
  )
  await opacity.press('End')
  await waitFor(
    async () =>
      (await details
        .locator('.image-diff-onion-skin .image-diff-current')
        .evaluate(element => element.style.opacity)) === '1',
    'onion skin shows new image'
  )
  await selectCommit(imageAddedSha)
  await selectFile('preview.PNG')
  await assertImages(1)
  await selectCommit(imageRenamedSha)
  await selectFile('renamed.svg')
  await assertImages(2)
  await selectCommit(imageDeletedSha)
  await selectFile('preview.PNG')
  await assertImages(1)

  // Inspect a commit on another branch without checking out that branch.
  await selectCommit(changesSha)
  await details.getByText('5 changed files', { exact: false }).waitFor()
  await selectFile('README.md')
  await assertDiff('Updated README content')
  await assertDiff('Initial graph commit')
  await details
    .getByRole('button', { name: 'Diff Options', exact: true })
    .click()
  await page.getByRole('radio', { name: 'Split', exact: true }).check()
  await details
    .locator('.side-by-side-diff-container:not(.unified-diff)')
    .waitFor()
  await page
    .getByRole('checkbox', { name: 'Hide whitespace changes', exact: true })
    .check()
  await assertDiff('Updated README content')
  assert.equal(
    await page
      .getByRole('checkbox', { name: 'Hide whitespace changes', exact: true })
      .isChecked(),
    true
  )
  await page.getByRole('radio', { name: 'Unified', exact: true }).check()
  await page
    .getByRole('checkbox', { name: 'Hide whitespace changes', exact: true })
    .uncheck()
  await details
    .getByRole('button', { name: 'Diff Options', exact: true })
    .click()
  await details.locator('.side-by-side-diff-container.unified-diff').waitFor()
  await selectFile('second.txt')
  await assertDiff('Second file added content')
  await selectFile('deleted.txt')
  await assertDiff('Deleted historical content')
  await selectFile('renamed.txt')
  await assertDiff('The file was renamed')
  await selectFile('binary.bin')
  await assertDiff('This binary file has changed.')
  await selectCommit(emptySha)
  await details
    .getByText('No files changed in this commit.', { exact: true })
    .waitFor()
  assert.equal(await details.locator('.diff-container').count(), 0)
  await selectCommit(mergeSha)
  await selectFile('target.txt')
  await assertDiff('Graph rebase target')
  await selectCommit(rootSha)
  await selectFile('README.md')
  await assertDiff('Initial graph commit')

  // Fast selection must not leave a stale response from an earlier commit.
  await selectCommit(changesSha)
  await selectCommit(rootSha)
  await selectCommit(changesSha)
  await selectFile('README.md')
  await assertDiff('Updated README content')
  assert.equal(git(['symbolic-ref', '--short', 'HEAD']), 'main')
  assert.equal(git(['status', '--porcelain']), '')
  const bounds = await details.boundingBox()
  assert.ok(bounds && bounds.height >= 180)
  await page.screenshot({
    path: path.join(root, 'dist', 'portable-graph-changes.png'),
  })

  // Interact with the real native menu produced by a right-click. Select its
  // callback deterministically so this also runs on headless Windows CI.
  await app.evaluate(({ Menu }) => {
    Menu.prototype.popup = function (options) {
      globalThis.graphMenuLabels = this.items.map(item => item.label)
      const item = this.items.find(
        item => item.label === globalThis.graphMenuSelection
      )
      if (item && item.enabled) item.click()
      options?.callback?.()
    }
  })
  async function menu(branch, label) {
    await selectCommit(git(['rev-parse', branch]))
    await waitFor(
      () =>
        page
          .locator('#commit-graph-view')
          .getByRole('button', { name: 'Refresh', exact: true })
          .isEnabled(),
      'graph action completes'
    )
    await app.evaluate((_, selection) => {
      globalThis.graphMenuSelection = selection
    }, label)
    await page
      .locator('.commit-graph-ref')
      .filter({ hasText: new RegExp(`^${branch}$`) })
      .click({ button: 'right' })
    await waitFor(
      async () =>
        (
          await app.evaluate(() => globalThis.graphMenuLabels ?? [])
        ).includes(label),
      `menu ${label}`
    )
  }
  await selectCommit(denseSha)
  await page.locator('.commit-graph-row.selected .more-refs').click()
  await waitFor(
    async () =>
      (await app.evaluate(() => globalThis.graphMenuLabels ?? [])).length ===
      41,
    'all shared branch labels are accessible'
  )
  assert.ok(
    (await app.evaluate(() => globalThis.graphMenuLabels)).includes('alias/39')
  )
  await menu('feature', 'Merge feature into current branch')
  await page
    .locator('dialog')
    .filter({ hasText: 'Merge' })
    .waitFor({ state: 'visible' })
  await page
    .locator('dialog.modal-enter-done .dialog-header button.close')
    .click()
  await page.locator('dialog').waitFor({ state: 'hidden' })
  await menu('feature', 'Fast-forward current branch to feature')
  await waitFor(
    () => git(['rev-parse', 'HEAD']) === featureSha,
    'fast-forward updates HEAD'
  )
  await waitFor(
    async () =>
      (await page.locator('.commit-graph-ref.current').textContent()) ===
      'main',
    'current branch highlight'
  )
  await menu('target', 'Rebase current branch onto target')
  await waitFor(
    () => git(['merge-base', 'HEAD', 'target']) === targetSha,
    'rebase uses selected branch'
  )
  await waitFor(
    async () => !(await page.locator('dialog').isVisible()),
    'rebase completes'
  )
  await page
    .locator('#commit-graph-view')
    .getByRole('button', { name: 'Refresh', exact: true })
    .click()
  await menu('main', 'Push branch')
  await waitFor(
    () =>
      git(['rev-parse', 'refs/heads/main'], remote) ===
      git(['rev-parse', 'HEAD']),
    'push reaches local remote'
  )
  await page.screenshot({
    path: path.join(root, 'dist', 'portable-graph-smoke.png'),
  })
  assert.deepEqual(errors, [])
  assert.ok(existsSync(data))
  assert.equal(existsSync(path.join(appRoot, 'Data')), false)
  console.log(
    'PASS: compact graph with 64 lanes and 41 shared refs, horizontal scrolling, PNG/SVG image previews and onion skin, commit diffs, native menus, fast-forward, rebase, push, and portable storage without external Git/Node on PATH'
  )
} catch (error) {
  if (page) {
    await page
      .screenshot({
        path: path.join(root, 'dist', 'portable-graph-failure.png'),
      })
      .catch(() => {})
    console.error((await page.locator('body').innerText()).slice(-8000))
  }
  console.error(`Test data and logs: ${scratch}`)
  throw error
} finally {
  await app.close()
}
