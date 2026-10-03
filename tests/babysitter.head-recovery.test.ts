import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PullRequestInbox } from '../server/babysitter.inbox.ts'
import { isPullRequestHeadMismatch, recoverPullRequestHead } from '../server/babysitter.head-recovery.ts'

const repository = 'vite-hub/vitehub'
const pr = { number: 7, state: 'open', user: { login: 'onmax' }, head: { sha: 'old', ref: 'fix' }, base: { ref: 'main' }, updated_at: '2026-09-30T10:00:00Z' }

test('checkout SHA verification failures trigger head recovery', () => {
  assert.equal(isPullRequestHeadMismatch(new Error('AGENT_R0763: Pull request head SHA verification failed.')), true)
  assert.equal(isPullRequestHeadMismatch(new Error('AGENT_R0767: Pull request head changed from old to new.')), true)
  assert.equal(isPullRequestHeadMismatch(new Error('GitHub rate limit exceeded')), false)
})

test('head recovery survives concurrent generation changes and cancels the obsolete claim', async t => {
  let now = 1000
  const inbox = new PullRequestInbox(':memory:', [repository], () => now)
  t.after(() => inbox.close())
  inbox.seed(repository, pr)
  const claim = inbox.claim(1)[0]!
  inbox.ingest('feedback', 'issue_comment', { repository: { full_name: repository }, issue: { number: 7, pull_request: {} },
    action: 'created', comment: { id: 1, user: { login: 'onmax' }, body: 'Please fix this.' } })
  assert.equal(inbox.hydrate(claim, { refresh: true }), false)
  const reads: string[] = []
  const result = await recoverPullRequestHead(inbox, claim, async path => {
    reads.push(path)
    return [{ ...pr, head: { sha: 'new', ref: 'fix' }, updated_at: '2026-09-30T11:00:00Z' }]
  })
  assert.deepEqual(result, { refreshed: true })
  assert.deepEqual(reads, [`repos/${repository}/pulls/7`])
  inbox.finish(claim, { text: 'Head changed.', retry: true, cancelled: true })
  assert.equal(inbox.get(repository, 7)?.pr?.head.sha, 'new')
  assert.equal(inbox.get(repository, 7)?.lease, null)
  assert.equal(inbox.claim(1).length, 0)
  now += 60_000
  assert.equal(inbox.claim(1)[0]?.snapshot.pr?.head.sha, 'new')
})

test('failed recovery leaves a durable refresh for the next claim', async t => {
  const inbox = new PullRequestInbox(':memory:', [repository])
  t.after(() => inbox.close())
  inbox.seed(repository, pr)
  const claim = inbox.claim(1)[0]!
  inbox.hydrate(claim, { hydrated: true, refresh: false, feedbackRefresh: false })
  const result = await recoverPullRequestHead(inbox, claim, async () => { throw new Error('Network unavailable') })
  assert.deepEqual(result, { refreshed: false, error: 'Network unavailable' })
  assert.equal(inbox.get(repository, 7)?.refresh, true)
  assert.equal(inbox.get(repository, 7)?.feedbackRefresh, true)
})

test('a closed PR found during recovery becomes terminal without another provider pass', async t => {
  const inbox = new PullRequestInbox(':memory:', [repository])
  t.after(() => inbox.close())
  inbox.seed(repository, pr)
  const claim = inbox.claim(1)[0]!
  await recoverPullRequestHead(inbox, claim, async () => [{ ...pr, state: 'closed', updated_at: '2026-09-30T11:00:00Z' }])
  inbox.finish(claim, { text: 'PR closed.', terminal: true })
  assert.equal(inbox.get(repository, 7)?.status, 'terminal')
  assert.equal(inbox.claim(1).length, 0)
})

const branchPr = { ...pr, head: { sha: 'a'.repeat(40), ref: 'feat/env-cli', repo: { full_name: repository } } }
const branchRef = (sha: string) => ({ ref: 'refs/heads/feat/env-cli', object: { type: 'commit', sha } })

test('authoritative PR and source ref disagreement becomes a durable wait that wakes on synchronize', async t => {
  const inbox = new PullRequestInbox(':memory:', [repository])
  t.after(() => inbox.close())
  inbox.seed(repository, branchPr)
  const claim = inbox.claim(1)[0]!
  const sourceHead = 'b'.repeat(40)
  const paths: string[] = []
  const recovery = await recoverPullRequestHead(inbox, claim, async path => {
    paths.push(path)
    return path.endsWith('/pulls/7') ? [branchPr] : [branchRef(sourceHead)]
  })
  assert.deepEqual(paths, [`repos/${repository}/pulls/7`, `repos/${repository}/git/ref/heads/feat%2Fenv-cli`])
  assert.equal(recovery.synchronizationWait?.prHead, branchPr.head.sha)
  assert.equal(recovery.synchronizationWait?.branchHead, sourceHead)
  assert.match(recovery.synchronizationWait!.text, /Resume when a synchronize webhook or recovery observes the PR head change/)
  inbox.finish(claim, { text: recovery.synchronizationWait!.text })
  assert.equal(inbox.get(repository, 7)?.status, 'waiting')
  assert.equal(inbox.get(repository, 7)?.generation, inbox.get(repository, 7)?.handled)
  assert.equal(inbox.claim(1).length, 0)
  inbox.ingest('synchronized', 'pull_request', { repository: { full_name: repository }, action: 'synchronize',
    pull_request: { ...branchPr, head: { ...branchPr.head, sha: sourceHead }, updated_at: '2026-09-30T11:00:00Z' } })
  assert.equal(inbox.claim(1)[0]?.snapshot.pr?.head.sha, sourceHead)
})

test('matching source head and transient or incomplete ref reads do not park checkout failures', async t => {
  for (const source of [branchRef(branchPr.head.sha), { ...branchRef('b'.repeat(40)), ref: 'refs/heads/unrelated' },
    { ...branchRef('b'.repeat(40)), object: { type: 'tag', sha: 'b'.repeat(40) } }, branchRef('b'.repeat(45)), branchRef('invalid'), undefined]) {
    const inbox = new PullRequestInbox(':memory:', [repository])
    t.after(() => inbox.close())
    inbox.seed(repository, branchPr)
    const claim = inbox.claim(1)[0]!
    const recovery = await recoverPullRequestHead(inbox, claim, async path => path.endsWith('/pulls/7') ? [branchPr] : source ? [source] : [])
    assert.equal(recovery.synchronizationWait, undefined)
  }
  const inbox = new PullRequestInbox(':memory:', [repository])
  t.after(() => inbox.close())
  inbox.seed(repository, branchPr)
  const recovery = await recoverPullRequestHead(inbox, inbox.claim(1)[0]!, async path => {
    if (path.endsWith('/pulls/7')) return [branchPr]
    throw new Error('Temporary GitHub ref read failure')
  })
  assert.equal(recovery.synchronizationWait, undefined)
  assert.equal(recovery.error, 'Temporary GitHub ref read failure')
})

test('fresh head or feedback during source-ref verification stays ready for its next claim', async t => {
  for (const change of ['head', 'feedback']) {
    const inbox = new PullRequestInbox(':memory:', [repository])
    t.after(() => inbox.close())
    inbox.seed(repository, branchPr)
    const claim = inbox.claim(1)[0]!
    const recovery = await recoverPullRequestHead(inbox, claim, async path => {
      if (path.endsWith('/pulls/7')) return [branchPr]
      if (change === 'head') inbox.ingest('new-head', 'pull_request', { repository: { full_name: repository }, action: 'synchronize',
        pull_request: { ...branchPr, head: { ...branchPr.head, sha: 'c'.repeat(40) }, updated_at: '2026-09-30T11:00:00Z' } })
      else inbox.ingest('new-feedback', 'issue_comment', { repository: { full_name: repository }, action: 'created',
        issue: { number: 7, pull_request: {} }, comment: { id: 2, user: { login: 'onmax' }, body: 'New finding' } })
      return [branchRef('b'.repeat(40))]
    })
    assert.equal(recovery.synchronizationWait, undefined)
    inbox.finish(claim, { text: 'Recheck latest evidence.' })
    assert.equal(inbox.get(repository, 7)?.status, 'ready')
    assert.ok(inbox.claim(1)[0])
  }
})

test('a verified wait cannot swallow feedback that arrives immediately before finishing', async t => {
  const inbox = new PullRequestInbox(':memory:', [repository])
  t.after(() => inbox.close())
  inbox.seed(repository, branchPr)
  const claim = inbox.claim(1)[0]!
  const recovery = await recoverPullRequestHead(inbox, claim, async path => path.endsWith('/pulls/7') ? [branchPr] : [branchRef('b'.repeat(40))])
  assert.ok(recovery.synchronizationWait)
  inbox.ingest('late-feedback', 'issue_comment', { repository: { full_name: repository }, action: 'created',
    issue: { number: 7, pull_request: {} }, comment: { id: 3, user: { login: 'onmax' }, body: 'Another finding' } })
  inbox.finish(claim, { text: recovery.synchronizationWait!.text })
  assert.equal(inbox.get(repository, 7)?.status, 'ready')
  assert.equal(inbox.get(repository, 7)?.comments['3']?.body, 'Another finding')
  assert.ok(inbox.claim(1)[0])
})
