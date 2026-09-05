import { createHash } from 'node:crypto'

export const defaultMaxOwners = '1'
export const completionPolicyVersion = 'actionable-state-v7'
const lifecycleLabels = new Set(['Agent: Queued', 'Agent: Working'])

export type PullRequestFeedback = { comments: string, reviews: string, threads: string }

export type PullRequest = {
  baseRefOid: string
  baseRefName: string
  body: string
  comments: unknown
  feedback?: PullRequestFeedback
  headRefName: string
  headRefOid: string
  headRepository: { nameWithOwner: string } | null
  isDraft: boolean
  labels?: unknown
  mergeStateStatus: string
  number: number
  reviewDecision: string | null
  reviews: unknown
  requiredStatusCheckRollup?: unknown
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
  const resolved = [...new Set(configured.split(/[\s,]+/).filter(Boolean).map(value => value.toLowerCase()))]
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

export function pullRequestThreadId(repository: string, number: number) {
  return `github:${repository.toLowerCase()}:pull-request:${number}`
}

export async function selectPullRequestJobs(
  repositories: string[],
  listPullRequests: (repository: string) => Promise<PullRequest[]>,
  eligible: (key: string, fingerprint: string) => Promise<boolean>,
  policyFingerprint: string,
) {
  const byRepository = await Promise.all(repositories.map(async (repository) => {
    try {
      const pullRequests = await listPullRequests(repository)
      return pullRequests
        .filter(pullRequest => !hasOpenStackParent(pullRequest, pullRequests))
        .map(pullRequest => ({ pullRequest, repository }))
    }
    catch (error) {
      console.error(new Error(`Failed to list pull requests for ${repository}.`, { cause: error }))
      return []
    }
  }))
  const candidates = byRepository.flat()

  const jobs = await Promise.all(candidates.map(async ({ pullRequest, repository }) => {
    const fingerprint = pullRequestFingerprint(repository, pullRequest, policyFingerprint)
    const key = `babysitter/${repository}/pull-requests/${pullRequest.number}`
    const completionFingerprint = successfulPassFingerprint(repository, pullRequest, policyFingerprint)
    return completionFingerprint && await eligible(key, completionFingerprint)
      ? { completionKey: key, fingerprint, pullRequest, repository }
      : undefined
  }))

  return jobs
    .filter((job): job is PullRequestJob => job !== undefined)
    .sort(comparePullRequestJobs)
}

export function prioritizePullRequestJobs(jobs: PullRequestJob[]) {
  const fastLaneIndex = jobs.findIndex(({ pullRequest }) => !pullRequest.isDraft
    && pullRequest.mergeStateStatus === 'CLEAN'
    && pullRequestCheckState(pullRequest.statusCheckRollup) === 'passed'
    && (pullRequest.requiredStatusCheckRollup === undefined
      || pullRequestCheckState(pullRequest.requiredStatusCheckRollup, 'passed') === 'passed'))
  if (fastLaneIndex <= 0) return jobs
  return [jobs[fastLaneIndex]!, ...jobs.slice(0, fastLaneIndex), ...jobs.slice(fastLaneIndex + 1)]
}

function comparePullRequestJobs(left: PullRequestJob, right: PullRequestJob) {
  const leftUpdatedAt = Date.parse(left.pullRequest.updatedAt)
  const rightUpdatedAt = Date.parse(right.pullRequest.updatedAt)
  const leftTime = Number.isNaN(leftUpdatedAt) ? Number.POSITIVE_INFINITY : leftUpdatedAt
  const rightTime = Number.isNaN(rightUpdatedAt) ? Number.POSITIVE_INFINITY : rightUpdatedAt
  if (leftTime !== rightTime) return leftTime - rightTime
  if (left.repository !== right.repository) return left.repository < right.repository ? -1 : 1
  return left.pullRequest.number - right.pullRequest.number
}

function hasOpenStackParent(pullRequest: PullRequest, pullRequests: PullRequest[]) {
  return pullRequests.some(parent => parent.number !== pullRequest.number
    && parent.state === 'OPEN'
    && parent.headRefName === pullRequest.baseRefName)
}

export function createPolicyFingerprint(...policy: string[]) {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16)
}

export function pullRequestFingerprint(repository: string, pullRequest: PullRequest, policyFingerprint: string) {
  return fingerprintPullRequestState(repository, pullRequest, policyFingerprint)
}

export function successfulPassFingerprint(
  repository: string,
  pullRequest: PullRequest,
  policyFingerprint: string,
  observedPullRequest: PullRequest = pullRequest,
) {
  if (pullRequest.state !== 'OPEN') return undefined
  const completedPullRequest = observedPullRequest.headRefOid === pullRequest.headRefOid
    ? observedPullRequest
    : pullRequest
  const checkState = (checks: unknown) => Array.isArray(checks) ? checks.map((check) => {
    if (!check || typeof check !== 'object') return check
    const { name, context, workflowName, workflow } = check as Record<string, unknown>
    return { name: name ?? context, workflow: workflowName ?? workflow, state: pullRequestCheckState([check]) }
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))) : checks
  const completionState: Record<string, unknown> = {
    ...completedPullRequest,
    comments: completedPullRequest.feedback?.comments ?? completedPullRequest.comments,
    labels: stableLabels(completedPullRequest.labels),
    mergeStateStatus: stableMergeStateStatus(completedPullRequest.mergeStateStatus),
    requiredStatusCheckRollup: checkState(completedPullRequest.requiredStatusCheckRollup),
    threads: completedPullRequest.feedback?.threads,
    reviews: completedPullRequest.feedback?.reviews ?? completedPullRequest.reviews,
    statusCheckRollup: checkState(completedPullRequest.statusCheckRollup),
  }
  delete completionState.feedback
  delete completionState.updatedAt
  return fingerprintPullRequestState(repository, completionState, policyFingerprint)
}

function stableMergeStateStatus(status: string) {
  return status === 'DIRTY' || status === 'BEHIND' || status === 'DRAFT'
    ? status
    : 'STABLE'
}

function stableLabels(labels: unknown) {
  if (!Array.isArray(labels)) return labels
  return labels.filter(label => !label || typeof label !== 'object'
    || !lifecycleLabels.has(String((label as Record<string, unknown>).name)))
}

function fingerprintPullRequestState(repository: string, state: unknown, policyFingerprint: string) {
  return createHash('sha256').update(policyFingerprint).update(repository).update(JSON.stringify(state)).digest('hex').slice(0, 16)
}

export function pullRequestCheckState(statusCheckRollup: unknown, empty: 'passed' | 'pending' = 'pending'): 'failed' | 'passed' | 'pending' {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) return empty
  const failedConclusions = new Set(['ACTION_REQUIRED', 'CANCELLED', 'FAILURE', 'STALE', 'STARTUP_FAILURE', 'TIMED_OUT'])
  let pending = false
  for (const value of statusCheckRollup) {
    if (!value || typeof value !== 'object') {
      pending = true
      continue
    }
    const { bucket, conclusion, state, status } = value as Record<string, unknown>
    if (bucket === 'fail' || bucket === 'cancel') return 'failed'
    if (bucket === 'pending') {
      pending = true
      continue
    }
    if (bucket === 'pass' || bucket === 'skipping') continue
    if (state === 'ERROR' || state === 'FAILURE' || status === 'COMPLETED' && typeof conclusion === 'string' && failedConclusions.has(conclusion)) return 'failed'
    if (status === 'COMPLETED') {
      if (typeof conclusion !== 'string' || !conclusion) pending = true
    }
    else if (status !== undefined || state !== 'SUCCESS') pending = true
  }
  return pending ? 'pending' : 'passed'
}

export function parseRequiredChecks(stdout: string, stderr: string): unknown[] | undefined {
  if (stdout.trim()) {
    try {
      const checks: unknown = JSON.parse(stdout)
      return Array.isArray(checks) ? checks : undefined
    }
    catch {
      return undefined
    }
  }
  const message = stderr.trim()
  return /^no (?:required )?checks reported on the '.+' branch$/.test(message) ? [] : undefined
}
