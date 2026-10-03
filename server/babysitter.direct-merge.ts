import type { Json, Snapshot } from './babysitter.inbox.ts'

type Decision = { ready: true; head: string } | { ready: false; reason: string }

const failing = new Set(['failure', 'error', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'])
const no = (reason: string): Decision => ({ ready: false, reason })

/**
 * A PR that GitHub, CI, and Pullfrog all report ready needs only a merge. Decide
 * that without a model pass. Any doubt returns a reason, and a worker pass runs.
 */
export function directMergeReadiness(snapshot: Snapshot, requiredState: string): Decision {
  const pr = snapshot.pr
  const head = pr?.head?.sha
  if (!pr || String(pr.state).toLowerCase() !== 'open' || !head) return no('not an open pull request')
  if (pr.user?.login !== 'onmax') return no('author outside merge policy')
  if (pr.draft) return no('draft')
  if (requiredState !== 'passed') return no(`required checks ${requiredState}`)
  const checks = Object.values(snapshot.checks).filter((check: Json) => !check.deleted && check.head_sha === head)
  if (checks.some((check: Json) => String(check.status).toLowerCase() !== 'completed')) return no('a current-head check is still running')
  if (checks.some((check: Json) => failing.has(String(check.conclusion).toLowerCase()))) return no('a current-head check failed')
  const statuses = Object.values(snapshot.statuses).filter((status: Json) => !status.deleted && status.sha === head)
  if (statuses.some((status: Json) => status.state !== 'success')) return no('a current-head status is not successful')
  if (!checks.some((check: Json) => check.name === 'pullfrog-approval' && String(check.conclusion).toLowerCase() === 'success')) return no('no current-head Pullfrog approval')
  if (!snapshot.threadsHydrated) return no('review threads not loaded')
  if (snapshot.threads.some((thread: Json) => thread.isResolved !== true)) return no('unresolved review threads')
  return { ready: true, head }
}

/** GitHub's live view must agree right before the merge. */
export function liveMergeReadiness(live: Json, head: string): Decision {
  if (String(live.state).toLowerCase() !== 'open') return no('pull request is no longer open')
  if (live.head?.sha !== head) return no('head changed')
  if (live.draft) return no('draft')
  // A stacked PR keeps its old base after the parent merges, because merged
  // branches are not deleted. Merging it there would strand the change.
  const defaultBranch = live.base?.repo?.default_branch
  if (!defaultBranch || live.base?.ref !== defaultBranch) return no(`base ${live.base?.ref ?? 'unknown'} is not the default branch`)
  if (live.mergeable_state !== 'clean') return no(`mergeable_state ${live.mergeable_state ?? 'unknown'}`)
  return { ready: true, head }
}
