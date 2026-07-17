import { createHash } from 'node:crypto'

export type PullRequest = {
  body: string
  headRefName: string
  headRefOid: string
  isDraft: boolean
  mergeStateStatus: string
  number: number
  reviewDecision: string | null
  state: string
  statusCheckRollup: unknown
  title: string
  updatedAt: string
  url: string
}

export type PullRequestJob = {
  completionKey: string
  fingerprint: string
  pullRequest: PullRequest
  repository: string
}

export function resolveRepositories(repositories: string, repository: string) {
  const configured = repositories.trim() || repository
  const resolved = [...new Set(configured.split(/[\s,]+/).filter(Boolean))]
  if (resolved.length === 0) throw new Error('At least one Babysitter repository is required.')
  for (const value of resolved) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`Invalid GitHub repository: ${value}`)
  }
  return resolved
}

export function resolveMaxOwners(value: string) {
  const maxOwners = Number(value)
  if (!Number.isInteger(maxOwners) || maxOwners < 1) throw new Error(`Invalid Babysitter owner limit: ${value}`)
  return maxOwners
}

export async function selectPullRequestJobs(
  repositories: string[],
  maxOwners: number,
  listPullRequests: (repository: string) => Promise<PullRequest[]>,
  readCompletion: (key: string) => Promise<string | null>,
) {
  const candidates = (await Promise.all(repositories.map(async repository =>
    (await listPullRequests(repository)).map(pullRequest => ({ pullRequest, repository })),
  ))).flat()

  const jobs = await Promise.all(candidates.map(async ({ pullRequest, repository }) => {
    const fingerprint = pullRequestFingerprint(pullRequest)
    const key = completionKey(repository, pullRequest.number)
    return await readCompletion(key) === fingerprint
      ? undefined
      : { completionKey: key, fingerprint, pullRequest, repository }
  }))

  return jobs.filter((job): job is PullRequestJob => job !== undefined).slice(0, maxOwners)
}

export function completionKey(repository: string, pullRequestNumber: number) {
  return `babysitter/${repository}/pull-requests/${pullRequestNumber}`
}

export function pullRequestFingerprint(pullRequest: PullRequest) {
  return createHash('sha256').update(JSON.stringify(pullRequest)).digest('hex').slice(0, 16)
}
