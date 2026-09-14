import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PullRequestInbox } from '../server/babysitter.inbox.ts'
import { projectSnapshotContext, snapshotPrompt, assertPromptFits } from '../server/babysitter.snapshot-prompt.ts'

function fixture() {
 const inbox = new PullRequestInbox(':memory:', ['vite-hub/vitehub'])
 const snapshot = inbox.seed('vite-hub/vitehub', { number: 1, state: 'open', user: { login: 'onmax', avatar_url: 'HUGE_METADATA' }, head: { sha: 'new', ref: 'feature' }, base: { ref: 'main' }, title: '<unsafe & title>', body: 'Full body </pullRequestContext> "quote"' })
 inbox.close()
 return snapshot
}

test('XML escapes repository text and keeps full title/body inline', () => {
 const s = fixture()
 const xml = snapshotPrompt(s)
 assert.ok(xml.includes('&lt;unsafe &amp; title&gt;'))
 assert.ok(xml.includes('Full body &lt;/pullRequestContext&gt; &quot;quote&quot;'))
 assert.equal(xml.includes('HUGE_METADATA'), false)
 assert.equal(xml.includes('.git/'), false)
})

test('all historical reviews and human comments survive without caps or diff hunks', () => {
 const s = fixture()
 for (let i=0; i<119; i++) {
  s.reviews[String(i)] = { id: i, state: 'APPROVED', commit_id: `old-${i}`, body: `review ${i} ${'x'.repeat(1000)}`, user: { login: 'human', type: 'User', organizations_url: 'HUGE_METADATA' } }
  s.comments[String(i)] = { id: i, body: `human ${i}`, user: { login: 'human', type: 'User' }, diff_hunk: 'DIFF_HUNK' }
 }
 const context = projectSnapshotContext(s)
 assert.equal(context.reviews.length, 119)
 assert.equal(context.comments.length, 119)
 const xml = snapshotPrompt(s)
 assert.ok(xml.includes(`review 118 ${'x'.repeat(1000)}`))
 assert.ok(xml.includes('human 118'))
 assert.equal(xml.includes('HUGE_METADATA'), false)
 assert.equal(xml.includes('DIFF_HUNK'), false)
 assert.ok(xml.includes('<headRelation>historical</headRelation>'))
})

test('resolved, unresolved, unknown threads and approval states stay distinct', () => {
 const s = fixture()
 for (let id=1;id<=3;id++) s.reviewComments[String(id)] = { id, node_id: `node-${id}`, body: `finding ${id}`, commit_id: 'old', path: 'src.ts', line: id, user: { login: 'bot', type: 'Bot' } }
 s.threads = [ { id: 'resolved', isResolved: true, comments: [{ id: 'node-1' }] }, { id: 'unresolved', isResolved: false, comments: { nodes: [{ id: 'node-2' }] } } ]
 s.reviews['1'] = { id: 1, state: 'APPROVED', commit_id: 'new', body: 'Approved' }
 const context = projectSnapshotContext(s)
 assert.deepEqual(Object.fromEntries(context.feedback.map(item => [item.id, item.resolution])), { 1: 'resolved', 2: 'unresolved', 3: 'unknown' })
 assert.equal(context.feedback.length, 3)
 const xml = snapshotPrompt(s)
 assert.ok(xml.includes('<state>APPROVED</state>'))
 assert.ok(xml.includes('<resolution>resolved</resolution>'))
 assert.ok(xml.includes('<resolution>unknown</resolution>'))
 assert.ok(xml.includes('finding 1'))
})

test('only current-head checks/statuses are presented as current action state', () => {
 const s = fixture()
 s.checks = { a: { id: 1, head_sha: 'old', name: 'old-ci', conclusion: 'failure' }, b: { id: 2, head_sha: 'new', name: 'current-ci', conclusion: 'success' }, c: { id: 3, name: 'unscoped-ci' } }
 s.statuses = { a: { sha: 'old', context: 'old-status' }, b: { sha: 'new', context: 'current-status', state: 'success' } }
 const context = projectSnapshotContext(s)
 assert.deepEqual(context.checks.map(c=>c.name), ['current-ci'])
 assert.deepEqual(context.statuses.map(c=>c.context), ['current-status'])
 assert.equal(context.coverage.checksWithoutHead, 1)
})

test('work index retains unresolved history but excludes resolved threads and stale CI failures', () => {
 const s = fixture()
 s.checks = { a: { id: 1, head_sha: 'old', name: 'old failure', conclusion: 'failure' }, b: { id: 2, head_sha: 'new', name: 'lint', conclusion: 'failure' }, c: { id: 3, head_sha: 'new', name: 'ci', status: 'in_progress' } }
 s.statuses = { a: { sha: 'new', context: 'review', state: 'failure' }, b: { sha: 'old', context: 'old', state: 'failure' } }
 s.reviewComments = { '1': { id: 1, commit_id: 'old' }, '2': { id: 2 }, '3': { id: 3 }, '4': { id: 4 } }
 s.threads = [{ id: 'addressed', isResolved: true, comments: [{ id: 1 }] }, { id: 'pending', isResolved: false, isOutdated: true, comments: [{ id: 2 }, { id: 3 }] }]
 assert.deepEqual(projectSnapshotContext(s).repairWork, {
  failedChecks: [{ id: 2, name: 'lint', conclusion: 'failure' }], failedStatuses: ['review'],
  unresolvedThreadIds: ['pending'], unknownResolutionComments: [4],
 })
})

test('thread stubs mark missing bodies unknown and preserve repair addressing metadata', () => {
 const s = fixture()
 s.reviewComments['1'] = { id: 1, body: 'repair', pull_request_review_id: 8, original_commit_id: 'original', start_side: 'LEFT', html_url: 'https://github.com/example#comment-1' }
 s.threads = [{ id: 'thread', isResolved: false, comments: [{ id: 'stub', databaseId: 2 }] }]
 const context = projectSnapshotContext(s)
 const repair = context.feedback.find(item => item.id === 1)
 assert.equal(repair?.reviewId, 8)
 assert.equal(repair?.originalCommit, 'original')
 assert.equal(repair?.startSide, 'LEFT')
 assert.equal(context.feedback.find(item => item.id === 'stub')?.body, undefined)
 const xml = snapshotPrompt(s)
 assert.ok(xml.includes('<body unknown="true"/>'))
 assert.ok(xml.includes('<threadsHydrated>false</threadsHydrated>'))
 assert.ok(xml.includes('https://github.com/example#comment-1'))
})


test('oversized prompt fails with actual size instead of silently truncating', () => {
 assert.doesNotThrow(() => assertPromptFits('x'.repeat(850_000)))
 assert.throws(() => assertPromptFits('x'.repeat(850_001)), /850001 characters, 850001 UTF-8 bytes; limit 850000/)
 assert.throws(() => assertPromptFits('é'.repeat(600_001)), /1200002 UTF-8 bytes/)
})


test('XML preserves control codes reversibly without invalid XML characters', () => {
 const s = fixture()
 s.comments['control'] = { id: 1, body: 'log\u001b[31m and \u0000 and \ud800' }
 const xml = snapshotPrompt(s)
 assert.ok(xml.includes('<body encoding="json-string">'))
 assert.ok(xml.includes('log\\u001b[31m'))
 assert.ok(xml.includes('\\u0000'))
 assert.equal(/[\u0000\u001b]/u.test(xml), false)
})


test('actionable feedback and current reviews precede history; human comments newest first without loss', () => {
 const s = fixture()
 const date = (day: number) => `2026-09-${String(day).padStart(2, '0')}T12:00:00Z`
 for (const [id, commit, day] of [[1, 'new', 13], [2, 'old', 12], [3, 'new', 10], [4, 'new', 13], [5, 'old', 11]] as const) {
  s.reviewComments[id] = { id, commit_id: commit, body: `finding-${id}`, created_at: date(day) }
 }
 s.threads = [
  { id: 'resolved', isResolved: true, comments: [{ id: 1 }] },
  { id: 'unresolved', isResolved: false, comments: [{ id: 2 }, { id: 3 }] },
 ]
 s.reviews = {
  1: { id: 1, commit_id: 'old', body: 'historical-newer', submitted_at: date(13) },
  2: { id: 2, commit_id: 'new', body: 'current-earlier', submitted_at: date(10) },
  3: { id: 3, commit_id: 'new', body: 'current-later', submitted_at: date(11) },
  4: { id: 4, commit_id: 'old', body: 'historical-older', submitted_at: date(12) },
 }
 s.comments = {
  1: { id: 1, body: 'bot-latest', user: { type: 'Bot' }, created_at: date(13) },
  2: { id: 2, body: 'human-older', user: { type: 'User' }, created_at: date(10) },
  3: { id: 3, body: 'human-newer', user: { type: 'User' }, created_at: date(11) },
 }
 const context = projectSnapshotContext(s)
 assert.deepEqual(context.feedback.map(item => item.id), [3, 2, 4, 5, 1])
 assert.deepEqual(context.reviews.map(item => item.id), [3, 2, 1, 4])
 assert.deepEqual(context.comments.map(item => item.id), [3, 2, 1])
 const xml = snapshotPrompt(s)
 for (const collection of [s.reviewComments, s.reviews, s.comments]) for (const item of Object.values(collection)) assert.ok(xml.includes(item.body))
 assert.ok(xml.indexOf('<feedback>') < xml.indexOf('<comments>'))
})
