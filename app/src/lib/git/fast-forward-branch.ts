import { Repository } from '../../models/repository'
import { Branch } from '../../models/branch'
import { getSymbolicRef } from './refs'
import { merge } from './merge'

/** Advance the selected current branch without ever creating a merge commit. */
export async function fastForwardBranch(
  repository: Repository,
  current: Branch,
  target: Branch
): Promise<void> {
  if ((await getSymbolicRef(repository, 'HEAD')) !== current.ref) {
    throw new Error(
      'The current branch changed. Refresh the graph and try again.'
    )
  }
  // Use the canonical ref to disambiguate a branch from a same-named tag.
  await merge(repository, target.ref, { fastForwardOnly: true })
}
