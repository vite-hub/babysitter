import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PullRequestInbox } from '../server/babysitter.inbox.ts'
import { snapshotPullRequest, claimStopReason, createClaimStopCheck } from '../server/babysitter.scheduler-state.ts'
import { createProviderProofLaunch, prepareProviderGit, readProviderHeadProof, selectProviderHeadProof } from '../server/babysitter.provider-checkout.ts'
import { resolveExternalWaitHead } from '../server/babysitter.pass-result.ts'
import { createCheckWait, shouldKeepWaiting } from '../server/babysitter.wait-state.ts'

function fixture() {
  const inbox = new PullRequestInbox(':memory:', ['vite-hub/vitehub'])
  inbox.seed('vite-hub/vitehub', { number: 42, state: 'open', user: { login: 'onmax' }, head: { sha: 'new', ref: 'feature', repo: { full_name: 'vite-hub/vitehub' } }, base: { sha: 'base', ref: 'main' }, headRefOid: 'stale', headRefName: 'stale-branch', title: 'Test', html_url: 'https://github.com/vite-hub/vitehub/pull/42', updated_at: '2026-09-13T00:00:00Z' })
  return inbox
}

test('REST webhook head overrides persisted stale GraphQL aliases for checkout', () => {
  const inbox = fixture()
  try {
    const claim = inbox.claim(1)[0]!
    assert.ok(claim)
    const pr = snapshotPullRequest(claim.snapshot)
    assert.equal(pr.headRefOid, 'new')
    assert.equal(pr.headRefName, 'feature')
    assert.equal(pr.state, 'OPEN')
    assert.equal(pr.url, 'https://github.com/vite-hub/vitehub/pull/42')
  } finally { inbox.close() }
})

test('same-head feedback leaves active pass running; new head cancels without network polling', () => {
  const inbox = fixture()
  try {
    const claim = inbox.claim(1)[0]!
    const current = structuredClone(claim.snapshot)
    current.generation++
    assert.equal(claimStopReason(claim, current), undefined)
    current.pr!.head.sha = 'newer'
    assert.equal(claimStopReason(claim, current), 'Pull request head changed.')
  } finally { inbox.close() }
})

test('terminal webhook and lost lease cancel active pass', () => {
  const inbox = fixture()
  try {
    const claim = inbox.claim(1)[0]!
    const current = structuredClone(claim.snapshot)
    current.status = 'terminal'
    assert.equal(claimStopReason(claim, current), 'Pull request is no longer open.')
    current.lease = 'another-owner'
    assert.equal(claimStopReason(claim, current), 'Pull request lease lost.')
  } finally { inbox.close() }
})

test('new generation remains claimable after old pass parks, without second completion gate', () => {
  const inbox = fixture()
  try {
    const old = inbox.claim(1)[0]!
    inbox.ingest('comment', 'issue_comment', { repository: { full_name: 'vite-hub/vitehub' }, issue: { number: 42, pull_request: {} }, action: 'created', comment: { id: 1, body: 'Please fix test', user: { login: 'onmax', type: 'User' } } })
    inbox.finish(old, { text: 'Waiting for checks' })
    const next = inbox.claim(1)[0]!
    assert.ok(next)
    assert.ok(next.generation > old.generation)
    assert.equal(next.snapshot.comments['1']!.body, 'Please fix test')
  } finally { inbox.close() }
})

test('restart recovers legacy attention records into one retryable generation', () => {
  const inbox = fixture()
  try {
    const claim = inbox.claim(1)[0]!
    inbox.hydrate(claim, { status: 'attention', lease: null, leaseUntil: 0, handled: claim.generation, attempts: 3 })
    assert.equal(inbox.claim(1).length, 0)
    inbox.recoverLeases()
    const recovered = inbox.claim(1)[0]!
    assert.ok(recovered)
    assert.equal(recovered.generation, claim.generation + 1)
    assert.equal(recovered.snapshot.attempts, 0)
  } finally { inbox.close() }
})


test('own repair head proven from provider Git survives cleanup; external head still cancels', async () => {
 const inbox = fixture()
 try {
  const claim = inbox.claim(1)[0]!
  const current = structuredClone(claim.snapshot)
  let reads = 0, cleanup = false
  const check = createClaimStopCheck(claim, () => current, async () => { reads++; if (cleanup) throw new Error('provider directory removed'); return 'repair' })
  assert.equal(check.acceptedHead(), undefined)
  assert.equal(await check(), undefined)
  assert.equal(reads, 0)
  current.pr!.head.sha = 'repair'
  assert.equal(await check(), undefined)
  assert.equal(reads, 1)
  assert.equal(check.acceptedHead(), 'repair')
  cleanup = true
  assert.equal(await check(), undefined)
  assert.equal(reads, 1)
  current.pr!.head.sha = 'external'
  assert.equal(check.acceptedHead(), undefined)
  assert.equal(await check(), undefined)
  assert.equal(reads, 2)
 } finally { inbox.close() }
})

test('head change without a provider HEAD match cancels regardless of bot identity', async () => {
 const inbox = fixture()
 try {
  const claim = inbox.claim(1)[0]!, current = structuredClone(claim.snapshot)
  current.pr!.head.sha = 'external'; current.pr!.user = { login: 'vitehub-bot' }
  for (const providerHead of ['different']) {
   const check = createClaimStopCheck(claim, () => current, async () => providerHead)
   assert.equal(await check(), 'Pull request head changed: provider Git HEAD differs from remote.')
  }
  const failed = createClaimStopCheck(claim, () => current, async () => { throw new Error('git failed') })
  assert.equal(await failed(), undefined)
 } finally { inbox.close() }
})

test('closed PR and lease loss win even after a verified repair push', async () => {
 const inbox = fixture()
 try {
  const claim = inbox.claim(1)[0]!, current = structuredClone(claim.snapshot)
  current.pr!.head.sha = 'repair'
  const check = createClaimStopCheck(claim, () => current, async () => 'repair')
  assert.equal(await check(), undefined)
  assert.equal(check.acceptedHead(), 'repair')
  current.pr!.state = 'closed'
  assert.equal(check.acceptedHead(), undefined)
  current.pr!.state = 'open'
  current.status = 'terminal'
  assert.equal(check.acceptedHead(), undefined)
  assert.equal(await check(), 'Pull request is no longer open.')
  current.status = 'working'; current.lease = 'different'
  assert.equal(check.acceptedHead(), undefined)
  assert.equal(await check(), 'Pull request lease lost.')
 } finally { inbox.close() }
})

test('new remote event during provider HEAD read is rechecked before accepting proof', async () => {
 const inbox = fixture()
 try {
  const claim = inbox.claim(1)[0]!, current = structuredClone(claim.snapshot)
  current.pr!.head.sha = 'repair'
  const check = createClaimStopCheck(claim, () => current, async () => { current.pr!.head.sha = 'external'; return 'repair' })
  assert.equal(await check(), 'Pull request head changed: provider Git HEAD differs from remote.')
  assert.equal(check.acceptedHead(), undefined)
 } finally { inbox.close() }
})

test('accepted real repair survives missing exit proof without hiding feedback received during the pass', { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'babysitter-accepted-head-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'), provider = join(root, 'provider')
  await mkdir(source); await mkdir(provider)
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(source, 'init'); git(source, 'config', 'user.name', 'Test'); git(source, 'config', 'user.email', 'test@example.invalid')
  git(source, 'remote', 'add', 'origin', source)
  await writeFile(join(source, 'file.txt'), 'original\n')
  git(source, 'add', '.'); git(source, 'commit', '-m', 'original')
  const initialHead = git(source, 'rev-parse', 'HEAD')
  await writeFile(join(provider, 'file.txt'), 'original\n')
  await prepareProviderGit(source, provider)
  const launch = await createProviderProofLaunch(source, provider, process.execPath)
  const child = spawn(launch.command, [...launch.args, '-e', "process.stdout.write('ready\\n');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close')
      child.kill('SIGTERM')
      await closed
    }
  })
  await once(child.stdout, 'data')

  const inbox = new PullRequestInbox(':memory:', ['vite-hub/vitehub'])
  t.after(() => inbox.close())
  const pr = { number: 42, state: 'open', user: { login: 'onmax' }, head: { sha: initialHead, ref: 'feature' }, base: { ref: 'main' } }
  inbox.seed('vite-hub/vitehub', pr)
  const claim = inbox.claim(1)[0]!
  const readCurrent = () => inbox.get('vite-hub/vitehub', 42)
  const check = createClaimStopCheck(claim, readCurrent, async () => (await selectProviderHeadProof(provider, launch.proofPath, async () => git(provider, 'rev-parse', 'HEAD'))).head)
  assert.equal(check.acceptedHead(), undefined)
  await writeFile(join(provider, 'file.txt'), 'repair\n')
  git(provider, 'add', '.'); git(provider, 'commit', '-m', 'repair')
  const repairedHead = git(provider, 'rev-parse', 'HEAD')
  inbox.ingest('own-push', 'pull_request', { repository: { full_name: 'vite-hub/vitehub' }, number: 42, action: 'synchronize', pull_request: { ...pr, head: { ...pr.head, sha: repairedHead } } })
  assert.equal(await check(), undefined)
  assert.equal(check.acceptedHead(), repairedHead)

  // Remove the disposable checkout before the wrapper exits, reproducing a
  // missing final JSON proof despite an earlier physical Git acceptance.
  await rm(provider, { recursive: true, force: true })
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  await exited
  const finalProof = await readProviderHeadProof(launch.proofPath, provider)
  assert.equal(finalProof, undefined)
  // Red control: the old final-proof-only path cannot park the repaired head.
  assert.equal(resolveExternalWaitHead(finalProof, initialHead, readCurrent()?.pr?.head?.sha), undefined)
  const checkpoint = resolveExternalWaitHead(finalProof ?? check.acceptedHead(), initialHead, readCurrent()?.pr?.head?.sha)
  assert.equal(checkpoint, repairedHead)
  const wait = createCheckWait(claim.snapshot, checkpoint!)
  assert.equal(shouldKeepWaiting({ ...readCurrent()!, waitForChecks: wait }, 'pending'), true)

  inbox.ingest('fresh-feedback', 'issue_comment', { repository: { full_name: 'vite-hub/vitehub' }, action: 'created', issue: { number: 42, pull_request: {} }, comment: { id: 1, body: 'Please also fix the new regression', user: { login: 'onmax' } } })
  inbox.finish(claim, { text: 'Waiting for CI', waitForChecks: wait })
  assert.equal(shouldKeepWaiting(readCurrent()!, 'pending'), false)
  assert.ok(inbox.claim(1)[0], 'new feedback remains eligible after the old pass finishes')
  assert.equal(check.acceptedHead(), undefined, 'the old owner cannot reuse its proof after losing its lease')
})


test('unavailable Git proof retries three times ten seconds apart; close still cancels during grace', async () => {
 const inbox = fixture()
 try {
  const claim = inbox.claim(1)[0]!, current = structuredClone(claim.snapshot)
  current.pr!.head.sha = 'repair'
  let now = 0, reads = 0
  const check = createClaimStopCheck(claim, () => current, async () => { reads++; throw new Error('Git timeout') }, { clock: () => now })
  assert.equal(await check(), undefined)
  now = 9999; assert.equal(await check(), undefined); assert.equal(reads, 1)
  now = 10000; assert.equal(await check(), undefined)
  now = 20000; assert.equal(await check(), undefined)
  now = 30000; assert.match((await check())!, /verification failed/); assert.equal(reads, 4)
  current.status = 'terminal'; assert.equal(await check(), 'Pull request is no longer open.')
 } finally { inbox.close() }
})

test('a slow transient Git failure can recover to an exact self-head proof', async () => {
 const inbox = fixture()
 try {
  const claim = inbox.claim(1)[0]!, current = structuredClone(claim.snapshot)
  current.pr!.head.sha = 'repair'
  let now = 0, reads = 0
  const check = createClaimStopCheck(claim, () => current, async () => { if (++reads === 1) throw new Error('timeout'); return 'repair' }, { clock: () => now })
  assert.equal(await check(), undefined)
  now = 10000; assert.equal(await check(), undefined)
  now = 20000; assert.equal(await check(), undefined); assert.equal(reads, 2)
  current.lease = 'lost'; assert.equal(await check(), 'Pull request lease lost.')
 } finally { inbox.close() }
})
