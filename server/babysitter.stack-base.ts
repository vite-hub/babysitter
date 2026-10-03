import type { Json } from './babysitter.inbox.ts'

/**
 * Merged branches are not deleted in these repositories, so GitHub does not
 * retarget a stacked PR when its parent merges. Return the branch the PR must
 * target once its parent landed on the default branch, or undefined otherwise.
 */
export function stackRetargetBase(pr: Json, baseBranchPulls: Json[]): string | undefined {
  const defaultBranch = pr.base?.repo?.default_branch
  const base = pr.base?.ref
  if (!defaultBranch || !base || base === defaultBranch) return
  const owner = pr.base?.repo?.owner?.login
  const parents = baseBranchPulls.filter(parent => parent.head?.ref === base && (!owner || parent.head?.repo?.owner?.login === owner))
  // An open parent still owns the base. Only a merged parent proves the base is dead.
  if (parents.some(parent => String(parent.state).toLowerCase() === 'open')) return
  // A parent merged into another stale branch did not land; moving the child
  // would add the parent's unlanded change to the child's diff.
  if (!parents.some(parent => parent.merged_at && parent.base?.ref === defaultBranch)) return
  return defaultBranch
}
