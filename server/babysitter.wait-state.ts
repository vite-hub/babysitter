import { createHash } from 'node:crypto'
import type { Json, Snapshot } from './babysitter.inbox.ts'
import { projectSnapshotContext } from './babysitter.snapshot-prompt.ts'

export type CheckWait = { headSha: string; contextKey: string; contextParts?: Record<string, string>; knownFailures: string[] }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const pending = new Set(['queued', 'in_progress', 'pending', 'waiting', 'requested', 'rerequested', 'created'])
const failed = new Set(['failure', 'error', 'timed_out', 'action_required', 'startup_failure'])
const workerAuthor = (value: Json) => ['vitehub-bot', 'vitehub-bot[bot]'].includes(value.user?.login ?? value.author?.login)
const commentIds = (value: Json) => [value.id, value.node_id, value.databaseId].filter(id => id !== undefined && id !== null).map(String)

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

// Pullfrog submits an empty review shell and then edits it to its verdict.
// Neither asks for work: inline findings arrive as review comments and
// threads, which stay in the context. Other review bodies remain evidence.
const reviewWithoutFindings = (value: Json) => String(value.state ?? '').toLowerCase() === 'commented'
  && (!String(value.body ?? '').trim() || /^>\s*✅\s*No new issues found\./.test(String(value.body).trimStart()))

/** CI-only updates may coalesce; changed feedback, intent or base still needs an agent. */
export function repairContextKey(s: Snapshot): string {
  return hash(repairContext(s, true))
}

/** Per-part hashes let a wake report which context changed. */
function repairContextParts(s: Snapshot): Record<string, string> {
  return Object.fromEntries(Object.entries(repairContext(s, true)).map(([key, value]) => [key, hash([value])]))
}

function repairContext(s: Snapshot, skipReviewsWithoutFindings: boolean) {
  const pr = s.pr ?? {}
  const external = (values: Record<string, Json>) => Object.fromEntries(Object.entries(values).filter(([, value]) => !workerAuthor(value)))
  const reviews = Object.fromEntries(Object.entries(external(s.reviews)).filter(([, value]) => !skipReviewsWithoutFindings || !reviewWithoutFindings(value)))
  const ownCommentIds = new Set(Object.values(s.reviewComments).filter(workerAuthor).flatMap(commentIds))
  const commentsById = new Map(Object.values(s.reviewComments).flatMap(value => commentIds(value).map(id => [id, value] as const)))
  const threads = s.threads.map(thread => {
    const { isResolved: _, node_id, comments, ...metadata } = thread
    const items: Json[] = Array.isArray(comments) ? comments : comments?.nodes ?? []
    // Hydration supplies GraphQL identifiers; a resolution webhook supplies
    // full REST comments. Their common comment identity is the same evidence.
    const identities = items.filter(value => !workerAuthor(value) && !commentIds(value).some(id => ownCommentIds.has(id)))
      .map(value => {
        const stored = commentIds(value).map(id => commentsById.get(id)).find(Boolean)
        return { id: value.databaseId ?? (typeof value.id === 'number' ? value.id : stored?.id ?? value.node_id ?? value.id),
          body: value.body ?? stored?.body, author: value.user?.login ?? value.author?.login ?? stored?.user?.login ?? stored?.author?.login }
      })
    return { ...metadata, id: node_id ?? thread.id, comments: identities }
  })
  return { title: pr.title, body: pr.body, draft: pr.draft, state: pr.state,
    base: [pr.base?.sha, pr.base?.ref], comments: stableFeedback(external(s.comments)), reviews: stableFeedback(reviews),
    reviewComments: stableFeedback(external(s.reviewComments)), threads: stableFeedback(threads) }
}

// Existing checkpoints retain the old hash. Accept one only when its entire
// original context still matches; never rewrite it using newer feedback.
function previousRepairContextKey(s: Snapshot): string {
  return hash(repairContext(s, false))
}

function legacyRepairContextKey(s: Snapshot): string {
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
  return { headSha, contextKey: repairContextKey(observed), contextParts: repairContextParts(observed), knownFailures: failureKeys(observed) }
}

type RequiredState = 'passed' | 'pending' | 'failed' | 'unknown'

/** This only suppresses idle invocations; it never authorizes a merge. */
export function shouldKeepWaiting(s: Snapshot, requiredState: RequiredState): boolean {
  return waitBlockers(s, requiredState).length === 0
}

/** Why a recorded wait cannot suppress this generation. Empty means keep waiting. */
export function waitBlockers(s: Snapshot, requiredState: RequiredState): string[] {
  const wait = s.waitForChecks
  if (!wait) return ['no-wait']
  if (s.pr?.state !== 'open') return ['not-open']
  if (wait.headSha !== s.pr?.head?.sha) return ['head-changed']
  const blockers: string[] = []
  const key = repairContextKey(s)
  if (wait.contextKey !== key && wait.contextKey !== previousRepairContextKey(s) && wait.contextKey !== legacyRepairContextKey(s)) {
    const parts = repairContextParts(s)
    const changed = wait.contextParts ? Object.keys(parts).filter(part => wait.contextParts![part] !== parts[part]) : []
    blockers.push(changed.length ? `context-changed:${changed.join(',')}` : 'context-changed')
  }
  if (s.pr.mergeable === false || s.pr.mergeable_state === 'dirty') blockers.push('merge-conflict')
  // The model may mistakenly declare a CI-only wait after a partial repair.
  // Explicit unresolved/unknown threads remain independent work to verify/resolve.
  if (s.threads.some(thread => thread.isResolved !== true)) blockers.push('unresolved-threads')
  if (projectSnapshotContext(s).feedback.some(comment => !workerAuthor(comment) && comment.resolution !== 'resolved')) blockers.push('open-feedback')
  if (failureKeys(s).some(failure => !wait.knownFailures.includes(failure))) blockers.push('new-failure')
  if (blockers.length) return blockers
  // A repeated webhook for the same failed check is not new repair work.
  // Wake only when its failure identity changes; a later green result still
  // wakes through the required-state transition below.
  if (requiredState === 'failed') return []
  const checks = currentCheckSignals(s)
  const activeReview = checks.some(c => c.name?.toLowerCase() === 'pullfrog' && pending.has(c.status ?? c.state))
  if (activeReview || requiredState === 'pending') return []
  if (requiredState === 'passed') return ['checks-passed'] // optional CI must not strand merge-ready work
  return ['required-policy-unknown'] // an unknown policy cannot turn optional CI into a durable blocker
}
