import { Repository } from '../../models/repository'
import { git } from './core'
import { createLogParser } from './git-delimiter-parser'

export interface IGraphCommit {
  readonly sha: string
  readonly parents: ReadonlyArray<string>
  readonly summary: string
  readonly author: string
  readonly date: string
}

export interface IGraphRef {
  readonly ref: string
  readonly sha: string
  readonly name: string
  readonly kind: 'local' | 'remote' | 'tag'
  readonly isCurrent: boolean
}

export interface IGraphConnection {
  readonly from: number
  readonly to: number
  readonly color: number
}

export interface IGraphRow {
  readonly commit: IGraphCommit
  readonly column: number
  readonly color: number
  readonly incoming: boolean
  readonly connections: ReadonlyArray<IGraphConnection>
  readonly parentConnections: ReadonlyArray<IGraphConnection>
  readonly refs: ReadonlyArray<IGraphRef>
}

export interface ICommitGraphData {
  readonly rows: ReadonlyArray<IGraphRow>
  readonly width: number
  readonly hasMore: boolean
}

interface ILane {
  readonly sha: string
  readonly color: number
}

/**
 * Read refs separately from the commit log so all branch labels (including
 * remote branches and annotated tags) are placed on their exact tip commits.
 */
export async function loadCommitGraph(
  repository: Repository,
  limit: number
): Promise<ICommitGraphData> {
  const { formatArgs, parse } = createLogParser({
    sha: '%H',
    parents: '%P',
    summary: '%s',
    author: '%an',
    date: '%aI',
  })
  const [history, refResult] = await Promise.all([
    git(
      [
        'log',
        '--all',
        '--topo-order',
        '--no-show-signature',
        '--no-color',
        `--max-count=${limit + 1}`,
        ...formatArgs,
        '--',
      ],
      repository.path,
      'loadCommitGraphHistory'
    ),
    git(
      [
        'for-each-ref',
        '--format=%(objectname)%00%(*objectname)%00%(refname:short)%00%(refname)%00%(HEAD)',
        'refs/heads',
        'refs/remotes',
        'refs/tags',
      ],
      repository.path,
      'loadCommitGraphRefs'
    ),
  ])

  const commits: IGraphCommit[] = []
  for (const { sha, parents, summary, author, date } of parse(history.stdout)) {
    commits.push({
      sha,
      parents: parents.length > 0 ? parents.split(' ') : [],
      summary,
      author,
      date,
    })
  }

  const refs: IGraphRef[] = []
  for (const line of refResult.stdout.split('\n')) {
    if (line.length === 0) {
      continue
    }

    const [objectSha, peeledSha, name, fullName, head] = line.split('\x00')
    if (!objectSha || !name || !fullName) {
      continue
    }
    if (fullName.startsWith('refs/remotes/') && fullName.endsWith('/HEAD')) {
      continue
    }

    const kind = fullName.startsWith('refs/heads/')
      ? 'local'
      : fullName.startsWith('refs/remotes/')
      ? 'remote'
      : 'tag'
    refs.push({
      ref: fullName,
      sha: peeledSha || objectSha,
      name,
      kind,
      isCurrent: head === '*',
    })
  }

  const hasMore = commits.length > limit
  return layoutCommitGraph(commits.slice(0, limit), refs, hasMore)
}

/**
 * Topological, deterministic lane layout. Each lane represents a pending
 * parent SHA; merge connections either join an existing lane or spawn one.
 * Edges are mapped from the top to the bottom of each rendered row.
 */
export function layoutCommitGraph(
  commits: ReadonlyArray<IGraphCommit>,
  refs: ReadonlyArray<IGraphRef>,
  hasMore = false
): ICommitGraphData {
  const refsBySha = new Map<string, IGraphRef[]>()
  for (const ref of refs) {
    const bucket = refsBySha.get(ref.sha) || []
    bucket.push(ref)
    refsBySha.set(ref.sha, bucket)
  }

  const active: ILane[] = []
  const rows: IGraphRow[] = []
  let nextColor = 0
  let maximumColumns = 1

  for (const commit of commits) {
    let column = active.findIndex(lane => lane.sha === commit.sha)
    const incoming = column !== -1
    if (column === -1) {
      column = active.length
      active.push({ sha: commit.sha, color: nextColor++ })
    }

    const oldLanes = active.slice()
    const color = active[column].color
    active.splice(column, 1)

    // Reuse a lane if the first parent was already introduced by a merge.
    // Otherwise, continue this commit's lane down to its first parent.
    if (commit.parents.length > 0) {
      const first = commit.parents[0]
      if (!active.some(lane => lane.sha === first)) {
        active.splice(column, 0, { sha: first, color })
      }
    }

    for (const parent of commit.parents.slice(1)) {
      if (!active.some(lane => lane.sha === parent)) {
        const insertionPoint = Math.min(column + 1, active.length)
        active.splice(insertionPoint, 0, {
          sha: parent,
          color: nextColor++,
        })
      }
    }

    const connections: IGraphConnection[] = []
    for (let index = 0; index < oldLanes.length; index++) {
      if (index === column) {
        continue
      }
      const next = active.findIndex(lane => lane.sha === oldLanes[index].sha)
      if (next !== -1) {
        connections.push({
          from: index,
          to: next,
          color: oldLanes[index].color,
        })
      }
    }

    const parentConnections: IGraphConnection[] = []
    for (const parent of commit.parents) {
      const index = active.findIndex(lane => lane.sha === parent)
      if (index !== -1) {
        parentConnections.push({
          from: column,
          to: index,
          color: active[index].color,
        })
      }
    }

    maximumColumns = Math.max(maximumColumns, oldLanes.length, active.length)
    rows.push({
      commit,
      column,
      color,
      incoming,
      connections,
      parentConnections,
      refs: refsBySha.get(commit.sha) || [],
    })
  }

  return { rows, width: Math.max(54, maximumColumns * 22 + 16), hasMore }
}
