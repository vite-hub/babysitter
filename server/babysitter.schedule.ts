import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { createGitHubPullRequestRun } from 'vite-hub/agent/server/github'
import { createMessage, runAgent } from 'vite-hub/agent'
import type { ProcessReconcilerRunContext } from 'vite-hub/runtime/node'
import { useServerEnv } from '#vitehub/env/server'
import { github, host, telemetry, createBabysitterAgent, type PassResult } from './agents/babysitter/agent.ts'
import renderPrompt from './agents/babysitter/prompt.template.md'
import { dependencyState, readProviderHeadProof, selectProviderHeadProof } from './babysitter.provider-checkout.ts'
import { assertPromptFits, projectSnapshotContext } from './babysitter.snapshot-prompt.ts'
import { directMergeReadiness, liveMergeReadiness } from './babysitter.direct-merge.ts'
import { stackRetargetBase } from './babysitter.stack-base.ts'
import type { Json } from './babysitter.inbox.ts'

import { isProviderRateLimit, runWithProviderRetry as retryProvider } from './babysitter.provider-retry.ts'
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
import { snapshotPullRequest, createClaimStopCheck, runWithClaimWatch, timeoutRepairWait } from './babysitter.scheduler-state.ts'
import { hydrateSnapshot, reconcileOneSnapshot, readPullRequestThreads } from './babysitter.snapshot-sync.ts'
import { createRequiredPolicyReader, classifyRequiredChecks } from './babysitter.required-policy.ts'
import { createCheckWait, waitBlockers } from './babysitter.wait-state.ts'
import { classifyPassScheduling, isExternalWaitResult, pushedRepairWaitHead, resolveExternalWaitHead, resolveWaitHead } from './babysitter.pass-result.ts'
import { credentialsForRepository, GitHubAppInstallationRequired } from './babysitter.github-credentials.ts'
import { isPullRequestHeadMismatch, recoverPullRequestHead } from './babysitter.head-recovery.ts'

function missingAppInstallation(repository: string): string | undefined {
  try {
    credentialsForRepository(useServerEnv().github, repository, process.env.GITHUB_APP_INSTALLATIONS)
  } catch (error) {
    if (error instanceof GitHubAppInstallationRequired) return error.message
    throw error
  }
}
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

/** Move a stacked PR to the default branch once its parent merged into a branch that is kept. */
async function retargetMergedStackBase(repository: string, number: number, pr: Json | undefined): Promise<{ from: string; to: string } | undefined> {
  const base = pr?.base?.ref, owner = pr?.base?.repo?.owner?.login
  if (!base || !owner || base === pr?.base?.repo?.default_branch) return
  const parents = await readRest(`repos/${repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${base}`)}&per_page=10`)
  const to = stackRetargetBase(pr, parents)
  if (!to) return
  await github.command(['api', '-X', 'PATCH', `repos/${repository}/pulls/${number}`, '-f', `base=${to}`], { repository })
  return { from: base, to }
}

/** Merge a PR that every gate reports ready. Any doubt returns a reason for a worker pass. */
async function mergeReadyPullRequest(repository: string, number: number, head: string): Promise<{ merged: true } | { merged: false; reason: string }> {
  try {
    const [live] = await readRest(`repos/${repository}/pulls/${number}`, '.')
    const decision = liveMergeReadiness(live ?? {}, head)
    if (!decision.ready) return { merged: false, reason: decision.reason }
    await github.command(['api', '-X', 'PUT', `repos/${repository}/pulls/${number}/merge`, '-f', 'merge_method=squash', '-f', `sha=${head}`], { repository })
    return { merged: true }
  } catch (error) {
    return { merged: false, reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && error.name === 'AbortError'
}

function runWithProviderRetry<T>(run: () => Promise<T>): Promise<T> {
  return retryProvider(run, () => {
    pullRequestInbox.setMeta('provider-quota-blocked-until', Date.now() + 60 * 60_000)
  })
}

const POST_PUSH_GRACE_MS = 3 * 60_000

function cancelWhenPullRequestStops(claim: Claim, controller: AbortController, providerDirectory: () => string | undefined, providerProof: () => string | undefined) {
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
  let acceptedAt: number | undefined
  const poll = async () => {
    if (stopped || polling || controller.signal.aborted) return
    polling = true
    try {
      const reason = await check()
      if (reason && !stopped) controller.abort(new DOMException(reason, 'AbortError'))
      else if (!stopped && check.acceptedHead()) {
        // A proved repair push starts new checks and reviews. Their webhooks
        // resume the PR, so a worker that keeps watching them only holds a
        // slot. The timeout path records the pushed head as a check wait.
        acceptedAt ??= Date.now()
        if (Date.now() - acceptedAt >= POST_PUSH_GRACE_MS)
          controller.abort(new DOMException('Repair pushed; waiting for check and review webhooks.', 'TimeoutError'))
      }
    } catch {
      if (!stopped) controller.abort(new DOMException('Unable to verify active pull request state.', 'AbortError'))
    } finally { polling = false }
  }
  // Local snapshots handle cancellation. Git is consulted only after a head
  // change, to distinguish the provider's repair push from an external push.
  const interval = setInterval(() => { void poll() }, 2000)
  void poll()
  return Object.assign(() => { stopped = true; clearInterval(interval) }, { acceptedHead: check.acceptedHead })
}

export function babysitterWorkload() {
  // The scheduler's in-memory set can briefly diverge from ViteHub's durable
  // invocation state during provider startup/recovery. Report the inbox as
  // the source of truth so open actionable PRs are visible as queued work.
  const snapshots = pullRequestInbox.summary()
  const ready = snapshots.filter(item => item.status === 'ready' && item.generation > item.handled)
  const queued = ready.filter(item => !item.baseRef || !snapshots.some(parent =>
    parent.repository === item.repository && parent.number !== item.number
    && String(parent.state).toLowerCase() === 'open'
    && parent.headRef === item.baseRef)).length
  return {
    running: snapshots.filter(item => item.status === 'working').length,
    queued,
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
  const providerBlock = pullRequestInbox.meta<number>('provider-quota-blocked-until') ?? 0
  if (providerBlock > Date.now()) return
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
      if (isProviderRateLimit(error)) pullRequestInbox.setMeta('provider-quota-blocked-until', Date.now() + 60 * 60_000)
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
    let ownedProviderHead: string | undefined
    let acceptedProviderHead: string | undefined
    schedulerEvent('babysitter.owner.started', { maxOwners: ownerLimit, ...owner })
    try {
        const missingBaseInstallation = missingAppInstallation(repository)
        if (missingBaseInstallation) {
          pullRequestInbox.finish(inboxClaim, { text: missingBaseInstallation })
          schedulerEvent('babysitter.owner.waiting', { reason: 'github-app-installation-required', ...owner })
          return
        }
        // Unknown PRs (a comment arriving before opened) need exactly one
        // targeted REST hydration. Normal webhook claims use the local head.
        if (!await hydrateSnapshot(pullRequestInbox, inboxClaim, readRest, readThreads)) {
          pullRequestInbox.release(inboxClaim)
          return
        }
        const staleBase = await retargetMergedStackBase(repository, number, inboxClaim.snapshot.pr ?? undefined)
        if (staleBase) {
          // GitHub sends a pull_request edited webhook for the new base; that pass works on it.
          pullRequestInbox.finish(inboxClaim, { text: `Retargeted from ${staleBase.from} to ${staleBase.to} after the parent pull request merged.` })
          schedulerEvent('babysitter.stack.retargeted', { ...owner, from: staleBase.from, to: staleBase.to })
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
        const mergeDecision = directMergeReadiness(inboxClaim.snapshot, required.state)
        if (mergeDecision.ready) {
          const merged = await mergeReadyPullRequest(repository, number, mergeDecision.head)
          if (merged.merged) {
            pullRequestInbox.finish(inboxClaim, { text: `Merged ${mergeDecision.head} directly: required checks, Pullfrog approval, and review threads were clear.`, terminal: true })
            schedulerEvent('babysitter.owner.merged', { ...owner, head_sha: mergeDecision.head, avoided_invocation: true })
            return
          }
          schedulerEvent('babysitter.direct_merge.skipped', { ...owner, reason: merged.reason })
        }
        const wakeReasons = waitBlockers(inboxClaim.snapshot, required.state)
        if (!wakeReasons.length) {
          outcome = 'waiting'
          pullRequestInbox.finish(inboxClaim, { text: inboxClaim.snapshot.lastResult ?? 'Waiting for checks; no new repair work.', waitForChecks: inboxClaim.snapshot.waitForChecks })
          schedulerEvent('babysitter.preflight.waiting', { ...owner, head_sha: inboxClaim.snapshot.pr.head.sha, required_state: required.state, avoided_invocation: true })
          return
        }
        // Record why the wait could not suppress this generation, so idle
        // model passes can be traced to their cause.
        schedulerEvent('babysitter.preflight.wake', { ...owner, head_sha: inboxClaim.snapshot.pr.head.sha, required_state: required.state, reasons: wakeReasons, triggers: inboxClaim.snapshot.reasons })
        const pullRequest = snapshotPullRequest(inboxClaim.snapshot)
        const missingHeadInstallation = missingAppInstallation(pullRequest.headRepository?.nameWithOwner || repository)
        if (missingHeadInstallation) {
          pullRequestInbox.finish(inboxClaim, { text: missingHeadInstallation })
          schedulerEvent('babysitter.owner.waiting', { reason: 'github-app-installation-required', ...owner })
          return
        }
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
          // Give the worker the hydrated PR state up front, so it does not
          // spend model turns paginating threads, reviews, and checks.
          await writeFile(join(checkout, '.git', 'babysitter-pr-context.json'), JSON.stringify({ ...projectSnapshotContext(inboxClaim.snapshot), dependencies: await dependencyState(checkout) }, null, 1))
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
          const userMessage = await renderPrompt({ context })
          assertPromptFits(userMessage)
          schedulerEvent('babysitter.context.prepared', { repository, pull_request: number, characters: userMessage.length, format: 'task' })
          const passController = new AbortController()
          const githubRun = await createGitHubPullRequestRun(repository, pullRequest, {
            agentName: 'babysitter', runId, publicUrl,
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
          const result = await runWithClaimWatch(stopPullRequestWatch, () => runWithProviderRetry(() => runAgent(agent, {
            runtime: 'vite',
            run: githubRun,
            memo: (_key, create) => create(),
            waitUntil: track,
          }, {
            abortSignal: AbortSignal.any([AbortSignal.timeout(60 * 60 * 1000), passController.signal]),
            context: { ...context, pullRequest: pullRequestInvocation },
            messages: [createMessage({ role: 'user', text: userMessage })],
          }, { schedule: { ...schedule, runId }, output: 'drained' })), head => { acceptedProviderHead = head })
          disposition = (result as PassResult).disposition
          resultText = (result as PassResult).text
          ownedProviderHead = await readProviderHeadProof(providerProof, providerDirectory) ?? stopPullRequestWatch.acceptedHead()
          waitForChecksHead = resolveWaitHead((result as PassResult).waitForChecksHead, ownedProviderHead, pullRequest.headRefOid)

        })

        const current = pullRequestInbox.get(repository, number)
        const terminal = current?.status === 'terminal'
        // A worker that pushed a repair and still reports `retry` would run again
        // on the same pending CI. The pushed head's check and review webhooks
        // resume the PR, so park on that head.
        if (!terminal) waitForChecksHead ??= pushedRepairWaitHead(ownedProviderHead, pullRequest.headRefOid, current?.pr?.head?.sha)
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
        const { parked, noOp } = classifyPassScheduling({ disposition, text: resultText, waitForChecksHead, terminal })
        outcome = parked ? 'completed' : 'retry'
        const waitHead = waitForChecksHead ?? (parked && !terminal && isExternalWaitResult(resultText)
          ? resolveExternalWaitHead(ownedProviderHead, pullRequest.headRefOid, current?.pr?.head?.sha) : undefined)
        pullRequestInbox.finish(inboxClaim, { text: resultText, retry: !parked, terminal,
          waitForChecks: parked && !terminal && waitHead ? createCheckWait(inboxClaim.snapshot, waitHead) : undefined, noOp })
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
        if (isPullRequestHeadMismatch(error)) {
          const recovery = await recoverPullRequestHead(pullRequestInbox, inboxClaim, readRest)
          const terminal = pullRequestInbox.get(repository, number)?.status === 'terminal'
          const reason = error instanceof Error ? error.message : String(error)
          if (recovery.synchronizationWait && !terminal) {
            pullRequestInbox.finish(inboxClaim, { text: recovery.synchronizationWait.text })
            outcome = 'waiting'
            schedulerEvent('babysitter.owner.waiting', { reason: 'github-head-synchronization', ...owner,
              pr_head: recovery.synchronizationWait.prHead, branch_head: recovery.synchronizationWait.branchHead,
              source_repository: recovery.synchronizationWait.sourceRepository, source_branch: recovery.synchronizationWait.sourceBranch })
            return
          }
          pullRequestInbox.finish(inboxClaim, { text: reason, retry: !terminal, terminal, cancelled: !terminal })
          outcome = 'completed'
          schedulerEvent('babysitter.owner.cancelled', { reason, ...owner, head_refreshed: recovery.refreshed,
            ...(recovery.error ? { refresh_error: recovery.error } : {}) })
          return
        }
        outcome = 'failed'
        pullRequestInbox.finish(inboxClaim, {
          text: error instanceof Error ? error.message : String(error),
          retry: true,
          waitForChecks: timeoutRepairWait(error, inboxClaim, pullRequestInbox.get(repository, number), acceptedProviderHead),
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
      host.wake()
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
