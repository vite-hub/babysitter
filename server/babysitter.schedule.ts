import { createHash } from 'node:crypto'
import { createMessage, runScheduledAgent } from 'vite-hub/agent'
import { agentInvocationId } from 'vite-hub/agent/server'
import { createWorkTracker, type WorkOutcome } from 'vite-hub/runtime'
import { consoleClient } from './console.ts'
import { kv } from 'vite-hub/kv'
import type { ProcessReconcilerRunContext } from 'vite-hub/runtime/node'
import { useServerEnv } from '#vitehub/env/server'
import { createBabysitterAgent, type PassResult } from './agents/babysitter/agent.ts'
import blocker from './agents/babysitter/blocker.md?raw'
import renderPrompt from './agents/babysitter/prompt.template.md'
import promptTemplate from './agents/babysitter/prompt.template.md?raw'
import { github } from './github.ts'
import {
  logOperationalError,
  logOperationalEvent,
} from './babysitter.operations.ts'
import {
  completionPolicyVersion,
  successfulPassFingerprint,
  createPolicyFingerprint,
  parseRequiredChecks,
  type PullRequest,
  type PullRequestFeedback,
  prioritizePullRequestJobs,
  pullRequestThreadId,
  pullRequestCheckState,
  resolveMaxOwners,
  resolveRepositories,
  selectPullRequestJobs,
} from './babysitter.queue.ts'
import { invocations } from './invocations.ts'

const policyFingerprint = createPolicyFingerprint(promptTemplate, blocker, completionPolicyVersion)
const pullRequestFields = 'baseRefOid,baseRefName,body,headRefName,headRefOid,headRepository,isDraft,labels,mergeStateStatus,number,reviewDecision,state,statusCheckRollup,title,updatedAt,url'
const work = createWorkTracker({
  store: {
    get: readCompletion,
    async set(key, value) {
      const [error] = await kv.set(key, value)
      if (error) throw error
    },
  },
})
let wakeReconciler = () => {}

export function setBabysitterReconcilerWake(wake: () => void) {
  wakeReconciler = wake
}

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

  logOperationalEvent('babysitter.batch.started', {
    jobs: jobs.length,
    maxOwners: ownerLimit,
    reason,
    repositories,
    scheduleId: schedule.runId || schedule.id,
  })
  const batch = Promise.all(jobs.map(async job => {
    const { pullRequest, repository } = job
    const runId = `${schedule.runId || schedule.id}:${repository}:pr-${pullRequest.number}:${job.fingerprint}`
    const threadId = pullRequestThreadId(repository, pullRequest.number)
    const owner = { pullRequest: pullRequest.number, repository, runId }
    const startedAt = Date.now()
    let outcome = 'completed'
    let failure: unknown
    let disposition: PassResult['disposition'] | undefined
    logOperationalEvent('babysitter.owner.started', {
      head: pullRequest.headRefOid,
      maxOwners: ownerLimit,
      workItems: work.active,
      ...owner,
    })
    try {
      await work.run(job.completionKey, successfulPassFingerprint(repository, pullRequest, policyFingerprint)!, async (): Promise<WorkOutcome> => {
        await github.withPullRequestCheckout({
          headRef: pullRequest.headRefName,
          headRepository: pullRequest.headRepository?.nameWithOwner,
          headSha: pullRequest.headRefOid,
          number: pullRequest.number,
          repository,
        }, async ({ path: checkout, ...access }) => {
          const context = {
            pullRequestHead: pullRequest.headRefOid,
            pullRequestNumber: pullRequest.number,
            pullRequestRepository: repository,
            pullRequestSourceBranch: pullRequest.headRefName,
            pullRequestSourceRepository: pullRequest.headRepository?.nameWithOwner || '(unavailable)',
            pullRequestTitle: pullRequest.title,
            pullRequestUrl: pullRequest.url,
          }
          const agent = createBabysitterAgent(checkout, access)
          const prompt = await renderPrompt({ blocker, context })
          const result = await runScheduledAgent(agent, {
            ...schedule,
            runId,
          }, {
            runtime: 'vite',
            run: {
              activity: {
                target: { repository, issue: pullRequest.number },
                links: publicUrl ? [{ label: 'Current session', url: new URL(`/_vitehub/agents/babysitter/invocations/${encodeURIComponent(await agentInvocationId(runId, 'babysitter'))}`, publicUrl).href }] : consoleClient ? [{ label: 'Current session', url: consoleClient.endpoint(`/?view=sessions&session=${encodeURIComponent(runId)}`) }] : [],
              },
              annotations: {
                'github.head': pullRequest.headRefOid,
                'github.pullRequest': pullRequest.number,
                'github.repository': repository,
                'github.title': pullRequest.title,
                'github.url': pullRequest.url,
              },
              channelId: 'github',
              runId,
              threadId,
            },
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
        logOperationalEvent('babysitter.owner.deferred', { reason: 'github-rate-limit', ...owner })
      }
      else {
        outcome = 'failed'
        failure = error
        logOperationalError('babysitter.owner.failed', error, owner)
      }
    }
    finally {
      logOperationalEvent('babysitter.owner.finished', {
        durationMs: Date.now() - startedAt,
        outcome,
        ...owner,
      })
      wakeReconciler()
    }
  })).then(() => {}).finally(() => {
    logOperationalEvent('babysitter.batch.finished', {
      durationMs: Date.now() - batchStartedAt,
      jobs: jobs.length,
      maxOwners: ownerLimit,
      repositories,
      scheduleId: schedule.runId || schedule.id,
    })
  }).catch(error => logOperationalError('babysitter.batch.failed', error, { scheduleId: schedule.runId }))
  track(batch)
}

async function readCompletion(key: string) {
  const [error, value] = await kv.get(key)
  if (error) throw error
  return value
}

async function listPullRequests(repository: string) {
  try {
    return await withGraphQLBudget(repository, 256, async () => {
      const [result, feedback] = await Promise.all([
        github.command(['pr', 'list', '--repo', repository, '--state', 'open', '--limit', '100', '--json', pullRequestFields], { repository }),
        readOpenPullRequestFeedback(repository),
      ])
      const pullRequests = JSON.parse(result.stdout) as PullRequest[]
      return await Promise.all(pullRequests.map(pullRequest => readRequiredCheckState(repository, {
        ...pullRequest,
        ...feedback.has(pullRequest.number) ? { feedback: feedback.get(pullRequest.number) } : {},
      })))
    })
  }
  catch (error) {
    if (github.isRateLimitError(error)) return []
    throw error
  }
}

async function readPullRequest(repository: string, number: number) {
  return await withGraphQLBudget(repository, 16, async () => {
    const [result, feedback] = await Promise.all([
      github.command(['pr', 'view', String(number), '--repo', repository, '--json', pullRequestFields], { repository }),
      readPullRequestFeedback(repository, number),
    ])
    return await readRequiredCheckState(repository, {
      ...JSON.parse(result.stdout) as PullRequest,
      ...feedback ? { feedback } : {},
    })
  })
}

async function withGraphQLBudget<T>(repository: string, cost: number, run: () => Promise<T>) {
  const reservation = await github.ensureGraphQLBudget(repository, { cost })
  reservation.submit()
  try {
    return await run()
  }
  finally {
    // The gh CLI does not expose actual query cost, so settle the reserved upper bound.
    reservation.settle(cost)
  }
}

const feedbackFields = `comments(first:100,after:$comments){nodes{id body updatedAt author{login}} pageInfo{hasNextPage endCursor}} reviews(first:100,after:$reviews){nodes{id body updatedAt state commit{oid}} pageInfo{hasNextPage endCursor}} reviewThreads(first:100,after:$threads){nodes{id isResolved comments(first:100){nodes{id body updatedAt} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}`

async function readOpenPullRequestFeedback(repository: string) {
  // Bulk first pages keep discovery cheap; large discussions fall back to pagination.
  const [owner, name] = repository.split('/') as [string, string]
  const query = `query($owner:String!,$name:String!,$comments:String,$reviews:String,$threads:String){repository(owner:$owner,name:$name){pullRequests(first:100,states:OPEN){nodes{number ${feedbackFields}}}}}`
  const result = await github.command(['api', 'graphql', '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `query=${query}`], { repository })
  const nodes = JSON.parse(result.stdout)?.data?.repository?.pullRequests?.nodes
  if (!Array.isArray(nodes)) throw new Error('GitHub did not return pull request feedback.')
  return new Map<number, PullRequestFeedback>(await Promise.all(nodes.map(async node => [
    node.number,
    Object.values(feedbackConnections(node)).some(connection => connection.pageInfo.hasNextPage)
      || node.reviewThreads.nodes.some((thread: any) => thread.comments.pageInfo.hasNextPage)
      ? await readPullRequestFeedback(repository, node.number)
      : digestFeedback(node),
  ] as [number, PullRequestFeedback])))
}

function feedbackConnections(node: any): Record<string, { nodes: any[], pageInfo: { hasNextPage: boolean, endCursor: string } }> {
  if (!node?.comments?.nodes || !node?.reviews?.nodes || !node?.reviewThreads?.nodes) throw new Error('Incomplete GitHub feedback response.')
  return { comments: node.comments, reviews: node.reviews, threads: node.reviewThreads }
}

function digestFeedback(node: any): PullRequestFeedback {
  const digest = (items: any[]) => createHash('sha256').update(JSON.stringify(items.sort((a, b) => a.id.localeCompare(b.id)))).digest('hex')
  return {
    comments: digest(node.comments.nodes.filter((comment: any) => !(['vitehub-bot', 'vitehub-bot[bot]'].includes(comment.author?.login) && comment.body.startsWith('<!-- vitehub-agent-activity:')))),
    reviews: digest(node.reviews.nodes),
    threads: digest(node.reviewThreads.nodes),
  }
}

async function readPullRequestFeedback(repository: string, number: number): Promise<PullRequestFeedback> {
  const [owner, name] = repository.split('/') as [string, string]
  const query = `query($owner:String!,$name:String!,$number:Int!,$comments:String,$reviews:String,$threads:String){repository(owner:$owner,name:$name){pullRequest(number:$number){${feedbackFields}}}}`
  const cursors = new Map<string, string>()
  const collected = { comments: new Map(), reviews: new Map(), threads: new Map() }
  do {
    const result = await github.command(['api', 'graphql', '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`, '-f', `query=${query}`, ...[...cursors].flatMap(([key, value]) => ['-f', `${key}=${value}`])], { repository })
    const node = JSON.parse(result.stdout)?.data?.repository?.pullRequest
    let more = false
    for (const [key, connection] of Object.entries(feedbackConnections(node))) {
      const items = collected[key as keyof typeof collected]
      for (const item of connection.nodes) items.set(item.id, item)
      if (connection.pageInfo.hasNextPage) {
        cursors.set(key, connection.pageInfo.endCursor)
        more = true
      }
    }
    if (!more) break
  } while (true)
  for (const thread of collected.threads.values()) {
    while (thread.comments.pageInfo.hasNextPage) {
      const query = 'query($id:ID!,$after:String){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$after){nodes{id body updatedAt} pageInfo{hasNextPage endCursor}}}}}'
      const result = await github.command(['api', 'graphql', '-f', `id=${thread.id}`, '-f', `after=${thread.comments.pageInfo.endCursor}`, '-f', `query=${query}`], { repository })
      const page = JSON.parse(result.stdout)?.data?.node?.comments
      if (!page?.nodes || !page.pageInfo) throw new Error('Incomplete GitHub review thread response.')
      thread.comments.nodes.push(...page.nodes)
      thread.comments.pageInfo = page.pageInfo
    }
  }
  return digestFeedback({ comments: { nodes: [...collected.comments.values()] }, reviews: { nodes: [...collected.reviews.values()] }, reviewThreads: { nodes: [...collected.threads.values()] } })
}

async function readRequiredCheckState(repository: string, pullRequest: PullRequest) {
  if (pullRequestCheckState(pullRequest.statusCheckRollup) === 'passed') return pullRequest
  const requiredStatusCheckRollup = await readRequiredChecks(repository, pullRequest.number)
  return requiredStatusCheckRollup === undefined ? pullRequest : { ...pullRequest, requiredStatusCheckRollup }
}

async function readRequiredChecks(repository: string, number: number) {
  const args = ['pr', 'checks', String(number), '--repo', repository, '--required', '--json', 'bucket,name,state,workflow']
  try {
    const result = await github.command(args, { repository })
    return parseRequiredChecks(result.stdout, result.stderr)
  }
  catch (error) {
    const result = error as Error & { stderr?: unknown, stdout?: unknown }
    const checks = parseRequiredChecks(
      typeof result.stdout === 'string' ? result.stdout : '',
      typeof result.stderr === 'string' ? result.stderr : '',
    )
    if (checks !== undefined) return checks
    console.error(new Error(`Failed to read required checks for ${repository}#${number}.`, { cause: error }))
    return undefined
  }
}
