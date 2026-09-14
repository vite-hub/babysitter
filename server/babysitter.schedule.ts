import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createGitHubPullRequestRun } from 'vite-hub/agent/server/github'
import { createMessage, runScheduledAgent } from 'vite-hub/agent'
import type { ProcessReconcilerRunContext } from 'vite-hub/runtime/node'
import { useServerEnv } from '#vitehub/env/server'
import { github, consoleClient, host, telemetry, createBabysitterAgent, type PassResult } from './agents/babysitter/agent.ts'
import renderPrompt from './agents/babysitter/prompt.template.md'
import { readProviderHeadProof, selectProviderHeadProof } from './babysitter.provider-checkout.ts'
import { snapshotPrompt, assertPromptFits } from './babysitter.snapshot-prompt.ts'

const schedulerAgent = { agent_name: 'babysitter-scheduler', agent_role: 'scheduler' } as const

function schedulerEvent(name: string, properties: Record<string, unknown> = {}) {
  host.event(name, { ...schedulerAgent, ...properties })
  telemetry.event(name, { ...schedulerAgent, ...properties })
}

function schedulerError(name: string, error: unknown, properties: Record<string, unknown> = {}) {
  host.error(name, error, { ...schedulerAgent, ...properties })
  telemetry.exception(error, { event: name, ...schedulerAgent, ...properties })
}
import { resolveMaxOwners, resolveRepositories } from './babysitter.queue.ts'
import { type Claim } from './babysitter.inbox.ts'
import { pullRequestInbox } from './babysitter.inbox-runtime.ts'
import { snapshotPullRequest, createClaimStopCheck } from './babysitter.scheduler-state.ts'
import { hydrateSnapshot, reconcileOneSnapshot, readPullRequestThreads } from './babysitter.snapshot-sync.ts'
import { hydrateFailedCiEvidence } from './babysitter.ci-evidence.ts'
import { createRequiredPolicyReader, classifyRequiredChecks } from './babysitter.required-policy.ts'
import { createCheckWait, shouldKeepWaiting } from './babysitter.wait-state.ts'
import { resolveWaitHead } from './babysitter.pass-result.ts'
const active = new Set<string>()
const execFileAsync = promisify(execFile)
async function readRest(path: string, projection = '.[]') {
  const repository = path.split('/').slice(1, 3).join('/')
  const result = await github.command(['api', '--paginate', path, '--jq', `${projection} | @json`], { repository })
  return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

const readRequiredPolicy = createRequiredPolicyReader(async path => {
  try {
    const rows = await readRest(path, '.')
    return { status: 200, data: rows.length === 1 ? rows[0] : rows.flat() }
  } catch (error) {
    const status = Number(String(error).match(/HTTP\s+(\d{3})/i)?.[1] ?? 0)
    return { status }
  }
})

async function readCiLog(path: string, repository: string) {
  const result = await github.command(['api', '--allow-escape-sequences', path], { repository })
  return result.stdout
}

async function readThreads(repository: string, number: number) {
  return readPullRequestThreads(async (query, variables) => {
    const args = ['api', 'graphql', '-f', `query=${query}`]
    for (const [key, value] of Object.entries(variables)) {
      if (value === null) continue
      args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`)
    }
    const result = await github.command(args, { repository })
    return JSON.parse(result.stdout)
  }, repository, number)
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && error.name === 'AbortError'
}

function isProviderRateLimit(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message}\n${error.cause instanceof Error ? error.cause.message : String(error.cause ?? '')}` : String(error)
  return /\b429\b|too many requests|rate limit/i.test(text)
}

// A retry that only reports an external/pending gate must become a durable
// wait. Treating it as immediately retryable creates an agent spin loop (as
// seen on #1350 overnight) while CI or exact-base evidence cannot change.
function isExternalWaitResult(text: string): boolean {
  return /(?:exact[- ]base|unrelated|external|pending|in progress|waiting for|no (?:independent )?repair|cannot (?:start|run)|dependencies.*unavailable)/i.test(text)
}

async function runWithProviderRetry<T>(run: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await run()
    }
    catch (error) {
      lastError = error
      if (!isProviderRateLimit(error) || attempt === 3) throw error
      await new Promise(resolve => setTimeout(resolve, 10_000))
    }
  }
  throw lastError
}

function cancelWhenPullRequestStops(claim: Claim, controller: AbortController, providerDirectory: () => string | undefined, providerProof: () => string | undefined): () => void {
  let stopped = false, polling = false
  const check = createClaimStopCheck(claim,
    () => pullRequestInbox.get(claim.snapshot.repository, claim.snapshot.number),
    async () => {
      const cwd = providerDirectory()
      const proof = await selectProviderHeadProof(cwd, providerProof(), async () => {
        const result = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd, encoding: 'utf8', timeout: 3000, maxBuffer: 1024 })
        return result.stdout.trim()
      })
      schedulerEvent('babysitter.head.proof', { repository: claim.snapshot.repository, pull_request: claim.snapshot.number, source: proof.source, head: proof.head ?? null, provider_directory: cwd, error_code: proof.errorCode })
      return proof.head
    })
  const poll = async () => {
    if (stopped || polling || controller.signal.aborted) return
    polling = true
    try {
      const reason = await check()
      if (reason && !stopped) controller.abort(new DOMException(reason, 'AbortError'))
    } catch {
      if (!stopped) controller.abort(new DOMException('Unable to verify active pull request state.', 'AbortError'))
    } finally { polling = false }
  }
  // Local snapshots handle cancellation. Git is consulted only after a head
  // change, to distinguish the provider's repair push from an external push.
  const interval = setInterval(() => { void poll() }, 2000)
  void poll()
  return () => { stopped = true; clearInterval(interval) }
}

export function babysitterWorkload() {
  // The scheduler's in-memory set can briefly diverge from ViteHub's durable
  // invocation state during provider startup/recovery. Report the inbox as
  // the source of truth so open actionable PRs are visible as queued work.
  const snapshots = pullRequestInbox.summary()
  return {
    running: snapshots.filter(item => item.status === 'working').length,
    queued: snapshots.filter(item => item.status === 'ready' && item.dirty).length,
  }
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
  if (!isAccepting()) return
  const ownerLimit = resolveMaxOwners(maxOwners)
  // Provider access is an admission prerequisite.  A broken ghx token used to
  // let the durable inbox claim work and only fail after spending an agent
  // session.  Probe once per short interval, then leave all claims parked
  // until the provider is reachable again.
  const providerProbeKey = 'provider-access-probe-v1'
  const providerProbe = pullRequestInbox.meta<{ checkedAt: number; ok: boolean; error?: string }>(providerProbeKey)
  const probeFresh = providerProbe && Date.now() - providerProbe.checkedAt < 30_000
  if (!probeFresh || !providerProbe.ok) {
    try {
      await github.command(['api', 'rate_limit'], { repository: repositories[0] })
      pullRequestInbox.setMeta(providerProbeKey, { checkedAt: Date.now(), ok: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pullRequestInbox.setMeta(providerProbeKey, { checkedAt: Date.now(), ok: false, error: message.slice(0, 500) })
      schedulerError('babysitter.provider.unavailable', error, { reason: 'admission-probe' })
      return
    }
  }
  // Bootstrap once per repository and persist even an empty successful list.
  // Failed reads stay retryable; they must never masquerade as empty success.
  for (const repository of repositories) {
    const key = `bootstrap-rest-v1:${repository}`
    const previous = pullRequestInbox.meta<{ at: string }>(key)
    if (previous && Date.now() - Date.parse(previous.at) < 30 * 60_000) continue
    // Failed bootstraps retry on the repair timer, not on every owner wake.
    const nextKey = `${key}:next`
    if ((pullRequestInbox.meta<number>(nextKey) ?? 0) > Date.now()) continue
    pullRequestInbox.setMeta(nextKey, Date.now() + 2 * 60_000)
    try {
      const result = await github.command(['api', '--paginate', `repos/${repository}/pulls?state=open&per_page=100`, '--jq', '.[] | @json'], { repository })
      const prs = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      for (const pr of prs) if (pr.user?.login === 'onmax') pullRequestInbox.seed(repository, pr)
      pullRequestInbox.setMeta(key, { at: new Date().toISOString() })
    } catch (error) { schedulerError('babysitter.bootstrap.failed', error, { repository }) }
  }
  try { await reconcileOneSnapshot(pullRequestInbox, readRest, Date.now(), readThreads) }
  catch (error) { schedulerError('babysitter.snapshot.reconcile.failed', error) }
  if (!isAccepting()) return
  // The durable inbox is the sole eligibility checkpoint. A second work
  // tracker checkpoint used to swallow new webhook generations and leak
  // their leases for two hours.
  const jobs = pullRequestInbox.claim(Math.max(0, ownerLimit - active.size))
  if (!jobs.length) return // tracking an already-resolved batch creates wake loops
  for (const claim of jobs) active.add(`${claim.snapshot.repository}#${claim.snapshot.number}`)
  schedulerEvent('babysitter.queue.selected', { reason, selected: jobs.length, owner_limit: ownerLimit, active_owners: active.size })
  const batchStartedAt = Date.now()

  schedulerEvent('babysitter.batch.started', {
    jobs: jobs.length,
    maxOwners: ownerLimit,
    reason,
    repositories,
    scheduleId: schedule.runId || schedule.id,
  })
  const batch = Promise.all(jobs.map(async inboxClaim => {
    const repository = inboxClaim.snapshot.repository
    const number = inboxClaim.snapshot.number
    const runId = `${schedule.runId}:${repository}:pr-${number}:generation-${inboxClaim.generation}`
    const owner = { pullRequest: number, repository, runId }
    const startedAt = Date.now()
    let outcome = 'completed'
    let disposition: PassResult['disposition'] | undefined
    let resultText = ''
    let waitForChecksHead: string | undefined
    schedulerEvent('babysitter.owner.started', { maxOwners: ownerLimit, ...owner })
    try {
        // Unknown PRs (a comment arriving before opened) need exactly one
        // targeted REST hydration. Normal webhook claims use the local head.
        if (!await hydrateSnapshot(pullRequestInbox, inboxClaim, readRest, readThreads)) {
          pullRequestInbox.release(inboxClaim)
          return
        }
        if (inboxClaim.snapshot.pr?.user?.login !== 'onmax' || inboxClaim.snapshot.pr?.state !== 'open') {
          pullRequestInbox.finish(inboxClaim, { text: 'PR closed or author outside configured policy.', terminal: true })
          return
        }
        const policy = await readRequiredPolicy(repository, inboxClaim.snapshot.pr.base.ref)
        const required = classifyRequiredChecks(inboxClaim.snapshot, policy)
        if (!pullRequestInbox.hydrate(inboxClaim, { requiredCheckEvidence: { ...policy, headSha: inboxClaim.snapshot.pr.head.sha, evaluation: required } })) {
          pullRequestInbox.release(inboxClaim)
          return
        }
        if (shouldKeepWaiting(inboxClaim.snapshot, required.state)) {
          outcome = 'waiting'
          pullRequestInbox.finish(inboxClaim, { text: inboxClaim.snapshot.lastResult ?? 'Waiting for checks; no new repair work.', waitForChecks: inboxClaim.snapshot.waitForChecks })
          schedulerEvent('babysitter.preflight.waiting', { ...owner, head_sha: inboxClaim.snapshot.pr.head.sha, required_state: required.state, avoided_invocation: true })
          return
        }
        if (!await hydrateFailedCiEvidence(pullRequestInbox, inboxClaim, { readJson: readRest, readLog: readCiLog })) {
          pullRequestInbox.release(inboxClaim)
          return
        }
        const pullRequest = snapshotPullRequest(inboxClaim.snapshot)
        const webhookSnapshot = inboxClaim.snapshot
        await github.withPullRequestCheckout({
          headRef: pullRequest.headRefName,
          headRepository: pullRequest.headRepository?.nameWithOwner,
          headSha: pullRequest.headRefOid,
          number: pullRequest.number,
          repository,
        }, async ({ path: checkout }) => {
          schedulerEvent('babysitter.checkout.ready', {
            repository,
            pull_request: pullRequest.number,
            head_sha: pullRequest.headRefOid,
          })
          const context = {
            preparedCheckout: checkout,
            pullRequestHead: pullRequest.headRefOid,
            pullRequestNumber: pullRequest.number,
            pullRequestRepository: repository,
            pullRequestSourceBranch: pullRequest.headRefName,
            pullRequestSourceRepository: pullRequest.headRepository?.nameWithOwner || '(unavailable)',
            pullRequestTitle: pullRequest.title,
            pullRequestUrl: pullRequest.url,
          }
          let providerDirectory: string | undefined, providerProof: string | undefined
          const agent = createBabysitterAgent(checkout, repository, (cwd, proofPath) => {
            providerDirectory = cwd; providerProof = proofPath
            schedulerEvent('babysitter.provider.prepared', { repository, pull_request: pullRequest.number, provider_directory: cwd })
          })
          const prompt = await renderPrompt({ context })
          const snapshotContext = snapshotPrompt(webhookSnapshot)
          const userMessage = `${prompt}\n\n${snapshotContext}`
          assertPromptFits(userMessage)
          schedulerEvent('babysitter.context.prepared', { repository, pull_request: number, characters: snapshotContext.length, format: 'xml' })
          const passController = new AbortController()
          const githubRun = await createGitHubPullRequestRun(repository, pullRequest, {
            agentName: 'babysitter', runId, publicUrl,
            sessionUrl: consoleClient?.endpoint(`/?view=sessions&session=${encodeURIComponent(runId)}`),
          })
          // The GitHub run helper uses a stable PR thread id. Scope the
          // provider session to this exact head so a new checkout never
          // resumes a Codex process whose temporary cwd was deleted.
          githubRun.threadId = `${githubRun.threadId}:${pullRequest.headRefOid}`
          const [owner = '', name = ''] = repository.split('/')
          const pullRequestInvocation = {
            pullRequest: {
              number: pullRequest.number, apiUrl: pullRequest.url, htmlUrl: pullRequest.url,
              title: pullRequest.title, source: { repo: repository, mount: repository, ref: pullRequest.headRefName, checkout: false },
              head: { sha: pullRequest.headRefOid, ref: pullRequest.headRefName },
              base: { ref: pullRequest.baseRefName, sha: pullRequest.baseRefOid },
            },
            repository: { fullName: repository, owner, name },
            run: { messageId: runId, origin: 'github-pull-request', runId, threadId: githubRun.threadId },
            trigger: { event: 'pull_request' as const, action: 'synchronize' as const, actor: { login: 'vitehub-bot[bot]' }, args: '', command: '', comment: { id: 0 } },
          }
          const stopPullRequestWatch = cancelWhenPullRequestStops(inboxClaim, passController, () => providerDirectory, () => providerProof)
          const result = await runWithProviderRetry(() => runScheduledAgent(agent, {
            ...schedule,
            runId,
          }, {
            runtime: 'vite',
            run: githubRun,
          }, {
            abortSignal: AbortSignal.any([AbortSignal.timeout(60 * 60 * 1000), passController.signal]),
            context: { ...context, pullRequest: pullRequestInvocation },
            messages: [createMessage({ role: 'user', text: userMessage })],
          })).finally(stopPullRequestWatch)
          disposition = (result as PassResult).disposition
          resultText = (result as PassResult).text
          waitForChecksHead = resolveWaitHead((result as PassResult).waitForChecksHead, await readProviderHeadProof(providerProof, providerDirectory), pullRequest.headRefOid)

        })

        const current = pullRequestInbox.get(repository, number)
        const terminal = current?.status === 'terminal'
        // A model's bare `park` is not enough to put a failing PR to sleep.
        // CI failures are actionable work: agents must get another pass to
        // repair them. Park only when the result explicitly describes an
        // external/pending gate (or the PR is terminal). This prevents a
        // mistaken "park" response from turning a red required check into a
        // permanent queue blocker while still avoiding polling loops for CI
        // that is genuinely in progress.
        // A waitForChecksHead is an explicit durable checkpoint from the
        // agent. Respect it even when the agent used `retry` to report that
        // no repository change was made; relaunching the same head burns a
        // full model session without creating any new GitHub evidence.
        const parked = terminal || waitForChecksHead !== undefined
          || disposition === 'park' && isExternalWaitResult(resultText)
          || disposition === 'retry' && isExternalWaitResult(resultText)
        outcome = parked ? 'completed' : 'retry'
        const waitHead = waitForChecksHead ?? (parked && !terminal && isExternalWaitResult(resultText) ? pullRequest.headRefOid : undefined)
        pullRequestInbox.finish(inboxClaim, { text: resultText, retry: !parked, terminal,
          waitForChecks: parked && !terminal && waitHead ? createCheckWait(inboxClaim.snapshot, waitHead) : undefined })
    }
    catch (error) {
      if (isAbortError(error)) {
        outcome = 'completed'
        const terminal = pullRequestInbox.get(repository, number)?.status === 'terminal'
        const reason = error instanceof Error ? error.message : String(error)
        pullRequestInbox.finish(inboxClaim, { text: reason, retry: !terminal, terminal, cancelled: !terminal })
        schedulerEvent('babysitter.owner.cancelled', { reason, ...owner })
      }
      else if (github.isRateLimitError(error)) {
        outcome = 'deferred'
        pullRequestInbox.finish(inboxClaim, { text: 'GitHub rate limit; retrying after budget reset.', retry: true })
        schedulerEvent('babysitter.owner.deferred', { reason: 'github-rate-limit', ...owner })
      }
      else {
        outcome = 'failed'
        if (/AGENT_R0767|head.*(?:mismatch|changed)|expected.*head/i.test(String(error))) {
          pullRequestInbox.hydrate(inboxClaim, { refresh: true })
        }
        pullRequestInbox.finish(inboxClaim, {
          text: error instanceof Error ? error.message : String(error),
          retry: true,
        })
        schedulerError('babysitter.owner.failed', error, owner)
      }
    }
    finally {
      schedulerEvent('babysitter.owner.finished', {
        durationMs: Date.now() - startedAt,
        outcome,
        ...owner,
      })
      active.delete(`${repository}#${number}`)
      // The process host may coalesce a wake while this batch is still
      // completing. Schedule the next admission after releasing the lease so
      // ready PRs continue draining up to the configured capacity.
      setTimeout(() => host.wake(), 100)
    }
  })).then(() => {}).finally(() => {
    schedulerEvent('babysitter.batch.finished', {
      durationMs: Date.now() - batchStartedAt,
      jobs: jobs.length,
      maxOwners: ownerLimit,
      repositories,
      scheduleId: schedule.runId || schedule.id,
    })
  }).catch(error => schedulerError('babysitter.batch.failed', error, { scheduleId: schedule.runId }))
  track(batch)
}
