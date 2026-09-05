import { pullRequestCheckState, type PullRequest } from '@vite-hub/agent/server/github'
export { pullRequestCheckState } from '@vite-hub/agent/server/github'
export type { PullRequest } from '@vite-hub/agent/server/github'
import { createHash } from 'node:crypto'

export const defaultMaxOwners = '1'
export const completionPolicyVersion = 'actionable-state-v8'
const lifecycleLabels = new Set(['Agent: Queued', 'Agent: Working'])

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
  const checkState = (checks: unknown) => {
    if (!Array.isArray(checks)) return checks
    const failed = checks.filter(check => pullRequestCheckState([check]) === 'failed').map(check => {
      const { name, context, workflowName, workflow } = check as Record<string, unknown>
      return { name: name ?? context, workflow: workflowName ?? workflow }
    }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    return { state: pullRequestCheckState(checks), failed }
  }
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
