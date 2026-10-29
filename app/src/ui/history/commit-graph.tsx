import * as React from 'react'
import { AutoSizer, Grid, GridCellProps, Dimensions } from 'react-virtualized'
import { Branch, BranchType } from '../../models/branch'
import { Commit, CommitOneLine } from '../../models/commit'
import { Repository } from '../../models/repository'
import { PopupType } from '../../models/popup'
import { getCommitsBetweenCommits } from '../../lib/git'
import { getSymbolicRef } from '../../lib/git/refs'
import {
  IGraphCommit,
  IGraphRef,
  IGraphRow,
  ICommitGraphData,
  loadCommitGraph,
} from '../../lib/git/commit-graph'
import { IMenuItem, showContextualMenu } from '../../lib/menu-item'
import { clipboard } from 'electron'
import { defaultErrorHandler, Dispatcher } from '../dispatcher'
import {
  CommitGraphChanges,
  ICommitGraphChangesOptions,
} from './commit-graph-changes'

const GraphColors = [
  '#4fa7ff',
  '#db89ff',
  '#36bd9c',
  '#e8a349',
  '#e76d8a',
  '#7c9bff',
  '#b7c25b',
  '#58c2d1',
]
const ColumnOffset = 12

interface ICommitGraphProps {
  readonly repository: Repository
  readonly dispatcher: Dispatcher
  readonly branches: ReadonlyArray<Branch>
  readonly currentBranch: Branch | null
  readonly commitLookup: ReadonlyMap<string, Commit>
  readonly onViewCommitOnGitHub: (sha: string) => void
  readonly onCherryPick: (
    repository: Repository,
    commits: ReadonlyArray<CommitOneLine>
  ) => void
  readonly askForConfirmationOnCheckoutCommit: boolean
  readonly changesOptions: ICommitGraphChangesOptions
}

interface ICommitGraphState {
  readonly graph: ICommitGraphData | null
  readonly loading: boolean
  readonly runningAction: boolean
  readonly error: string | null
  readonly selectedSha: string | null
  readonly filter: string
  readonly limit: number
  readonly compact: boolean
}

function graphX(column: number, columnWidth: number): number {
  return ColumnOffset + column * columnWidth
}

function graphPath(
  from: number,
  to: number,
  startY: number,
  endY: number,
  columnWidth: number
) {
  const x1 = graphX(from, columnWidth)
  const x2 = graphX(to, columnWidth)
  const middle = startY + (endY - startY) / 2
  return `M ${x1} ${startY} C ${x1} ${middle}, ${x2} ${middle}, ${x2} ${endY}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A graph view in the existing History section. Every mutation delegates to
 * Desktop's Dispatcher so auth prompts, state refreshes, warnings, and conflict
 * handling remain in the normal app flow.
 */
export class CommitGraph extends React.Component<
  ICommitGraphProps,
  ICommitGraphState
> {
  private generation = 0
  private readonly listRef = React.createRef<Grid>()

  public constructor(props: ICommitGraphProps) {
    super(props)
    this.state = {
      graph: null,
      loading: true,
      runningAction: false,
      error: null,
      selectedSha: null,
      filter: '',
      limit: 350,
      compact: true,
    }
  }

  public componentDidMount() {
    this.refresh()
  }

  public componentWillUnmount() {
    this.generation++
  }

  private branchFingerprint(branches: ReadonlyArray<Branch>): string {
    return branches
      .map(b => `${b.ref}:${b.tip.sha}`)
      .sort()
      .join('|')
  }

  public componentDidUpdate(prevProps: ICommitGraphProps) {
    this.listRef.current?.forceUpdate()
    if (
      prevProps.repository.path !== this.props.repository.path ||
      prevProps.currentBranch?.ref !== this.props.currentBranch?.ref ||
      prevProps.currentBranch?.tip.sha !== this.props.currentBranch?.tip.sha ||
      this.branchFingerprint(prevProps.branches) !==
        this.branchFingerprint(this.props.branches)
    ) {
      this.refresh()
    }
  }

  private refresh = async () => {
    const request = ++this.generation
    this.setState({ loading: true, error: null })

    try {
      const graph = await loadCommitGraph(
        this.props.repository,
        this.state.limit
      )
      if (request === this.generation) {
        this.setState({
          graph,
          loading: false,
          selectedSha:
            this.state.selectedSha &&
            graph.rows.some(row => row.commit.sha === this.state.selectedSha)
              ? this.state.selectedSha
              : graph.rows.length > 0
              ? graph.rows[0].commit.sha
              : null,
        })
      }
    } catch (error) {
      if (request === this.generation) {
        this.setState({ loading: false, error: errorMessage(error) })
      }
    }
  }

  private loadMore = () => {
    this.setState({ limit: this.state.limit + 350 }, this.refresh)
  }

  private runAction = async (action: () => Promise<unknown>) => {
    if (this.state.runningAction) {
      return
    }
    this.setState({ runningAction: true, error: null })
    try {
      await action()
      await this.refresh()
    } catch (error) {
      this.setState({ error: errorMessage(error) })
      defaultErrorHandler(
        error instanceof Error ? error : new Error(String(error)),
        this.props.dispatcher
      )
    } finally {
      this.setState({ runningAction: false })
    }
  }

  private findBranch = (ref: IGraphRef): Branch | null => {
    if (ref.kind === 'tag') {
      return null
    }
    return (
      this.props.branches.find(
        branch =>
          branch.ref === ref.ref &&
          branch.type ===
            (ref.kind === 'local' ? BranchType.Local : BranchType.Remote)
      ) || null
    )
  }

  private isCurrentBranch = (branch: Branch): boolean => {
    const current = this.props.currentBranch
    return (
      current !== null &&
      branch.type === BranchType.Local &&
      branch.name === current.name
    )
  }

  private checkoutBranch = (branch: Branch) => {
    this.runAction(() =>
      this.props.dispatcher.checkoutBranch(this.props.repository, branch)
    )
  }

  private pushBranch = (branch: Branch) => {
    this.runAction(async () => {
      const repository = this.isCurrentBranch(branch)
        ? this.props.repository
        : await this.props.dispatcher.checkoutBranch(
            this.props.repository,
            branch
          )
      // Checkout may pause for confirmation or fail; verify before a remote action.
      if ((await getSymbolicRef(repository, 'HEAD')) !== branch.ref) {
        return
      }
      await this.props.dispatcher.push(repository)
    })
  }

  private pullBranch = (branch: Branch) => {
    this.runAction(async () => {
      const repository = this.isCurrentBranch(branch)
        ? this.props.repository
        : await this.props.dispatcher.checkoutBranch(
            this.props.repository,
            branch
          )
      // Checkout may pause for confirmation or fail; verify before a remote action.
      if ((await getSymbolicRef(repository, 'HEAD')) !== branch.ref) {
        return
      }
      await this.props.dispatcher.pull(repository)
    })
  }

  private rebaseCurrentOnto = (base: Branch) => {
    const target = this.props.currentBranch
    if (target === null || target.ref === base.ref) {
      return
    }

    this.runAction(async () => {
      const commits = await getCommitsBetweenCommits(
        this.props.repository,
        base.tip.sha,
        target.tip.sha
      )
      if (commits === null) {
        throw new Error(`Unable to calculate rebase onto ${base.name}`)
      }
      await this.props.dispatcher.startRebase(
        this.props.repository,
        base,
        target,
        commits
      )
    })
  }

  private mergeIntoCurrent = (branch: Branch) => {
    this.props.dispatcher.startMergeBranchOperation(
      this.props.repository,
      false,
      branch
    )
  }

  private fastForwardTo = (branch: Branch) => {
    const current = this.props.currentBranch
    if (current === null) {
      return
    }
    this.runAction(() =>
      this.props.dispatcher.fastForwardBranch(
        this.props.repository,
        current,
        branch
      )
    )
  }

  private onRefContextMenu = (
    event: React.MouseEvent<HTMLButtonElement>,
    ref: IGraphRef
  ) => {
    event.preventDefault()
    event.stopPropagation()
    showContextualMenu(this.getRefMenu(ref))
  }

  private getRefMenu = (ref: IGraphRef): IMenuItem[] => {
    const branch = this.findBranch(ref)
    const current = branch !== null && this.isCurrentBranch(branch)
    const localBranch = branch !== null && branch.type === BranchType.Local
    const canMerge =
      branch !== null &&
      this.props.currentBranch !== null &&
      !current &&
      !this.state.runningAction
    const items: IMenuItem[] = [
      {
        label: 'Copy ref name',
        action: () => clipboard.writeText(ref.name),
      },
    ]

    if (branch !== null) {
      items.unshift({
        label: 'Checkout branch',
        enabled: !current && !this.state.runningAction,
        action: () => this.checkoutBranch(branch),
      })
    }

    if (localBranch && branch !== null) {
      items.push({ type: 'separator' })
      items.push({
        label: current ? 'Push branch' : 'Checkout and push branch',
        enabled: !this.state.runningAction,
        action: () => this.pushBranch(branch),
      })
      items.push({
        label: current ? 'Pull branch' : 'Checkout and pull branch',
        enabled: !this.state.runningAction,
        action: () => this.pullBranch(branch),
      })
      if (this.props.repository.gitHubRepository !== null) {
        items.push({
          label: 'Create pull request…',
          action: () => {
            this.runAction(() =>
              this.props.dispatcher.openCreatePullRequestInBrowser(
                this.props.repository,
                branch
              )
            )
          },
        })
      }
    }

    if (canMerge && branch !== null) {
      items.push({ type: 'separator' })
      items.push({
        label: `Fast-forward current branch to ${branch.name}`,
        action: () => this.fastForwardTo(branch),
      })
      items.push({
        label: `Merge ${branch.name} into current branch`,
        action: () => this.mergeIntoCurrent(branch),
      })
      items.push({
        label: `Rebase current branch onto ${branch.name}`,
        action: () => this.rebaseCurrentOnto(branch),
      })
    }

    return items
  }

  private onMoreRefs = (event: React.MouseEvent<HTMLButtonElement>) => {
    const row = this.state.graph?.rows.find(
      row => row.commit.sha === event.currentTarget.dataset.sha
    )
    if (row !== undefined) {
      this.setState({ selectedSha: row.commit.sha })
      showContextualMenu(
        row.refs.map(ref => ({
          label: ref.name,
          submenu: this.getRefMenu(ref),
        }))
      )
    }
  }

  private onCommitContextMenu = (
    event: React.MouseEvent<HTMLButtonElement>,
    commit: IGraphCommit
  ) => {
    event.preventDefault()
    this.setState({ selectedSha: commit.sha })
    const item: CommitOneLine = { sha: commit.sha, summary: commit.summary }
    const items: IMenuItem[] = [
      {
        label: 'Copy commit SHA',
        action: () => clipboard.writeText(commit.sha),
      },
      {
        label: 'View commit on GitHub',
        enabled: this.props.repository.gitHubRepository !== null,
        action: () => this.props.onViewCommitOnGitHub(commit.sha),
      },
      { type: 'separator' },
      {
        label: 'Create branch from commit…',
        action: () => {
          this.props.dispatcher.showPopup({
            type: PopupType.CreateBranch,
            repository: this.props.repository,
            targetCommit: item,
          })
        },
      },
      {
        label: 'Checkout commit…',
        action: () => {
          if (this.props.askForConfirmationOnCheckoutCommit) {
            this.props.dispatcher.showPopup({
              type: PopupType.ConfirmCheckoutCommit,
              repository: this.props.repository,
              commit: item,
            })
          } else {
            this.runAction(() =>
              this.props.dispatcher.checkoutCommit(this.props.repository, item)
            )
          }
        },
      },
      {
        label: 'Cherry-pick commit…',
        action: () => this.props.onCherryPick(this.props.repository, [item]),
      },
    ]

    const loaded = this.props.commitLookup.get(commit.sha)
    if (loaded !== undefined) {
      items.push({
        label: 'Revert commit…',
        action: () =>
          this.runAction(() =>
            this.props.dispatcher.revertCommit(this.props.repository, loaded)
          ),
      })
    }

    showContextualMenu(items)
  }

  private onSelectCommit = (event: React.MouseEvent<HTMLButtonElement>) => {
    this.setState({ selectedSha: event.currentTarget.dataset.sha ?? null })
  }

  private onCommitMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    const row = this.state.graph?.rows.find(
      row => row.commit.sha === event.currentTarget.dataset.sha
    )
    if (row !== undefined) {
      this.onCommitContextMenu(event, row.commit)
    }
  }

  private refForEvent(event: React.MouseEvent<HTMLButtonElement>) {
    const { sha, ref } = event.currentTarget.dataset
    return this.state.graph?.rows
      .find(row => row.commit.sha === sha)
      ?.refs.find(item => item.ref === ref)
  }

  private onBranchMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    const ref = this.refForEvent(event)
    if (ref !== undefined) {
      this.onRefContextMenu(event, ref)
    }
  }

  private onBranchDoubleClick = (
    event: React.MouseEvent<HTMLButtonElement>
  ) => {
    const ref = this.refForEvent(event)
    const branch = ref === undefined ? null : this.findBranch(ref)
    if (branch !== null && !this.isCurrentBranch(branch)) {
      this.checkoutBranch(branch)
    }
  }

  private onFilterChanged = (event: React.ChangeEvent<HTMLInputElement>) => {
    this.setState({ filter: event.currentTarget.value })
  }

  private onCompactChanged = (event: React.ChangeEvent<HTMLInputElement>) => {
    this.setState({ compact: event.currentTarget.checked }, () =>
      this.listRef.current?.recomputeGridSize()
    )
  }

  private get rowHeight() {
    return this.state.compact ? 28 : 38
  }
  private get columnWidth() {
    return this.state.compact ? 10 : 18
  }
  private get graphWidth() {
    return (
      (this.state.graph?.laneCount ?? 1) * this.columnWidth + ColumnOffset * 2
    )
  }

  private renderVirtualRow = ({ rowIndex, key, style }: GridCellProps) => {
    const row = this.state.graph?.rows[rowIndex]
    return row === undefined ? null : (
      <div key={key} style={style}>
        {this.renderRow(row)}
      </div>
    )
  }

  private renderVirtualList = ({ width, height }: Dimensions) => (
    <Grid
      ref={this.listRef}
      width={width}
      height={height}
      rowCount={this.state.graph?.rows.length ?? 0}
      rowHeight={this.rowHeight}
      columnCount={1}
      columnWidth={Math.max(width - 16, this.graphWidth + 480)}
      cellRenderer={this.renderVirtualRow}
      overscanRowCount={8}
    />
  )

  private renderRow(row: IGraphRow): JSX.Element {
    const { commit } = row
    const rowHeight = this.rowHeight
    const columnWidth = this.columnWidth
    const primaryRef = row.refs.find(ref => ref.isCurrent) ?? row.refs[0]
    const selected = this.state.selectedSha === commit.sha
    const q = this.state.filter.toLowerCase()
    const matching =
      q.length === 0 ||
      commit.sha.toLowerCase().includes(q) ||
      commit.summary.toLowerCase().includes(q) ||
      commit.author.toLowerCase().includes(q) ||
      row.refs.some(ref => ref.name.toLowerCase().includes(q))

    return (
      <div
        className={`commit-graph-row${selected ? ' selected' : ''}${
          matching ? '' : ' dimmed'
        }`}
        key={commit.sha}
        style={{ height: rowHeight }}
      >
        <button
          className="commit-graph-commit"
          type="button"
          data-sha={commit.sha}
          onClick={this.onSelectCommit}
          onContextMenu={this.onCommitMenu}
          aria-label={`${commit.author}: ${commit.summary}`}
        >
          <svg
            className="commit-graph-svg"
            width={this.graphWidth}
            height={rowHeight}
            aria-hidden={true}
          >
            {row.connections.map((edge, i) => (
              <path
                key={`lane-${i}`}
                d={graphPath(edge.from, edge.to, 0, rowHeight, columnWidth)}
                stroke={GraphColors[edge.color % GraphColors.length]}
                strokeWidth={2}
                fill="none"
              />
            ))}
            {row.incoming && (
              <path
                d={`M ${graphX(row.column, columnWidth)} 0 V ${rowHeight / 2}`}
                stroke={GraphColors[row.color % GraphColors.length]}
                strokeWidth={2}
                fill="none"
              />
            )}
            {row.parentConnections.map((edge, i) => (
              <path
                key={`parent-${i}`}
                d={graphPath(
                  edge.from,
                  edge.to,
                  rowHeight / 2,
                  rowHeight,
                  columnWidth
                )}
                stroke={GraphColors[edge.color % GraphColors.length]}
                strokeWidth={2}
                fill="none"
              />
            ))}
            <circle
              cx={graphX(row.column, columnWidth)}
              cy={rowHeight / 2}
              r={row.refs.some(ref => ref.isCurrent) ? 4 : 3}
              stroke={GraphColors[row.color % GraphColors.length]}
              strokeWidth={2}
              fill={
                selected
                  ? GraphColors[row.color % GraphColors.length]
                  : 'var(--background-color)'
              }
            />
          </svg>
          <span className="commit-graph-sha">{commit.sha.slice(0, 7)}</span>
          <span className="commit-graph-summary">{commit.summary}</span>
        </button>
        <div className="commit-graph-ref-list">
          {(primaryRef === undefined ? [] : [primaryRef]).map(ref => (
            <button
              key={`${ref.kind}:${ref.name}`}
              className={`commit-graph-ref ${ref.kind}${
                ref.isCurrent ? ' current' : ''
              }`}
              type="button"
              aria-label={`${ref.name} — right-click for branch actions`}
              data-sha={commit.sha}
              data-ref={ref.ref}
              onClick={this.onSelectCommit}
              onContextMenu={this.onBranchMenu}
              onDoubleClick={this.onBranchDoubleClick}
            >
              {ref.name}
            </button>
          ))}
          {row.refs.length > 1 && (
            <button
              type="button"
              className="commit-graph-ref more-refs"
              data-sha={commit.sha}
              aria-label={`Show all ${row.refs.length} branches and tags`}
              onClick={this.onMoreRefs}
            >
              +{row.refs.length - 1}
            </button>
          )}
        </div>
      </div>
    )
  }

  private renderSelectedDetails(): JSX.Element | null {
    const selected = this.state.graph?.rows.find(
      row => row.commit.sha === this.state.selectedSha
    )
    if (selected === undefined) {
      return null
    }
    const { commit } = selected
    const formattedDate = new Date(commit.date).toLocaleString()
    return (
      <section className="commit-graph-details" aria-label="Commit changes">
        <header
          className="commit-graph-detail-summary"
          title={`${commit.author} · ${formattedDate} · ${commit.sha}`}
        >
          <strong>{commit.summary}</strong>
          <span className="commit-graph-sha">{commit.sha.slice(0, 7)}</span>
        </header>
        <CommitGraphChanges
          repository={this.props.repository}
          sha={commit.sha}
          {...this.props.changesOptions}
        />
      </section>
    )
  }

  public render() {
    const graph = this.state.graph
    return (
      <section id="commit-graph-view" aria-label="Commit graph">
        <header className="commit-graph-toolbar">
          <strong>All branches</strong>
          <label className="commit-graph-density">
            <input
              type="checkbox"
              checked={this.state.compact}
              onChange={this.onCompactChanged}
            />
            Compact
          </label>
          <input
            type="search"
            aria-label="Find commit, author, or branch"
            placeholder="Find commit or branch…"
            value={this.state.filter}
            onChange={this.onFilterChanged}
          />
          <button
            type="button"
            onClick={this.refresh}
            disabled={this.state.loading || this.state.runningAction}
          >
            Refresh
          </button>
        </header>
        {this.state.error && (
          <p className="commit-graph-error" role="alert">
            {this.state.error}
          </p>
        )}
        <div className="commit-graph-scroll">
          {this.state.loading && graph === null && <p>Loading commit graph…</p>}
          {graph !== null && graph.rows.length === 0 && (
            <p>No commits found.</p>
          )}
          {graph !== null && graph.rows.length > 0 && (
            <AutoSizer>{this.renderVirtualList}</AutoSizer>
          )}
        </div>
        {graph !== null && graph.hasMore && (
          <button
            className="commit-graph-more"
            type="button"
            onClick={this.loadMore}
            disabled={this.state.loading}
          >
            {this.state.loading ? 'Loading…' : 'Load 350 more commits'}
          </button>
        )}
        {this.renderSelectedDetails()}
      </section>
    )
  }
}
