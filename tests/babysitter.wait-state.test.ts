import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PullRequestInbox } from '../server/babysitter.inbox.ts'
import { createCheckWait, shouldKeepWaiting } from '../server/babysitter.wait-state.ts'

function setup() {
  const inbox = new PullRequestInbox(':memory:', ['owner/repo'])
  inbox.seed('owner/repo', { number: 1, state: 'open', user: { login: 'onmax' }, head: { sha: 'head', ref: 'feature' }, base: { sha: 'base', ref: 'main' } })
  const s = inbox.get('owner/repo', 1)!
  s.checks = { '1': { id: 1, name: 'ci', app: { id: 1 }, head_sha: 'head', status: 'in_progress' } }
  s.waitForChecks = createCheckWait(s, 'head')
  return { inbox, s }
}

test('partial successful CI webhooks coalesce without another agent; all required checks complete wakes', t => {
  const { inbox, s } = setup(); t.after(() => inbox.close())
  s.checks['2'] = { id: 2, name: 'lint', app: { id: 1 }, head_sha: 'head', status: 'completed', conclusion: 'success' }
  assert.equal(shouldKeepWaiting(s, 'pending'), true)
  assert.equal(shouldKeepWaiting(s, 'passed'), false)
})

test('new failed CI or human feedback wakes immediately despite previous wait', t => {
  const { inbox, s } = setup(); t.after(() => inbox.close())
  s.checks['2'] = { id: 2, name: 'lint', app: { id: 1 }, head_sha: 'head', status: 'completed', conclusion: 'failure' }
  assert.equal(shouldKeepWaiting(s, 'pending'), false)
  delete s.checks['2']; s.comments['3'] = { id: 3, body: 'Please change this', user: { login: 'onmax' } }
  assert.equal(shouldKeepWaiting(s, 'pending'), false)
})

test('unchanged known CI failure stays parked instead of relaunching the model', t => {
  const { inbox, s } = setup(); t.after(() => inbox.close())
  s.checks['2'] = { id: 2, name: 'ci', app: { id: 1 }, head_sha: 'head', status: 'completed', conclusion: 'failure' }
  s.waitForChecks = createCheckWait(s, 'head')
  assert.equal(shouldKeepWaiting(s, 'failed'), true)
})

test('new head, changed base and changed intent invalidate prior wait', t => {
  const { inbox, s } = setup(); t.after(() => inbox.close())
  for (const mutate of [(x: typeof s) => x.pr!.head.sha = 'other', (x: typeof s) => x.pr!.base.sha = 'new-base', (x: typeof s) => x.pr!.body = 'new intent']) {
    const changed = structuredClone(s); mutate(changed)
    assert.equal(shouldKeepWaiting(changed, 'pending'), false)
  }
})

test('active current-head Pullfrog waits even with required CI green; optional CI does not', t => {
  const { inbox, s } = setup(); t.after(() => inbox.close())
  s.checks['2'] = { id: 2, name: 'pullfrog', app: { id: 9 }, head_sha: 'head', status: 'in_progress' }
  assert.equal(shouldKeepWaiting(s, 'passed'), true)
  s.checks['2'].status = 'completed'; s.checks['2'].conclusion = 'success'
  assert.equal(shouldKeepWaiting(s, 'passed'), false)
  s.checks['2'].head_sha = 'old'; s.checks['2'].status = 'in_progress'
  assert.equal(shouldKeepWaiting(s, 'passed'), false)
})

test('no agent-declared wait means new work cannot be silently suppressed', t => {
  const { inbox, s } = setup(); t.after(() => inbox.close())
  delete s.waitForChecks
  assert.equal(shouldKeepWaiting(s, 'pending'), false)
})

test('unknown required policy cannot strand work behind optional pending CI', t => {
  const { inbox, s } = setup(); t.after(() => inbox.close())
  assert.equal(shouldKeepWaiting(s, 'unknown'), false)
})

test('new merge conflict wakes repair even when head and base SHAs are unchanged', t => {
  const { inbox, s } = setup(); t.after(() => inbox.close())
  s.pr!.mergeable = false
  assert.equal(shouldKeepWaiting(s, 'pending'), false)
})

test('an erroneous model wait cannot suppress already-known unresolved review work', t => {
  const { inbox, s } = setup(); t.after(() => inbox.close())
  s.reviewComments['7'] = { id: 7, body: 'Repair this', user: { login: 'reviewer' } }
  s.threads = [{ id: 'thread', isResolved: false, comments: [{ id: 7 }] }]
  s.waitForChecks = createCheckWait(s, 'head')
  assert.equal(shouldKeepWaiting(s, 'pending'), false)
  s.threads[0]!.isResolved = true
  s.waitForChecks = createCheckWait(s, 'head')
  assert.equal(shouldKeepWaiting(s, 'pending'), true)
})
