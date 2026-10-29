import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  loadCommitGraph,
  layoutCommitGraph,
} from '../../../src/lib/git/commit-graph'
import { fastForwardBranch } from '../../../src/lib/git/fast-forward-branch'
import { git } from '../../../src/lib/git/core'
import { getBranches } from '../../../src/lib/git'
import { setupEmptyRepository } from '../../helpers/repositories'
import { Repository } from '../../../src/models/repository'

async function commit(repository: Repository, message: string) {
  await git(
    ['-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-m', message],
    repository.path,
    'test commit'
  )
}

describe('commit graph', () => {
  it('loads an empty repository', async t => {
    const repository = await setupEmptyRepository(t)
    assert.equal((await loadCommitGraph(repository, 20)).rows.length, 0)
  })

  it('loads all branches, detached HEAD, tags and control characters with paging', async t => {
    const repository = await setupEmptyRepository(t, 'main')
    await commit(repository, 'root')
    await git(['branch', 'feature'], repository.path, 'branch')
    await git(
      ['tag', '-a', 'v1', '-m', 'annotated tag'],
      repository.path,
      'tag'
    )
    await git(['checkout', '--detach'], repository.path, 'detach')
    await commit(repository, 'control\x1fcharacter\x1e in subject')
    await git(
      ['config', 'log.showSignature', 'true'],
      repository.path,
      'config'
    )
    const graph = await loadCommitGraph(repository, 20)
    assert.equal(graph.rows.length, 2)
    assert.equal(
      graph.rows[0].commit.summary,
      'control\x1fcharacter\x1e in subject'
    )
    assert.deepEqual(graph.rows[1].refs.map(ref => ref.ref).sort(), [
      'refs/heads/feature',
      'refs/heads/main',
      'refs/tags/v1',
    ])
    const page = await loadCommitGraph(repository, 1)
    assert.equal(page.rows.length, 1)
    assert.equal(page.hasMore, true)
  })

  it('connects both merge parents and joins their common ancestor', () => {
    const commits = [
      { sha: 'merge', parents: ['main', 'feature'] },
      { sha: 'feature', parents: ['root'] },
      { sha: 'main', parents: ['root'] },
      { sha: 'root', parents: [] },
    ].map(commit => ({
      ...commit,
      summary: commit.sha,
      author: 'Test',
      date: '2026-01-01',
    }))
    const graph = layoutCommitGraph(commits, [])
    assert.equal(graph.rows[0].parentConnections.length, 2)
    assert.equal(graph.rows[3].incoming, true)
    assert.equal(graph.rows[3].parentConnections.length, 0)
    assert.equal(graph.laneCount, 2)
  })

  it('keeps every lane and branch label in a many-parent merge', () => {
    const parents = Array.from({ length: 64 }, (_, i) => `branch-${i}`)
    const commits = [
      { sha: 'merge', parents },
      ...parents.map(sha => ({ sha, parents: ['root'] })),
      { sha: 'root', parents: [] },
    ].map(commit => ({
      ...commit,
      summary: commit.sha,
      author: 'Test',
      date: '2026-01-01',
    }))
    const refs = parents.map(sha => ({
      sha,
      ref: `refs/heads/${sha}`,
      name: sha,
      kind: 'local' as const,
      isCurrent: false,
    }))
    const graph = layoutCommitGraph(commits, refs)
    assert.equal(graph.laneCount, 64)
    assert.equal(graph.rows[0].parentConnections.length, 64)
    assert.equal(
      new Set(graph.rows[0].parentConnections.map(edge => edge.to)).size,
      64
    )
    assert.equal(graph.rows.flatMap(row => row.refs).length, 64)
    assert.equal(graph.rows.at(-1)?.column, 0)
    assert.deepEqual(graph.rows.at(-1)?.parentConnections, [])
  })

  it('fast-forwards by canonical branch ref and refuses divergence or changed checkout', async t => {
    const repository = await setupEmptyRepository(t, 'main')
    await commit(repository, 'root')
    await git(['checkout', '-b', 'feature'], repository.path, 'feature')
    await commit(repository, 'feature')
    await git(['checkout', 'main'], repository.path, 'main')
    await git(['tag', 'feature'], repository.path, 'same-named tag')
    const branches = await getBranches(repository)
    const main = branches.find(branch => branch.ref === 'refs/heads/main')
    const feature = branches.find(branch => branch.ref === 'refs/heads/feature')
    assert.ok(main && feature)
    await fastForwardBranch(repository, main, feature)
    const head = await git(['rev-parse', 'HEAD'], repository.path, 'head')
    assert.equal(head.stdout.trim(), feature.tip.sha)
    await commit(repository, 'main-only')
    await git(['checkout', 'feature'], repository.path, 'feature')
    await assert.rejects(
      fastForwardBranch(repository, main, feature),
      /current branch changed/
    )
    await commit(repository, 'feature-only')
    await git(['checkout', 'main'], repository.path, 'main')
    const before = await git(['rev-parse', 'HEAD'], repository.path, 'before')
    await assert.rejects(fastForwardBranch(repository, main, feature))
    const after = await git(['rev-parse', 'HEAD'], repository.path, 'after')
    assert.equal(after.stdout, before.stdout)
  })
})
