import { createHash } from 'node:crypto'
import type { Json, Snapshot } from './babysitter.inbox.ts'
import { projectSnapshotContext } from './babysitter.snapshot-prompt.ts'

export type CheckWait = { headSha: string; contextKey: string; knownFailures: string[] }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const pending = new Set(['queued', 'in_progress', 'pending', 'waiting', 'requested', 'rerequested', 'created'])
const failed = new Set(['failure', 'error', 'timed_out', 'action_required', 'startup_failure'])

// Webhooks frequently replay reviews and thread resolution with fresh
// transport metadata. Those updates must not invalidate a CI wait when the
// actionable content is unchanged.
function stableFeedback(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableFeedback)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !['updated_at', 'updatedAt', 'url', 'html_url', 'resolutionSource', 'resolutionObservedAt'].includes(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, stableFeedback(item)]))
}

/** CI-only updates may coalesce; changed feedback, intent or base still needs an agent. */
export function repairContextKey(s: Snapshot): string {
  const pr = s.pr ?? {}
  return hash({ title: pr.title, body: pr.body, draft: pr.draft, state: pr.state,
    base: [pr.base?.sha, pr.base?.ref], comments: stableFeedback(s.comments), reviews: stableFeedback(s.reviews),
    reviewComments: stableFeedback(s.reviewComments), threads: stableFeedback(s.threads) })
}

export function currentCheckSignals(s: Snapshot): Json[] {
  const head = s.pr?.head?.sha
  const byId = new Map<string, Json>()
  for (const check of Object.values(s.checks)) {
    if (!head || check.head_sha !== head || check.deleted || !check.name) continue
    // Ignore workflow/suite aggregates; check runs carry a producing app.
    if (!check.app) continue
    const key = `check:${check.id}`
    const old = byId.get(key)
    if (!old || Date.parse(check.completed_at ?? check.started_at ?? '') >= Date.parse(old.completed_at ?? old.started_at ?? '') || !old.completed_at)
      byId.set(key, check)
  }
  for (const status of Object.values(s.statuses)) {
    if (!head || status.sha !== head || status.deleted) continue
    byId.set(`status:${status.context}`, { ...status, name: status.context, status: status.state, conclusion: status.state })
  }
  return [...byId.values()]
}

function failureKeys(s: Snapshot): string[] {
  return currentCheckSignals(s).filter(c => failed.has(c.conclusion ?? c.state))
    .map(c => `${c.id ?? c.context}:${c.conclusion ?? c.state}`).sort()
}

export function createCheckWait(observed: Snapshot, headSha: string): CheckWait {
  return { headSha, contextKey: repairContextKey(observed), knownFailures: failureKeys(observed) }
}

/** This only suppresses idle invocations; it never authorizes a merge. */
export function shouldKeepWaiting(s: Snapshot, requiredState: 'passed' | 'pending' | 'failed' | 'unknown'): boolean {
  const wait = s.waitForChecks
  if (!wait || s.pr?.state !== 'open' || wait.headSha !== s.pr?.head?.sha || wait.contextKey !== repairContextKey(s)) return false
  if (s.pr.mergeable === false || s.pr.mergeable_state === 'dirty') return false
  // The model may mistakenly declare a CI-only wait after a partial repair.
  // Explicit unresolved/unknown threads remain independent work to verify/resolve.
  if (projectSnapshotContext(s).feedback.some(comment => comment.resolution !== 'resolved')) return false
  const failures = failureKeys(s)
  if (failures.some(key => !wait.knownFailures.includes(key))) return false
  // A repeated webhook for the same failed check is not new repair work.
  // Wake only when its failure identity changes; a later green result still
  // wakes through the required-state transition below.
  if (requiredState === 'failed') return true
  const checks = currentCheckSignals(s)
  const activeReview = checks.some(c => c.name?.toLowerCase() === 'pullfrog' && pending.has(c.status ?? c.state))
  if (activeReview || requiredState === 'pending') return true
  if (requiredState === 'passed') return false // optional CI must not strand merge-ready work
  return false // an unknown policy cannot turn optional CI into a durable blocker
}
