import type { Claim, Json, PullRequestInbox } from './babysitter.inbox.ts'

export type HeadRecovery = { refreshed: boolean; error?: string; synchronizationWait?: {
  text: string; prHead: string; branchHead: string; sourceRepository: string; sourceBranch: string
} }
const fullHead = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)

export function isPullRequestHeadMismatch(error: unknown): boolean {
  return /AGENT_R0763|AGENT_R0767|pull request head(?: SHA)? verification failed|head.*(?:mismatch|changed)|expected.*head/i.test(String(error))
}

/** A checkout rejected an obsolete head. Refresh that PR without spending a provider pass. */
export async function recoverPullRequestHead(
  inbox: PullRequestInbox,
  claim: Claim,
  read: (path: string, projection?: string) => Promise<Json[]>,
): Promise<HeadRecovery> {
  // Webhooks can advance the generation while checkout is being prepared.
  // Mark the lease itself, rather than using hydration's generation CAS.
  if (!inbox.requestRefresh(claim)) return { refreshed: false }
  const { repository, number } = claim.snapshot
  try {
    const [pr] = await read(`repos/${repository}/pulls/${number}`, '.')
    if (!pr) throw new Error('GitHub returned no pull request during head recovery.')
    inbox.ingest(`head-recovery:${claim.token}`, 'pull_request', {
      repository: { full_name: repository },
      action: pr.state === 'closed' ? 'closed' : 'synchronize',
      pull_request: pr,
    })
    const sourceRepository = pr.head?.repo?.full_name
    const sourceBranch = pr.head?.ref
    const prHead = pr.head?.sha
    const canVerifySource = () => {
      const current = inbox.get(repository, number)
      return current?.lease === claim.token && current.generation === claim.generation
        && current.pr?.state === 'open' && current.pr.head.sha === prHead
        && current.pr.head.ref === sourceBranch && current.pr.head.repo?.full_name === sourceRepository
    }
    // A changed PR head already has fresh work queued. Only an unchanged,
    // owned generation can be parked for a source/PR synchronization delay.
    if (pr.state !== 'open' || prHead !== claim.snapshot.pr?.head?.sha || !fullHead(prHead)
      || typeof sourceRepository !== 'string' || typeof sourceBranch !== 'string' || !canVerifySource()) return { refreshed: true }
    let source: Json | undefined
    try {
      [source] = await read(`repos/${sourceRepository}/git/ref/heads/${encodeURIComponent(sourceBranch)}`, '.')
    } catch (error) {
      return { refreshed: true, error: error instanceof Error ? error.message : String(error) }
    }
    const branchHead = source?.object?.sha
    if (source?.ref !== `refs/heads/${sourceBranch}` || source.object?.type !== 'commit'
      || !fullHead(branchHead) || branchHead === prHead || !canVerifySource()) return { refreshed: true }
    return { refreshed: true, synchronizationWait: {
      prHead, branchHead, sourceRepository, sourceBranch,
      text: `Waiting for GitHub head synchronization: PR ${repository}#${number} reports ${prHead}, but source ${sourceRepository}:${sourceBranch} reports ${branchHead}. No provider was launched. Resume when a synchronize webhook or recovery observes the PR head change.`,
    } }
  } catch (error) {
    // requestRefresh remains durable when GitHub is temporarily unavailable.
    return { refreshed: false, error: error instanceof Error ? error.message : String(error) }
  }
}
