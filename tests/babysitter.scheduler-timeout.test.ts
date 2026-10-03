import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PullRequestInbox } from '../server/babysitter.inbox.ts'
import { createClaimStopCheck, runWithClaimWatch, timeoutRepairWait } from '../server/babysitter.scheduler-state.ts'
import { createCheckWait, shouldKeepWaiting } from '../server/babysitter.wait-state.ts'
import type { Snapshot } from '../server/babysitter.inbox.ts'

test('a rejected invocation retains the watcher-accepted physical repair before cleanup', async t => {
  const provider = await mkdtemp(join(tmpdir(), 'babysitter-timeout-proof-'))
  t.after(() => rm(provider, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: provider, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
  await writeFile(join(provider, 'file.txt'), 'original\n')
  git('add', '.'); git('commit', '-m', 'original')
  const initialHead = git('rev-parse', 'HEAD')
  const inbox = new PullRequestInbox(':memory:', ['vite-hub/vitehub'])
  t.after(() => inbox.close())
  const pr = { number: 42, state: 'open', user: { login: 'onmax' }, head: { sha: initialHead, ref: 'feature' }, base: { ref: 'main' } }
  inbox.seed('vite-hub/vitehub', pr)
  const claim = inbox.claim(1)[0]!
  const current = () => inbox.get('vite-hub/vitehub', 42)
  const check = createClaimStopCheck(claim, current, async () => git('rev-parse', 'HEAD'))
  let captured: string | undefined, stops = 0
  const watch = Object.assign(() => { stops++ }, { acceptedHead: check.acceptedHead })
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  let repair = ''
  await assert.rejects(runWithClaimWatch(watch, async () => {
    await writeFile(join(provider, 'file.txt'), 'repair\n')
    git('add', '.'); git('commit', '-m', 'repair')
    repair = git('rev-parse', 'HEAD')
    inbox.ingest('own-push', 'pull_request', { repository: { full_name: 'vite-hub/vitehub' }, number: 42, action: 'synchronize', pull_request: { ...pr, head: { ...pr.head, sha: repair } } })
    assert.equal(await check(), undefined)
    assert.equal(check.acceptedHead(), repair)
    assert.equal(shouldKeepWaiting({ ...current()!, waitForChecks: createCheckWait(claim.snapshot, repair) }, 'pending'), true)
    inbox.ingest('late-finding', 'pull_request_review_thread', {
      repository: { full_name: 'vite-hub/vitehub' }, action: 'unresolved', pull_request: { number: 42 },
      thread: { node_id: 'late-thread', comments: [{ id: 7, node_id: 'late-comment', body: 'The repaired import still crashes', user: { login: 'reviewer', type: 'User' } }] },
    })
    assert.equal(current()?.threads.find(thread => thread.id === 'late-thread')?.isResolved, false)
    throw timeout
  }, head => { captured = head }), error => error === timeout)
  await rm(provider, { recursive: true, force: true })
  assert.equal(stops, 1)
  assert.equal(captured, repair)
  const wait = timeoutRepairWait(timeout, claim, current(), captured)
  assert.equal(wait?.headSha, repair)
  assert.equal(wait?.contextKey, createCheckWait(claim.snapshot, repair).contextKey)
  inbox.finish(claim, { text: timeout.message, retry: true, waitForChecks: wait })
  assert.equal(current()?.status, 'ready', 'a timeout is still retryable, not a completed pass')
  assert.equal(current()?.waitForChecks?.headSha, repair)
  assert.equal(shouldKeepWaiting(current()!, 'pending'), false, 'the later unresolved finding still wakes repair')
  const next = inbox.claim(1)[0]!
  assert.ok(next)
  assert.ok(next.generation > claim.generation)
  assert.equal(next.snapshot.reviewComments['7']?.body, 'The repaired import still crashes')
  assert.equal(next.snapshot.threads.find(thread => thread.id === 'late-thread')?.isResolved, false)
})

function acceptedFixture(t: { after(fn: () => void): void }) {
  const inbox = new PullRequestInbox(':memory:', ['vite-hub/vitehub'])
  t.after(() => inbox.close())
  inbox.seed('vite-hub/vitehub', { number: 42, state: 'open', user: { login: 'onmax' }, head: { sha: 'initial', ref: 'feature' }, base: { ref: 'main' } })
  const claim = inbox.claim(1)[0]!
  const current = structuredClone(claim.snapshot)
  current.pr!.head.sha = 'repair'
  const check = createClaimStopCheck(claim, () => current, async () => 'repair')
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  return { inbox, claim, current, check, timeout }
}

test('fulfilled invocations capture accepted proof and stop their watcher once', async t => {
  const { check } = acceptedFixture(t)
  assert.equal(await check(), undefined)
  let stops = 0, captured: string | undefined
  const watch = Object.assign(() => { stops++ }, { acceptedHead: check.acceptedHead })
  assert.equal(await runWithClaimWatch(watch, async () => 'result', head => { captured = head }), 'result')
  assert.equal(captured, 'repair')
  assert.equal(stops, 1)
})

const races: [string, (current: Snapshot) => void][] = [
  ['external head', current => { current.pr!.head.sha = 'external' }],
  ['closed PR', current => { current.pr!.state = 'closed' }],
  ['terminal snapshot', current => { current.status = 'terminal' }],
  ['lost lease', current => { current.lease = 'another-owner' }],
]
for (const [name, mutate] of races) {
  test(`${name} before settlement rejects watcher proof`, async t => {
    const { current, check, timeout, claim } = acceptedFixture(t)
    assert.equal(await check(), undefined)
    let captured: string | undefined = 'unexpected'
    const watch = Object.assign(() => {}, { acceptedHead: check.acceptedHead })
    await assert.rejects(runWithClaimWatch(watch, async () => { mutate(current); throw timeout }, head => { captured = head }), error => error === timeout)
    assert.equal(captured, undefined)
    assert.equal(timeoutRepairWait(timeout, claim, current, captured), undefined)
  })
  test(`${name} after settlement rejects the durable timeout checkpoint`, async t => {
    const { current, check, timeout, claim } = acceptedFixture(t)
    assert.equal(await check(), undefined)
    let captured: string | undefined
    const watch = Object.assign(() => {}, { acceptedHead: check.acceptedHead })
    await assert.rejects(runWithClaimWatch(watch, async () => { throw timeout }, head => { captured = head }), error => error === timeout)
    assert.equal(captured, 'repair')
    mutate(current)
    assert.equal(timeoutRepairWait(timeout, claim, current, captured), undefined)
  })
}

test('unproven heads and generic errors never create timeout checkpoints', async t => {
  const { claim, current, timeout } = acceptedFixture(t)
  assert.equal(timeoutRepairWait(timeout, claim, current, undefined), undefined)
  assert.equal(timeoutRepairWait(new Error('Provider failed'), claim, current, 'repair'), undefined)
  assert.equal(timeoutRepairWait(new DOMException('External head changed', 'AbortError'), claim, current, 'repair'), undefined)
})

test('timeout checkpoints retain pending CI but new failures and unfinished feedback wake', async t => {
  const { claim, current, timeout } = acceptedFixture(t)
  const wait = timeoutRepairWait(timeout, claim, current, 'repair')!
  assert.equal(shouldKeepWaiting({ ...current, waitForChecks: wait }, 'pending'), true)
  current.checks['failure'] = { id: 99, name: 'ci', app: { id: 1 }, head_sha: 'repair', status: 'completed', conclusion: 'failure' }
  assert.equal(shouldKeepWaiting({ ...current, waitForChecks: wait }, 'failed'), false)
  delete current.checks['failure']
  current.reviewComments['7'] = { id: 7, body: 'Unfinished repair', user: { login: 'reviewer' } }
  current.threads = [{ id: 'thread', isResolved: false, comments: [{ id: 7 }] }]
  claim.snapshot.reviewComments = structuredClone(current.reviewComments)
  claim.snapshot.threads = structuredClone(current.threads)
  const unfinished = timeoutRepairWait(timeout, claim, current, 'repair')!
  assert.equal(shouldKeepWaiting({ ...current, waitForChecks: unfinished }, 'pending'), false)
})
