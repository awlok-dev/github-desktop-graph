import * as React from 'react'
import { getChangedFiles, getCommitDiff, IChangesetData } from '../../lib/git'
import { Repository } from '../../models/repository'
import { CommittedFileChange } from '../../models/status'
import { IDiff, ImageDiffType } from '../../models/diff'
import { DiffHeader } from '../diff/diff-header'
import { SeamlessDiffSwitcher } from '../diff/seamless-diff-switcher'
import { Resizable } from '../resizable'
import { FileList } from './file-list'

/** Initial diff preferences and the existing repository file actions. */
export interface ICommitGraphChangesOptions {
  readonly hideWhitespaceInDiff: boolean
  readonly showSideBySideDiff: boolean
  readonly imageDiffType: ImageDiffType
  readonly onOpenBinaryFile: (fullPath: string) => void
  readonly onOpenSubmodule: (fullPath: string) => void
  readonly onOpenInExternalEditor: (path: string) => void
  readonly onDiffOptionsOpened: () => void
}

interface ICommitGraphChangesProps extends ICommitGraphChangesOptions {
  readonly repository: Repository
  readonly sha: string
}

interface ICommitChangesProps extends ICommitGraphChangesProps {
  readonly fileListWidth: number
  readonly onFileListResize: (width: number) => void
  readonly onFileListReset: () => void
  readonly onHideWhitespaceInDiffChanged: (hide: boolean) => Promise<void>
  readonly onShowSideBySideDiffChanged: (show: boolean) => void
  readonly onChangeImageDiffType: (type: ImageDiffType) => void
}

/** Show the selected graph commit's files and historical diff below the graph. */
export function CommitGraphChanges(props: ICommitGraphChangesProps) {
  const [hideWhitespace, setHideWhitespace] = React.useState(
    props.hideWhitespaceInDiff
  )
  const [sideBySide, setSideBySide] = React.useState(props.showSideBySideDiff)
  const [imageDiffType, setImageDiffType] = React.useState(props.imageDiffType)
  const [fileListWidth, setFileListWidth] = React.useState(220)
  const onFileListReset = React.useCallback(() => setFileListWidth(220), [])
  const onHideWhitespaceChanged = React.useCallback(async (hide: boolean) => {
    setHideWhitespace(hide)
  }, [])

  // A new commit gets a fresh selection and cannot display a previous commit's
  // files while loading. View preferences survive commit changes.
  return (
    <CommitChanges
      key={`${props.repository.path}:${props.sha}`}
      {...props}
      fileListWidth={fileListWidth}
      onFileListResize={setFileListWidth}
      onFileListReset={onFileListReset}
      hideWhitespaceInDiff={hideWhitespace}
      showSideBySideDiff={sideBySide}
      imageDiffType={imageDiffType}
      onHideWhitespaceInDiffChanged={onHideWhitespaceChanged}
      onShowSideBySideDiffChanged={setSideBySide}
      onChangeImageDiffType={setImageDiffType}
    />
  )
}

function CommitChanges(props: ICommitChangesProps) {
  const { repository, sha } = props
  const [changes, setChanges] = React.useState<IChangesetData | null>(null)
  const [file, setFile] = React.useState<CommittedFileChange | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [attempt, setAttempt] = React.useState(0)
  const retry = React.useCallback(() => setAttempt(value => value + 1), [])

  React.useEffect(() => {
    let cancelled = false
    setChanges(null)
    setFile(null)
    setError(null)
    getChangedFiles(repository, sha).then(
      result => {
        if (!cancelled) {
          setChanges(result)
          setFile(result.files[0] ?? null)
        }
      },
      error => {
        if (!cancelled) {
          setError(String(error))
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [repository, sha, attempt])

  const onRowDoubleClick = React.useCallback(
    (row: number) => {
      const selected = changes?.files[row]
      if (selected !== undefined) {
        props.onOpenInExternalEditor(selected.path)
      }
    },
    [changes, props.onOpenInExternalEditor]
  )

  if (error !== null) {
    return <ChangesError error={error} onRetry={retry} />
  }
  if (changes === null) {
    return (
      <div className="graph-changes-message" role="status">
        Loading changed files…
      </div>
    )
  }
  if (changes.files.length === 0) {
    return (
      <div className="graph-changes-message">
        No files changed in this commit.
      </div>
    )
  }

  return (
    <div
      className="commit-graph-changes"
      role="region"
      aria-label="Selected commit changes"
    >
      <Resizable
        width={props.fileListWidth}
        minimumWidth={160}
        maximumWidth={360}
        onResize={props.onFileListResize}
        onReset={props.onFileListReset}
        description="Graph commit file list"
      >
        <div className="file-list-header">
          {changes.files.length} changed{' '}
          {changes.files.length === 1 ? 'file' : 'files'}
          <span className="graph-change-counts">
            +{changes.linesAdded} −{changes.linesDeleted}
          </span>
        </div>
        <FileList
          files={changes.files}
          selectedFile={file}
          availableWidth={props.fileListWidth - 1}
          onSelectedFileChanged={setFile}
          onRowDoubleClick={onRowDoubleClick}
        />
      </Resizable>
      {file !== null && <CommitFileDiff key={file.id} {...props} file={file} />}
    </div>
  )
}

function CommitFileDiff(
  props: Omit<
    ICommitChangesProps,
    | 'fileListWidth'
    | 'onFileListResize'
    | 'onFileListReset'
    | 'onOpenInExternalEditor'
  > & { readonly file: CommittedFileChange }
) {
  const { repository, sha, file, hideWhitespaceInDiff } = props
  const [loadedDiff, setLoadedDiff] = React.useState<{
    readonly diff: IDiff
    readonly hideWhitespace: boolean
  } | null>(null)
  const diff =
    loadedDiff?.hideWhitespace === hideWhitespaceInDiff ? loadedDiff.diff : null
  const [error, setError] = React.useState<string | null>(null)
  const [attempt, setAttempt] = React.useState(0)
  const retry = React.useCallback(() => setAttempt(value => value + 1), [])

  React.useEffect(() => {
    let cancelled = false
    setLoadedDiff(null)
    setError(null)
    getCommitDiff(repository, file, sha, hideWhitespaceInDiff).then(
      result => {
        if (!cancelled) {
          setLoadedDiff({ diff: result, hideWhitespace: hideWhitespaceInDiff })
        }
      },
      error => {
        if (!cancelled) {
          setError(String(error))
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [repository, sha, file, hideWhitespaceInDiff, attempt])

  return (
    <div className="diff-container">
      <DiffHeader
        diff={diff}
        path={file.path}
        status={file.status}
        showSideBySideDiff={props.showSideBySideDiff}
        onShowSideBySideDiffChanged={props.onShowSideBySideDiffChanged}
        hideWhitespaceInDiff={hideWhitespaceInDiff}
        onHideWhitespaceInDiffChanged={props.onHideWhitespaceInDiffChanged}
        onDiffOptionsOpened={props.onDiffOptionsOpened}
      />
      {error !== null ? (
        <ChangesError error={error} onRetry={retry} />
      ) : (
        <SeamlessDiffSwitcher
          repository={repository}
          file={file}
          diff={diff}
          readOnly={true}
          hideWhitespaceInDiff={hideWhitespaceInDiff}
          showDiffCheckMarks={false}
          showSideBySideDiff={props.showSideBySideDiff}
          imageDiffType={props.imageDiffType}
          onOpenBinaryFile={props.onOpenBinaryFile}
          onOpenSubmodule={props.onOpenSubmodule}
          onChangeImageDiffType={props.onChangeImageDiffType}
          onHideWhitespaceInDiffChanged={props.onHideWhitespaceInDiffChanged}
        />
      )}
    </div>
  )
}

function ChangesError(props: {
  readonly error: string
  readonly onRetry: () => void
}) {
  return (
    <div className="graph-changes-message" role="alert">
      <p>Unable to load changes: {props.error}</p>
      <button type="button" onClick={props.onRetry}>
        Retry
      </button>
    </div>
  )
}
