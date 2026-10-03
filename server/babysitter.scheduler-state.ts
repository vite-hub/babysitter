import type { PullRequest } from './babysitter.queue.ts'
import type { Claim, Snapshot } from './babysitter.inbox.ts'
import { createCheckWait, type CheckWait } from './babysitter.wait-state.ts'

export async function runWithClaimWatch<T>(watch: (() => void) & { acceptedHead(): string | undefined }, run: () => Promise<T>, recordHead: (head: string | undefined) => void): Promise<T> {
  try {
    return await run()
  } finally {
    try { recordHead(watch.acceptedHead()) }
    finally { watch() }
  }
}

/** A timeout can retain a proved repair without consuming later feedback. */
export function timeoutRepairWait(error: unknown, claim: Claim, current: Snapshot | undefined, acceptedHead: string | undefined): CheckWait | undefined {
  if (!(error instanceof Error) || error.name !== 'TimeoutError' || !acceptedHead) return
  if (current?.pr?.state !== 'open' || claimStopReason(claim, current, acceptedHead)) return
  return createCheckWait(claim.snapshot, acceptedHead)
}

/** REST fields are authoritative; older persisted GraphQL aliases may be stale. */
export function snapshotPullRequest(snapshot: Snapshot): PullRequest {
  const pr = snapshot.pr
  if (!pr?.head?.sha || !pr.head.ref || !pr.base?.ref) throw new Error(`Incomplete PR snapshot for ${snapshot.repository}#${snapshot.number}`)
  return {
    ...pr,
    number: snapshot.number,
    state: String(pr.state).toUpperCase(),
    headRefOid: pr.head.sha,
    headRefName: pr.head.ref,
    baseRefName: pr.base.ref,
    baseRefOid: pr.base.sha ?? '',
    body: pr.body ?? '',
    reviewDecision: pr.reviewDecision ?? '',
    statusCheckRollup: Object.values(snapshot.checks).map(check => ({ ...check, name: check.name ?? check.context, status: String(check.status ?? '').toUpperCase(), conclusion: String(check.conclusion ?? '').toUpperCase() })),
    headRepository: { nameWithOwner: pr.head.repo?.full_name ?? snapshot.repository },
    author: pr.user,
    isDraft: Boolean(pr.draft),
    url: pr.html_url,
    updatedAt: pr.updated_at,
    title: pr.title,
    mergeStateStatus: String(pr.mergeable_state ?? 'UNKNOWN').toUpperCase(),
  } as PullRequest
}

export function claimStopReason(claim: Claim, current: Snapshot | undefined, acceptedSelfHead?: string): string | undefined {
  if (!current || current.lease !== claim.token) return 'Pull request lease lost.'
  if (current.status === 'terminal' || current.pr?.state === 'closed') return 'Pull request is no longer open.'
  if (current.pr?.head?.sha !== (acceptedSelfHead ?? claim.snapshot.pr?.head?.sha)) return 'Pull request head changed.'
}


/** A new remote head may be our repair; prove it against the actual provider Git HEAD. */
export function createClaimStopCheck(
  claim: Claim,
  readCurrent: () => Snapshot | undefined,
  readProviderHead: () => Promise<string | undefined>,
  options: { clock?: () => number; retryMs?: number; retries?: number } = {},
) {
  let acceptedSelfHead: string | undefined
  let pendingHead: string | undefined, failures = 0, nextRead = 0
  const clock = options.clock ?? Date.now
  const check = async (): Promise<string | undefined> => {
    const current = readCurrent()
    const reason = claimStopReason(claim, current, acceptedSelfHead)
    if (reason !== 'Pull request head changed.') return reason
    const remoteHead = current?.pr?.head?.sha
    if (pendingHead !== remoteHead) { pendingHead = remoteHead; failures = 0; nextRead = 0 }
    if (clock() < nextRead) return undefined
    let providerHead: string | undefined
    try { providerHead = await readProviderHead() } catch {}
    // A closed PR, lease loss, or another push may arrive during Git I/O.
    const latest = readCurrent()
    const latestReason = claimStopReason(claim, latest, acceptedSelfHead)
    if (latestReason !== 'Pull request head changed.') return latestReason
    if (providerHead && latest?.pr?.head?.sha === providerHead) {
      acceptedSelfHead = providerHead; failures = 0
      return undefined
    }
    if (providerHead) return 'Pull request head changed: provider Git HEAD differs from remote.'
    if (latest?.pr?.head?.sha !== pendingHead) { pendingHead = latest?.pr?.head?.sha; failures = 0 }
    failures++
    if (failures > (options.retries ?? 3)) return 'Pull request head verification failed: provider Git HEAD unavailable after three retries.'
    nextRead = clock() + (options.retryMs ?? 10_000)
    return undefined
  }
  // The disposable provider and its exit proof may disappear before the
  // scheduler records the result. Reuse only a head this watcher actually
  // accepted, while the same open PR and lease still match that head.
  return Object.assign(check, {
    acceptedHead(): string | undefined {
      const current = readCurrent()
      if (acceptedSelfHead && current?.pr?.state === 'open' && claimStopReason(claim, current, acceptedSelfHead) === undefined)
        return acceptedSelfHead
    },
  })
}
