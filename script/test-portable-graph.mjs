import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
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
commit('README.md', 'Initial graph commit')
git(['checkout', '-b', 'feature'])
commit('feature.txt', 'Graph feature commit')
const featureSha = git(['rev-parse', 'HEAD'])
git(['checkout', 'main'])
git(['checkout', '-b', 'target'])
commit('target.txt', 'Graph rebase target')
const targetSha = git(['rev-parse', 'HEAD'])
git(['checkout', 'main'])
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
  await page
    .getByText('Graph feature commit', { exact: true })
    .first()
    .waitFor()
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
    'PASS: packaged Graph tab, tab navigation, native context menus, merge dialog, fast-forward, rebase, push, and isolated portable storage without external Git/Node on PATH'
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
