import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PullRequestInbox } from '../server/babysitter.inbox.ts'
const repository = 'vite-hub/vitehub'
const repo = { full_name: repository }
const pr = (patch = {}) => ({ number: 7, state: 'open', user: { login: 'onmax' }, head: { sha: 'a', ref: 'fix' }, base: { sha: 'base', ref: 'main' }, updated_at: '2026-09-13T10:00:00Z', ...patch })
const comment = (id = 1, body = 'Please repair this') => ({ id, body, user: { login: 'human', type: 'User' } })
function memory(t: { after: (fn: () => void) => void }) { const inbox = new PullRequestInbox(':memory:', [repository]); t.after(() => inbox.close()); return inbox }
function post(inbox: PullRequestInbox, id: string, event: string, payload: object) { return inbox.ingest(id, event, { repository: repo, ...payload }) }

test('GraphQL bootstrap normalizes state, author and head into a claimable snapshot', t => {
  const inbox = memory(t)
  inbox.seed(repository, { number: 7, state: 'OPEN', author: { login: 'onmax' }, headRefOid: 'a', headRefName: 'fix', baseRefName: 'main', updatedAt: '2026-09-13T10:00:00Z' })
  const [claim] = inbox.claim(1)
  assert.equal(claim?.snapshot.pr?.head.sha, 'a')
  assert.equal(claim?.snapshot.pr?.state, 'open')
})
test('delivery dedupe and three comments coalesce into one claim', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  for (let n = 1; n <= 3; n++) post(inbox, String(n), 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment(n) })
  const before = inbox.get(repository, 7)!
  const duplicate = post(inbox, '1', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment(1) })
  assert.equal('duplicate' in duplicate && duplicate.duplicate, true)
  assert.equal(inbox.get(repository, 7)!.generation, before.generation)
  assert.equal(Object.keys(before.comments).length, 3)
  assert.equal(inbox.claim(6).length, 1); assert.equal(inbox.claim(6).length, 0)
})
test('unknown PR comments survive until its PR metadata arrives', t => {
  const inbox = memory(t)
  post(inbox, 'comment', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment() })
  const [claim] = inbox.claim(1); assert.ok(claim); assert.equal(claim.snapshot.pr, null)
  assert.ok(inbox.hydrate(claim, { pr: pr(), refresh: false }))
  assert.equal(inbox.get(repository, 7)?.comments['1']?.body, 'Please repair this')
})
test('status and check events match local head even without pull_requests', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  assert.deepEqual(post(inbox, 'status', 'status', { sha: 'a', context: 'CI', state: 'failure' }).queued, [7])
  assert.deepEqual(post(inbox, 'check', 'check_run', { action: 'completed', check_run: { id: 1, head_sha: 'a', conclusion: 'success' } }).queued, [7])
  assert.equal(inbox.get(repository, 7)?.statuses.CI?.state, 'failure')
})
test('synchronize clears old-head checks and stale CI cannot dirty current head', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  post(inbox, 'check', 'check_run', { check_run: { id: 1, head_sha: 'a', conclusion: 'failure' } })
  post(inbox, 'sync', 'pull_request', { action: 'synchronize', pull_request: pr({ head: { sha: 'b', ref: 'fix' }, updated_at: '2026-09-13T11:00:00Z' }) })
  assert.equal(inbox.get(repository, 7)?.pr?.head.sha, 'b'); assert.deepEqual(inbox.get(repository, 7)?.checks, {})
  const generation = inbox.get(repository, 7)!.generation
  assert.deepEqual(post(inbox, 'late', 'check_run', { check_run: { id: 1, head_sha: 'a', pull_requests: [{ number: 7 }] } }).queued, [])
  assert.equal(inbox.get(repository, 7)!.generation, generation)
})
test('new event during claim is preserved when old pass finishes', t => {
  const inbox = memory(t); inbox.seed(repository, pr()); const [claim] = inbox.claim(1); assert.ok(claim)
  post(inbox, 'new', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment() })
  assert.equal(inbox.hydrate(claim, { comments: {} }), false)
  inbox.finish(claim, { text: 'done' }); assert.equal(inbox.claim(1).length, 1)
})
test('close then reopen during active claim is not lost by stale terminal result', t => {
  const inbox = memory(t); inbox.seed(repository, pr()); const [claim] = inbox.claim(1); assert.ok(claim)
  post(inbox, 'close', 'pull_request', { action: 'closed', pull_request: pr({ state: 'closed', updated_at: '2026-09-13T11:00:00Z' }) })
  post(inbox, 'reopen', 'pull_request', { action: 'reopened', pull_request: pr({ updated_at: '2026-09-13T12:00:00Z' }) })
  inbox.finish(claim, { text: 'stale close', terminal: true }); assert.equal(inbox.claim(1).length, 1)
})
test('comment deletion updates projection even if GitHub sends identical body', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  post(inbox, 'add', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment() })
  post(inbox, 'del', 'issue_comment', { action: 'deleted', issue: { number: 7, pull_request: {} }, comment: comment() })
  assert.equal(inbox.get(repository, 7)?.comments['1']?.deleted, true)
})
test('stale bootstrap cannot reopen terminal PR', t => {
  const inbox = memory(t); inbox.seed(repository, pr({ state: 'closed', updated_at: '2026-09-13T12:00:00Z' }))
  inbox.seed(repository, pr()); assert.equal(inbox.claim(1).length, 0)
})
test('own bot and issue comments do not wake PR agents; AI review does', t => {
  const inbox = memory(t); inbox.seed(repository, pr()); const [claim] = inbox.claim(1); assert.ok(claim); inbox.finish(claim, { text: 'wait' })
  post(inbox, 'own', 'issue_comment', { issue: { number: 7, pull_request: {} }, comment: { ...comment(), user: { login: 'vitehub-bot[bot]', type: 'Bot' } } })
  post(inbox, 'issue', 'issue_comment', { issue: { number: 7 }, comment: comment() })
  assert.equal(inbox.claim(1).length, 0)
  post(inbox, 'ai', 'pull_request_review', { pull_request: pr(), review: { ...comment(), user: { login: 'pullfrog[bot]', type: 'Bot' } } })
  assert.equal(inbox.claim(1).length, 1)
})
test('released claim is immediately reusable without handling the generation', t => {
  const inbox = memory(t); inbox.seed(repository, pr()); const [claim] = inbox.claim(1); assert.ok(claim)
  assert.ok(inbox.release(claim)); const [next] = inbox.claim(1); assert.ok(next)
  assert.equal(next.generation, claim.generation); assert.notEqual(next.token, claim.token)
})
test('snapshot and delivery dedupe persist over restart; abandoned lease recovers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-test-')); const path = join(dir, 'state.sqlite')
  try {
    const first = new PullRequestInbox(path, [repository]); post(first, 'open', 'pull_request', { action: 'opened', pull_request: pr() }); assert.equal(first.claim(1).length, 1); first.close()
    const second = new PullRequestInbox(path, [repository]); second.recoverLeases()
    assert.equal(second.claim(1).length, 1); const result = post(second, 'open', 'pull_request', { action: 'opened', pull_request: pr() }); assert.equal('duplicate' in result && result.duplicate, true); second.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('thread resolution webhook persists explicit state and links feedback comments', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  const result = post(inbox, 'resolved', 'pull_request_review_thread', { action: 'resolved', pull_request: pr(), thread: { node_id: 'PRRT_1', comments: [comment()] } })
  assert.deepEqual(result.queued, [7])
  assert.equal(inbox.get(repository, 7)?.threads[0]?.id, 'PRRT_1')
  assert.equal(inbox.get(repository, 7)?.threads[0]?.isResolved, true)
  assert.equal(inbox.get(repository, 7)?.threads[0]?.resolutionSource, 'webhook')
  assert.equal(inbox.get(repository, 7)?.reviewComments['1']?.body, 'Please repair this')
  post(inbox, 'unresolved', 'pull_request_review_thread', { action: 'unresolved', pull_request: pr(), thread: { node_id: 'PRRT_1', comments: [comment()] } })
  assert.equal(inbox.get(repository, 7)?.threads.length, 1)
  assert.equal(inbox.get(repository, 7)?.threads[0]?.isResolved, false)
})
test('unknown historical comments remain unknown when another thread is resolved', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  post(inbox, 'unknown-comment', 'pull_request_review_comment', { action: 'created', pull_request: pr(), comment: comment(2) })
  post(inbox, 'resolved', 'pull_request_review_thread', { action: 'resolved', pull_request: pr(), thread: { node_id: 'PRRT_1', comments: [comment(1)] } })
  const snapshot = inbox.get(repository, 7)!
  assert.equal(snapshot.reviewComments['2']?.id, 2)
  assert.equal(snapshot.reviewComments['2']?.isResolved, undefined)
  assert.equal(snapshot.threads.some(thread => thread.comments.some((item: { id: number }) => item.id === 2)), false)
})
test('equivalent thread delivery does not wake waiting agent again', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  const payload = { action: 'resolved', pull_request: pr(), thread: { node_id: 'PRRT_1', comments: [comment()] } }
  post(inbox, 'resolved-1', 'pull_request_review_thread', payload)
  const [claim] = inbox.claim(1); assert.ok(claim); inbox.finish(claim, { text: 'wait' })
  const generation = inbox.get(repository, 7)!.generation
  assert.deepEqual(post(inbox, 'resolved-2', 'pull_request_review_thread', payload).queued, [])
  assert.equal(inbox.get(repository, 7)!.generation, generation); assert.equal(inbox.claim(1).length, 0)
})
test('thread webhook merges GraphQL baseline comments and rejects stale comment body', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  const [claim] = inbox.claim(1); assert.ok(claim)
  inbox.hydrate(claim, { threads: [{ id: 'PRRT_1', isResolved: false, comments: { nodes: [{ id: 'PRRC_1', body: 'new', updatedAt: '2026-09-13T12:00:00Z' }] } }] })
  post(inbox, 'resolved', 'pull_request_review_thread', { action: 'resolved', pull_request: pr(), thread: { node_id: 'PRRT_1', comments: [{ ...comment(), node_id: 'PRRC_1', body: 'old', updated_at: '2026-09-13T11:00:00Z' }] } })
  const thread = inbox.get(repository, 7)!.threads[0]!
  assert.equal(thread.isResolved, true); assert.equal(thread.comments.length, 1); assert.equal(thread.comments[0].body, 'new')
})

test('queued and running CI persist without waking, failure and final green wake', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  inbox.finish(inbox.claim(1)[0]!, { text: 'Waiting for CI' })
  const generation = inbox.get(repository, 7)!.generation
  for (const status of ['queued', 'in_progress']) {
    assert.deepEqual(post(inbox, status, 'check_run', { action: status === 'queued' ? 'created' : 'in_progress', check_run: { id: 1, head_sha: 'a', status, conclusion: null } }).queued, [])
    assert.equal(inbox.get(repository, 7)?.checks['check_run:1']?.status, status)
    assert.equal(inbox.get(repository, 7)!.generation, generation); assert.equal(inbox.claim(1).length, 0)
  }
  assert.deepEqual(post(inbox, 'failure', 'check_run', { action: 'completed', check_run: { id: 1, head_sha: 'a', status: 'completed', conclusion: 'failure' } }).queued, [7])
  inbox.finish(inbox.claim(1)[0]!, { text: 'Repair pushed' })
  assert.deepEqual(post(inbox, 'green', 'check_run', { action: 'completed', check_run: { id: 1, head_sha: 'a', status: 'completed', conclusion: 'success' } }).queued, [7])
  assert.equal(inbox.claim(1).length, 1)
})
test('pending status does not wake but invalidates in-flight stale hydration', t => {
  const inbox = memory(t); inbox.seed(repository, pr()); const claim = inbox.claim(1)[0]!
  post(inbox, 'pending-status', 'status', { sha: 'a', context: 'deploy', state: 'pending' })
  assert.equal(inbox.get(repository, 7)!.generation, claim.generation)
  assert.equal(inbox.hydrate(claim, { statuses: {} }), false)
  assert.equal(inbox.get(repository, 7)?.statuses.deploy?.state, 'pending')
  inbox.finish(claim, { text: 'wait' }); assert.equal(inbox.claim(1).length, 0)
})
test('thread reconcile preserves concurrent webhook and only wakes on changed evidence', t => {
  const inbox = memory(t); inbox.seed(repository, pr()); inbox.finish(inbox.claim(1)[0]!, { text: 'wait' })
  const thread = { id: 'PRRT_1', isResolved: true, comments: [] }
  assert.equal(inbox.refreshThreads(inbox.get(repository, 7)!, [thread]), true)
  inbox.finish(inbox.claim(1)[0]!, { text: 'read' })
  assert.equal(inbox.refreshThreads(inbox.get(repository, 7)!, [thread]), true); assert.equal(inbox.claim(1).length, 0)
  const observed = inbox.get(repository, 7)!
  post(inbox, 'unresolved-thread', 'pull_request_review_thread', { action: 'unresolved', pull_request: pr(), thread: { node_id: 'PRRT_1', comments: [] } })
  assert.equal(inbox.refreshThreads(observed, [thread]), false)
  assert.equal(inbox.get(repository, 7)?.threads[0]?.isResolved, false)
})

test('unknown reviewer bot retains full review and inline body while own issue activity stays ignored', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  const user = { login: 'new-reviewer-service[bot]', type: 'Bot' }
  post(inbox, 'unknown-review', 'pull_request_review', { action: 'submitted', pull_request: pr(), review: { id: 9, user, body: 'Full future reviewer body', state: 'CHANGES_REQUESTED' } })
  post(inbox, 'unknown-inline', 'pull_request_review_comment', { action: 'created', pull_request: pr(), comment: { id: 10, node_id: 'inline-node', user, body: 'Full future inline body' } })
  post(inbox, 'unknown-thread', 'pull_request_review_thread', { action: 'unresolved', pull_request: pr(), thread: { node_id: 'thread-node', comments: [{ id: 11, node_id: 'thread-inline-node', user, body: 'Full thread-delivered body' }] } })
  assert.equal(inbox.get(repository, 7)?.reviews['9']?.body, 'Full future reviewer body')
  assert.equal(inbox.get(repository, 7)?.reviewComments['10']?.body, 'Full future inline body')
  assert.equal(inbox.get(repository, 7)?.reviewComments['11']?.body, 'Full thread-delivered body')
  inbox.finish(inbox.claim(1)[0]!, { text: 'handled' })
  post(inbox, 'own-activity', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: { id: 12, user: { login: 'vitehub-bot[bot]', type: 'Bot' }, body: '<!-- vitehub-agent-activity: --> Working' } })
  assert.equal(inbox.claim(1).length, 0)
})

test('Codex review summary issue comments do not wake the repair agent', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  inbox.finish(inbox.claim(1)[0]!, { text: 'wait' })
  const before = inbox.get(repository, 7)!.generation
  const comment = { id: 99, user: { login: 'chatgpt-codex-connector[bot]', type: 'Bot' }, body: '<!-- codex-pull-request-review-summary -->\n## Codex Review Summary' }
  const result = post(inbox, 'codex-summary', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment })
  assert.deepEqual(result.queued, []); assert.equal(inbox.get(repository, 7)!.generation, before)
})

test('cancellation cooldown survives new webhooks and eventually claims their latest generation', t => {
  let now = 1000
  const inbox = new PullRequestInbox(':memory:', [repository], () => now); t.after(() => inbox.close()); inbox.seed(repository, pr())
  const first = inbox.claim(1)[0]!
  inbox.finish(first, { text: 'Head changed', cancelled: true, retry: true })
  assert.equal(inbox.summary()[0]?.cancellationStreak, 1)
  assert.equal(inbox.summary()[0]?.cancellationUntil, now + 60_000)
  post(inbox, 'event-in-cooldown', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment() })
  const latest = inbox.get(repository, 7)!.generation
  assert.equal(inbox.claim(1).length, 0)
  now += 59_999; assert.equal(inbox.claim(1).length, 0)
  now += 1; const second = inbox.claim(1)[0]!
  assert.equal(second.generation, latest)
  inbox.finish(second, { text: 'Head changed again', cancelled: true })
  assert.equal(inbox.summary()[0]?.cancellationStreak, 2)
  assert.equal(inbox.summary()[0]?.cancellationUntil, now + 120_000)
  now += 120_000; assert.equal(inbox.claim(1).length, 1)
})
test('cancellation cooldown affects only its PR and successful pass clears streak', t => {
  let now = 1000
  const inbox = new PullRequestInbox(':memory:', [repository], () => now); t.after(() => inbox.close()); inbox.seed(repository, pr())
  inbox.finish(inbox.claim(1)[0]!, { text: 'cancel', cancelled: true })
  inbox.seed(repository, pr({ number: 8, head: { sha: 'other', ref: 'other' } }))
  const other = inbox.claim(1)[0]!; assert.equal(other.snapshot.number, 8); inbox.finish(other, { text: 'done' })
  now += 60_000; const retry = inbox.claim(1)[0]!; assert.equal(retry.snapshot.number, 7)
  inbox.finish(retry, { text: 'repair pushed' })
  assert.equal(inbox.get(repository, 7)?.cancellationStreak, 0)
  assert.equal(inbox.get(repository, 7)?.cancellationUntil, 0)
})
test('cancellation cooldown caps at five minutes and preserves events arriving during claim', t => {
  let now = 1000
  const inbox = new PullRequestInbox(':memory:', [repository], () => now); t.after(() => inbox.close()); inbox.seed(repository, pr())
  for (let n = 0; n < 5; n++) {
    const claim = inbox.claim(1)[0]!; assert.ok(claim)
    post(inbox, `cancel-event-${n}`, 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment(n) })
    inbox.finish(claim, { text: 'cancelled', cancelled: true, retry: true })
    const delay = [60_000, 120_000, 240_000, 300_000, 300_000][n]!
    assert.equal(inbox.get(repository, 7)?.cancellationUntil, now + delay)
    assert.equal(inbox.claim(1).length, 0); now += delay
  }
  const final = inbox.claim(1)[0]!
  inbox.finish(final, { text: 'PR closed', cancelled: true, terminal: true })
  assert.equal(inbox.get(repository, 7)?.status, 'terminal')
  assert.equal(inbox.get(repository, 7)?.cancellationUntil, 0)
})

test('closing webhook clears cancellation cooldown without waiting for another owner', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  inbox.finish(inbox.claim(1)[0]!, { text: 'cancel', cancelled: true })
  post(inbox, 'closed-during-cooldown', 'pull_request', { action: 'closed', pull_request: pr({ state: 'closed', updated_at: '2026-09-13T12:00:00Z' }) })
  assert.equal(inbox.get(repository, 7)?.status, 'terminal')
  assert.equal(inbox.get(repository, 7)?.cancellationStreak, 0)
  assert.equal(inbox.get(repository, 7)?.cancellationUntil, 0)
})

test('three no-op retries stop an unchanged head', () => {
  let now = 0
  const inbox = new PullRequestInbox(':memory:', [repository], () => now); inbox.seed(repository, pr())
  for (let i = 0; i < 3; i++) {
    const claim = inbox.claim(1)[0]!; assert.ok(claim)
    inbox.finish(claim, { text: 'No independent work completed.', retry: true, noOp: true })
    now += 31 * 60_000
  }
  assert.equal(inbox.get(repository, 7)?.status, 'waiting')
  inbox.close()
})

test('fresh feedback, completed CI, or a base push resumes a head with exhausted no-op retries', () => {
  const events: [string, object][] = [
    ['issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment(99) }],
    ['check_run', { action: 'completed', check_run: { id: 99, head_sha: 'a', status: 'completed', conclusion: 'failure' } }],
    ['push', { ref: 'refs/heads/main', after: 'new-base' }],
  ]
  for (const [event, payload] of events) {
    let now = 0
    const inbox = new PullRequestInbox(':memory:', [repository], () => now)
    try {
      inbox.seed(repository, pr())
      for (let i = 0; i < 3; i++) {
        inbox.finish(inbox.claim(1)[0]!, { text: 'No work completed.', retry: true, noOp: true })
        now += 31 * 60_000
      }
      assert.equal(inbox.claim(1).length, 0, `${event}: unchanged state stays parked`)
      post(inbox, 'fresh-evidence', event, payload)
      const [claim] = inbox.claim(1)
      assert.ok(claim, `${event}: fresh evidence must resume work`)
      assert.equal(claim.snapshot.pr?.head.sha, 'a')
      inbox.finish(claim, { text: 'First retry on fresh evidence.', retry: true, noOp: true })
      now += 31 * 60_000
      assert.equal(inbox.claim(1).length, 1, `${event}: fresh evidence gets a new retry budget`)
    } finally { inbox.close() }
  }
})

test('equivalent feedback delivery leaves the exhausted no-op budget parked', () => {
  let now = 0
  const inbox = new PullRequestInbox(':memory:', [repository], () => now)
  try {
    inbox.seed(repository, pr())
    const payload = { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment() }
    post(inbox, 'original-feedback', 'issue_comment', payload)
    for (let i = 0; i < 3; i++) {
      inbox.finish(inbox.claim(1)[0]!, { text: 'No work completed.', retry: true, noOp: true })
      now += 31 * 60_000
    }
    const generation = inbox.get(repository, 7)!.generation
    post(inbox, 'replayed-feedback', 'issue_comment', {
      ...payload, comment: { ...payload.comment, updated_at: '2026-09-13T12:00:00Z' },
    })
    assert.equal(inbox.get(repository, 7)!.generation, generation)
    assert.equal(inbox.claim(1).length, 0)
  } finally { inbox.close() }
})

test('fresh evidence during the third no-op pass receives its full retry budget', () => {
  let now = 0
  const inbox = new PullRequestInbox(':memory:', [repository], () => now)
  try {
    inbox.seed(repository, pr())
    for (let i = 0; i < 2; i++) {
      inbox.finish(inbox.claim(1)[0]!, { text: 'No repair.', retry: true, noOp: true })
      now += 31 * 60_000
    }
    const third = inbox.claim(1)[0]!
    post(inbox, 'new-task', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment() })
    inbox.finish(third, { text: 'Old task had no repair.', retry: true, noOp: true })
    for (let i = 0; i < 3; i++) {
      const claim = inbox.claim(1)[0]
      assert.ok(claim, `fresh task retry ${i + 1} is available`)
      inbox.finish(claim, { text: 'Fresh task has no repair.', retry: true, noOp: true })
      now += 31 * 60_000
    }
    assert.equal(inbox.claim(1).length, 0)
  } finally { inbox.close() }
})

test('new work received during a claim queues behind older unclaimed work', () => {
  let now = 0
  const inbox = new PullRequestInbox(':memory:', [repository], () => now)
  try {
    inbox.seed(repository, pr())
    const first = inbox.claim(1)[0]!
    now = 100
    inbox.seed(repository, pr({ number: 8, head: { sha: 'b', ref: 'other' } }))
    now = 200
    post(inbox, 'new-7', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment() })
    now = 300
    post(inbox, 'more-7', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment(2) })
    inbox.finish(first, { text: 'Handled the claimed generation.' })
    assert.equal(inbox.get(repository, 7)?.dirtyAt, 200)
    assert.deepEqual(inbox.claim(2).map(claim => claim.snapshot.number), [8, 7])
  } finally { inbox.close() }
})

test('lease owner requests refresh despite newer generations and revisions', t => {
  const inbox = memory(t)
  inbox.seed(repository, pr())
  const first = inbox.claim(1)[0]!
  assert.ok(inbox.hydrate(first, { hydrated: true, refresh: false, feedbackRefresh: false }))
  post(inbox, 'concurrent-feedback', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment() })
  const before = inbox.get(repository, 7)!
  assert.equal(inbox.hydrate(first, { refresh: true }), false)
  assert.equal(inbox.requestRefresh(first), true)
  const refreshed = inbox.get(repository, 7)!
  assert.equal(refreshed.refresh, true)
  assert.equal(refreshed.feedbackRefresh, true)
  assert.equal(refreshed.revision, (before.revision ?? 0) + 1)
  assert.equal(refreshed.generation, before.generation)
  inbox.release(first)
  const second = inbox.claim(1)[0]!
  assert.ok(inbox.hydrate(second, { refresh: false, feedbackRefresh: false }))
  assert.equal(inbox.requestRefresh(first), false)
  assert.equal(inbox.get(repository, 7)?.refresh, false)
})

test('head and base matching reaches open PRs in the event repository only', t => {
  const inbox = memory(t), otherRepository = 'vite-hub/other'
  inbox.seed(repository, pr())
  inbox.seed(repository, pr({ number: 8, head: { sha: 'a', ref: 'another' } }))
  inbox.seed(repository, pr({ number: 9, state: 'closed' }))
  inbox.seed(otherRepository, pr())
  for (const claim of inbox.claim(2)) inbox.finish(claim, { text: 'Waiting for evidence.' })
  const otherGeneration = inbox.get(otherRepository, 7)!.generation
  const closedGeneration = inbox.get(repository, 9)!.generation
  assert.deepEqual(post(inbox, 'shared-head-ci', 'check_run', {
    action: 'completed', check_run: { id: 99, head_sha: 'a', status: 'completed', conclusion: 'failure' },
  }).queued.sort(), [7, 8])
  for (const claim of inbox.claim(2)) inbox.finish(claim, { text: 'Waiting for base.' })
  assert.deepEqual(post(inbox, 'shared-base-push', 'push', { ref: 'refs/heads/main' }).queued.sort(), [7, 8])
  assert.equal(inbox.get(otherRepository, 7)!.generation, otherGeneration)
  assert.equal(inbox.get(repository, 9)!.generation, closedGeneration)
  assert.equal(inbox.all().length, 3)
  assert.deepEqual(inbox.summary().map(item => item.repository), [repository, repository, repository])
})

test('stack child becomes claimable after its open parent closes', t => {
  const inbox = memory(t)
  inbox.seed(repository, pr())
  inbox.seed(repository, pr({ number: 8, head: { sha: 'b', ref: 'child' }, base: { sha: 'a', ref: 'fix' } }))
  const claims = inbox.claim(2)
  assert.deepEqual(claims.map(claim => claim.snapshot.number), [7])
  inbox.finish(claims[0]!, { text: 'Waiting on parent.' })
  assert.equal(inbox.claim(1).length, 0)
  post(inbox, 'parent-closed', 'pull_request', { action: 'closed', pull_request: pr({ state: 'closed', updated_at: '2026-09-13T12:00:00Z' }) })
  assert.equal(inbox.claim(1)[0]?.snapshot.number, 8)
})

test('summary and claim reflect mutations, keep caller changes isolated, and recover rollback', t => {
  const inbox = memory(t)
  inbox.seed(repository, pr())
  const initial = inbox.summary()[0]!
  initial.reasons.push('caller-only')
  initial.status = 'terminal'
  assert.equal(inbox.summary()[0]?.status, 'ready')
  assert.deepEqual(inbox.summary()[0]?.reasons, ['bootstrap'])
  post(inbox, 'new-head', 'pull_request', { action: 'synchronize', pull_request: pr({ head: { sha: 'b', ref: 'fix' } }) })
  assert.equal(inbox.summary()[0]?.head, 'b')
  const [claim] = inbox.claim(1)
  assert.ok(claim)
  assert.equal(inbox.summary()[0]?.status, 'working')
  assert.ok(inbox.hydrate(claim, { lastResult: 'Fresh hydration.' }))
  assert.equal(inbox.summary()[0]?.lastResult, 'Fresh hydration.')
  // A caller-side failure after writing must roll the database projection back.
  Object.freeze(claim.snapshot)
  assert.throws(() => inbox.hydrate(claim, { lastResult: 'Rolled back.' }), TypeError)
  assert.equal(inbox.summary()[0]?.lastResult, 'Fresh hydration.')
  inbox.finish(claim, { text: 'Durably waiting.' })
  assert.equal(inbox.summary()[0]?.status, 'waiting')
  assert.equal(inbox.summary()[0]?.lastResult, 'Durably waiting.')
  assert.equal(inbox.claim(1).length, 0)
})

test('startup recovers dirty legacy no-op latches without waking handled waits or clearing cooldowns', () => {
  let now = 0
  const inbox = new PullRequestInbox(':memory:', [repository], () => now)
  try {
    inbox.seed(repository, pr())
    inbox.seed(repository, pr({ number: 8, head: { sha: 'b', ref: 'other' } }))
    const [dirty, handled] = inbox.claim(2)
    assert.ok(dirty); assert.ok(handled)
    inbox.hydrate(dirty, { noOpHead: 'a', noOpAttempts: 3, nextAt: 100, cancellationUntil: 200 })
    inbox.release(dirty)
    inbox.hydrate(handled, { noOpHead: 'b', noOpAttempts: 3 })
    inbox.finish(handled, { text: 'No more independent work.' })
    assert.equal(inbox.claim(2).length, 0)
    const generation = inbox.get(repository, 7)!.generation
    inbox.recoverLeases()
    assert.equal(inbox.get(repository, 7)?.generation, generation)
    assert.equal(inbox.get(repository, 7)?.nextAt, 100)
    assert.equal(inbox.get(repository, 7)?.cancellationUntil, 200)
    assert.equal(inbox.get(repository, 8)?.status, 'waiting')
    assert.equal(inbox.get(repository, 8)?.noOpAttempts, 3)
    now = 150
    assert.equal(inbox.claim(2).length, 0)
    now = 200
    assert.deepEqual(inbox.claim(2).map(claim => claim.snapshot.number), [7])
  } finally { inbox.close() }
})

test('a PR woken on its parked repair head is claimed before older ready work', t => {
  let now = 1_000
  const inbox = new PullRequestInbox(':memory:', [repository], () => now++); t.after(() => inbox.close())
  inbox.seed(repository, pr({ number: 7 })); inbox.seed(repository, pr({ number: 8, head: { sha: 'b', ref: 'other' } }))
  for (const claim of inbox.claim(2)) inbox.finish(claim, claim.snapshot.number === 7
    ? { text: 'Pushed a repair.', waitForChecks: { headSha: 'a', contextKey: 'k', knownFailures: [] } }
    : { text: 'done' })
  post(inbox, 'c1', 'issue_comment', { action: 'created', issue: { number: 8, pull_request: {} }, comment: comment(1) })
  post(inbox, 'check', 'check_run', { action: 'completed', check_run: { id: 1, head_sha: 'a', conclusion: 'success' } })
  assert.equal(inbox.get(repository, 8)!.dirtyAt < inbox.get(repository, 7)!.dirtyAt, true)
  assert.deepEqual(inbox.claim(1).map(claim => claim.snapshot.number), [7])
})
