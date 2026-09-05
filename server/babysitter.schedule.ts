import { createGitHubPullRequests, createGitHubPullRequestRun } from '@vite-hub/agent/server/github'
import { createMessage, runScheduledAgent, publishAgentActivity } from 'vite-hub/agent'
import { createWorkTracker, type WorkOutcome } from 'vite-hub/runtime'
import { consoleClient } from './console.ts'
import { kv } from 'vite-hub/kv'
import type { ProcessReconcilerRunContext } from 'vite-hub/runtime/node'
import { useServerEnv } from '#vitehub/env/server'
import babysitterAgent, { createBabysitterAgent, type PassResult } from './agents/babysitter/agent.ts'
import renderPrompt from './agents/babysitter/prompt.template.md'
import promptTemplate from './agents/babysitter/prompt.template.md?raw'
import { github } from './github.ts'
import {
  completionPolicyVersion,
  successfulPassFingerprint,
  createPolicyFingerprint,
  prioritizePullRequestJobs,
  pullRequestCheckState,
  resolveMaxOwners,
  resolveRepositories,
  selectPullRequestJobs,
} from './babysitter.queue.ts'
import { host } from './host.ts'
const invocations = host.invocations

const policyFingerprint = createPolicyFingerprint(promptTemplate, completionPolicyVersion)
const pullRequests = createGitHubPullRequests(github, {
  activityAuthors: ['vitehub-bot', 'vitehub-bot[bot]'],
  ignoreComment: comment => comment.author?.login === 'pkg-pr-new[bot]'
    || comment.author?.login === 'chatgpt-codex-connector[bot]'
      && comment.body.startsWith('You have reached your Codex usage limits for code reviews.'),
})
const work = createWorkTracker({
  store: {
    get: readCompletion,
    async set(key, value) {
      const [error] = await kv.set(key, value)
      if (error) throw error
    },
  },
})
export function babysitterWorkload() {
  return { running: work.active }
}

export async function reconcileBabysitterWork(
  reason: string,
  { track }: ProcessReconcilerRunContext,
  isAccepting: () => boolean = () => true,
) {
  const startedAt = new Date()
  const schedule = {
    id: 'babysitter-demand',
    runId: `demand:${startedAt.toISOString()}`,
    scheduledAt: startedAt,
  }
  const { maxOwners, publicUrl, repositories: configuredRepositories, repository } = useServerEnv().babysitter
  const repositories = resolveRepositories(configuredRepositories, repository)
  const discovered = await selectPullRequestJobs(repositories, listPullRequests, work.eligible, policyFingerprint)
  if (!isAccepting()) return
  const ownerLimit = resolveMaxOwners(maxOwners)
  const availableOwnerSlots = Math.max(0, ownerLimit - work.active)
  const eligible = discovered
    .filter(job => !work.has(job.completionKey))
  const jobs = (ownerLimit > 1 ? prioritizePullRequestJobs(eligible) : eligible)
    .slice(0, availableOwnerSlots)
  const batchStartedAt = Date.now()

  host.event('babysitter.batch.started', {
    jobs: jobs.length,
    maxOwners: ownerLimit,
    reason,
    repositories,
    scheduleId: schedule.runId || schedule.id,
  })
  const batch = Promise.all(jobs.map(async job => {
    const { pullRequest, repository } = job
    const runId = `${schedule.runId || schedule.id}:${repository}:pr-${pullRequest.number}:${job.fingerprint}`
    const owner = { pullRequest: pullRequest.number, repository, runId }
    const startedAt = Date.now()
    let outcome = 'completed'
    let failure: unknown
    let disposition: PassResult['disposition'] | undefined
    host.event('babysitter.owner.started', {
      head: pullRequest.headRefOid,
      maxOwners: ownerLimit,
      workItems: work.active,
      ...owner,
    })
    try {
      await work.run(job.completionKey, successfulPassFingerprint(repository, pullRequest, policyFingerprint)!, async (): Promise<WorkOutcome> => {
        const waitingForChecks = pullRequestCheckState(pullRequest.statusCheckRollup) === 'pending'
          && pullRequestCheckState(pullRequest.requiredStatusCheckRollup, 'passed') !== 'failed'
          && pullRequest.feedback?.hasDiscussion === false
          && !['DIRTY', 'BEHIND'].includes(pullRequest.mergeStateStatus)
        if (waitingForChecks) {
          await publishAgentActivity(babysitterAgent, {
            channelId: 'github', target: { repository, issue: pullRequest.number },
            activity: { runId: `wait:${job.fingerprint}`, status: 'queued', links: [], tasks: [], summary: 'Waiting for checks to finish.' },
          })
          return { disposition: 'park' }
        }
        await github.withPullRequestCheckout({
          headRef: pullRequest.headRefName,
          headRepository: pullRequest.headRepository?.nameWithOwner,
          headSha: pullRequest.headRefOid,
          number: pullRequest.number,
          repository,
        }, async ({ path: checkout }) => {
          const context = {
            pullRequestHead: pullRequest.headRefOid,
            pullRequestNumber: pullRequest.number,
            pullRequestRepository: repository,
            pullRequestSourceBranch: pullRequest.headRefName,
            pullRequestSourceRepository: pullRequest.headRepository?.nameWithOwner || '(unavailable)',
            pullRequestTitle: pullRequest.title,
            pullRequestUrl: pullRequest.url,
          }
          const agent = createBabysitterAgent(checkout)
          const prompt = await renderPrompt({ context })
          const result = await runScheduledAgent(agent, {
            ...schedule,
            runId,
          }, {
            runtime: 'vite',
            run: await createGitHubPullRequestRun(repository, pullRequest, {
              agentName: 'babysitter', runId, publicUrl,
              sessionUrl: consoleClient?.endpoint(`/?view=sessions&session=${encodeURIComponent(runId)}`),
            }),
          }, {
            abortSignal: AbortSignal.timeout(60 * 60 * 1000),
            context,
            messages: [createMessage({ role: 'user', text: prompt })],
          })
          disposition = (result as PassResult).disposition

        })

        const current = await readPullRequest(repository, pullRequest.number)
        const fingerprint = successfulPassFingerprint(repository, current, policyFingerprint, pullRequest)
        const parked = current.state !== 'OPEN' || disposition === 'park'
        outcome = parked ? 'completed' : 'retry'
        return { disposition: parked ? 'park' : 'retry', ...(fingerprint ? { fingerprint } : {}) }
      })
    }
    catch (error) {
      if (github.isRateLimitError(error)) {
        outcome = 'deferred'
        host.event('babysitter.owner.deferred', { reason: 'github-rate-limit', ...owner })
      }
      else {
        outcome = 'failed'
        failure = error
        host.error('babysitter.owner.failed', error, owner)
      }
    }
    finally {
      host.event('babysitter.owner.finished', {
        durationMs: Date.now() - startedAt,
        outcome,
        ...owner,
      })
      host.wake()
    }
  })).then(() => {}).finally(() => {
    host.event('babysitter.batch.finished', {
      durationMs: Date.now() - batchStartedAt,
      jobs: jobs.length,
      maxOwners: ownerLimit,
      repositories,
      scheduleId: schedule.runId || schedule.id,
    })
  }).catch(error => host.error('babysitter.batch.failed', error, { scheduleId: schedule.runId }))
  track(batch)
}

async function readCompletion(key: string) {
  const [error, value] = await kv.get(key)
  if (error) throw error
  return value
}

async function listPullRequests(repository: string) {
  try { return await pullRequests.list(repository) }
  catch (error) {
    if (github.isRateLimitError(error)) return []
    throw error
  }
}
const readPullRequest = (repository: string, number: number) => pullRequests.read(repository, number)
