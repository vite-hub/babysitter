import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PullRequestInbox } from '../server/babysitter.inbox.ts'
import { createCheckWait, shouldKeepWaiting, waitBlockers } from '../server/babysitter.wait-state.ts'

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

test('worker replies, empty reviews and resolution of addressed feedback do not spend another pending-CI pass', t => {
  const { inbox, s } = setup(); t.after(() => inbox.close())
  s.reviewComments['finding'] = { id: 4138275242, node_id: 'PRRC_kwDOSAbg_s72qRGq', body: 'Export createNoExternalAddition from the lifecycle mock.', user: { login: 'chatgpt-codex-connector[bot]' } }
  s.threads = [{ id: 'PRRT_kwDOSAbg_s6nSnJl', isResolved: false, isOutdated: false,
    comments: [{ id: 'PRRC_kwDOSAbg_s72qRGq', databaseId: 4138275242 }] }]
  s.waitForChecks = createCheckWait(s, 'head')
  assert.equal(shouldKeepWaiting(s, 'pending'), false)

  // Retained #1496 reply/review shapes. This tests the observed mechanism,
  // without claiming to reconstruct its unavailable original raw snapshot.
  const reply = { id: 4146735014, node_id: 'PRRC_kwDOSAbg_s73Kiem', in_reply_to_id: 4138275242,
    user: { login: 'vitehub-bot[bot]', type: 'Bot' },
    body: 'Fixed in b5c85d54: the Workflow lifecycle mock now exports createNoExternalAddition. The focused lifecycle suite passes (10 tests).' }
  s.reviewComments[String(reply.id)] = reply
  s.reviews['5368885433'] = { id: 5368885433, state: 'commented', body: '', user: { login: 'vitehub-bot[bot]', type: 'Bot' } }
  s.threads = [{ ...s.threads[0], node_id: 'PRRT_kwDOSAbg_s6nSnJl', isResolved: true,
    resolutionSource: 'webhook', resolutionObservedAt: '2026-09-30T16:09:08Z',
    comments: [{ id: 'PRRC_kwDOSAbg_s72qRGq', databaseId: 4138275242 }, reply] }]
  assert.equal(shouldKeepWaiting(s, 'pending'), true)

  for (const mutate of [
    (x: typeof s) => x.reviewComments['new'] = { id: 71, body: 'New finding', user: { login: 'chatgpt-codex-connector[bot]' } },
    (x: typeof s) => x.reviews['new'] = { id: 72, body: 'New review', user: { login: 'reviewer' } },
    (x: typeof s) => x.threads.push({ id: 'new-thread', isResolved: false, comments: [] }),
    (x: typeof s) => x.threads[0]!.isResolved = false,
    (x: typeof s) => delete x.threads[0]!.isResolved,
    (x: typeof s) => x.pr!.base.sha = 'new-base',
    (x: typeof s) => x.pr!.title = 'Changed intent',
    (x: typeof s) => x.pr!.body = 'Changed instructions',
  ]) {
    const changed = structuredClone(s); mutate(changed)
    assert.equal(shouldKeepWaiting(changed, 'pending'), false)
  }
})

test('an unchanged e81 checkpoint survives the new context representation without absorbing fresh evidence', t => {
  const { inbox, s } = setup(); t.after(() => inbox.close())
  Object.assign(s.pr!, { title: 'Feature', body: 'Intent', draft: false })
  s.reviewComments = { '7': { id: 7, body: 'Finding', user: { login: 'reviewer' } } }
  s.threads = [{ id: 'original', isResolved: true, comments: [{ id: 7 }] }]
  // Computed by the unmodified e81 helper for the fixture above.
  s.waitForChecks = { headSha: 'head', contextKey: '9bcfd78b758770e26c5638476e195f01feec8875e01bd0ba2cf326483f7fec34', knownFailures: [] }
  assert.equal(shouldKeepWaiting(s, 'pending'), true)
  s.reviewComments['7']!.body = 'Changed finding'
  assert.equal(shouldKeepWaiting(s, 'pending'), false)
})

test('a Pullfrog review shell and its no-findings verdict do not spend another pending-CI pass', t => {
  const { inbox, s } = setup(); t.after(() => inbox.close())
  // Observed on #1502 and #1566: submitted with an empty body, then edited to the verdict.
  s.reviews['5385868468'] = { id: 5385868468, state: 'commented', body: '', user: { login: 'pullfrog[bot]', type: 'Bot' } }
  assert.equal(shouldKeepWaiting(s, 'pending'), true)
  s.reviews['5385868468'] = { ...s.reviews['5385868468'], body: '> ✅ No new issues found.\n\n**Reviewed changes**\n\nThe incremental review covers one commit.' }
  assert.equal(shouldKeepWaiting(s, 'pending'), true)

  for (const review of [
    { id: 9, state: 'commented', body: '> [!IMPORTANT]\n> This PR has three lifecycle edge cases.', user: { login: 'pullfrog[bot]' } },
    { id: 10, state: 'CHANGES_REQUESTED', body: '', user: { login: 'onmax' } },
    { id: 11, state: 'commented', body: 'Please split this module.', user: { login: 'reviewer' } },
  ]) {
    const changed = structuredClone(s); changed.reviews[String(review.id)] = review
    assert.deepEqual(waitBlockers(changed, 'pending'), ['context-changed:reviews'])
  }
})

test('a wait recorded before review verdicts were skipped still holds until the context changes', t => {
  const { inbox, s } = setup(); t.after(() => inbox.close())
  s.reviews['1'] = { id: 1, state: 'commented', body: '> ✅ No new issues found.', user: { login: 'pullfrog[bot]' } }
  const { contextParts: _, ...previous } = createCheckWait(s, 'head')
  // The previous release hashed every external review.
  s.waitForChecks = { ...previous, contextKey: '' }
  assert.deepEqual(waitBlockers(s, 'pending'), ['context-changed'])
})

test('wake reasons name every blocker that forces a model pass', t => {
  const { inbox, s } = setup(); t.after(() => inbox.close())
  assert.deepEqual(waitBlockers(s, 'pending'), [])
  s.reviewComments['7'] = { id: 7, body: 'Repair this', user: { login: 'reviewer' } }
  s.threads = [{ id: 'thread', isResolved: false, comments: [{ id: 7 }] }]
  assert.deepEqual(waitBlockers(s, 'pending'), ['context-changed:reviewComments,threads', 'unresolved-threads', 'open-feedback'])
  s.waitForChecks = createCheckWait(s, 'head')
  assert.deepEqual(waitBlockers(s, 'pending'), ['unresolved-threads', 'open-feedback'])
  assert.deepEqual(waitBlockers({ ...s, waitForChecks: undefined }, 'pending'), ['no-wait'])
  assert.deepEqual(waitBlockers({ ...s, pr: { ...s.pr, head: { sha: 'other' } } }, 'pending'), ['head-changed'])
  s.threads[0]!.isResolved = true
  assert.deepEqual(waitBlockers(s, 'passed'), ['checks-passed'])
})

test('a reviewer acknowledging and resolving its own finding does not wake the agent', t => {
  const { inbox, s } = setup(); t.after(() => inbox.close())
  const finding = { id: 10, body: 'This leaks the handle.', user: { login: 'pullfrog[bot]' } }
  s.reviewComments['10'] = finding
  s.threads = [{ node_id: 'T1', isResolved: true, comments: { nodes: [{ databaseId: 10, body: finding.body, author: { login: 'pullfrog[bot]' } }] } }]
  s.waitForChecks = createCheckWait(s, 'head')
  const ack = { id: 11, body: 'Addressed in `c2cacbb` by closing the handle in finally.\n\n<!-- PULLFROG_DIVIDER_DO_NOT_REMOVE_PLZ -->\n<sup>Pullfrog</sup>', user: { login: 'pullfrog[bot]' } }
  s.reviewComments['11'] = ack
  s.threads[0]!.comments.nodes.push({ databaseId: 11, body: ack.body, author: { login: 'pullfrog[bot]' } })
  assert.deepEqual(waitBlockers(s, 'pending'), [])
  const followUp = { id: 12, body: 'The retry path still leaks the handle.\n\n<!-- PULLFROG_DIVIDER_DO_NOT_REMOVE_PLZ -->', user: { login: 'pullfrog[bot]' } }
  s.reviewComments['12'] = followUp
  s.threads.push({ node_id: 'T2', isResolved: false, comments: { nodes: [{ databaseId: 12, body: followUp.body, author: { login: 'pullfrog[bot]' } }] } })
  assert.ok(waitBlockers(s, 'pending').includes('unresolved-threads'))
  assert.ok(waitBlockers(s, 'pending').some(reason => reason.startsWith('context-changed')))
})

test('a deleted comment does not wake the agent, while a new human comment still does', t => {
  const { inbox, s } = setup(); t.after(() => inbox.close())
  s.comments['20'] = { id: 20, body: '<!-- vitehub-agent-activity -->', user: { login: 'vitehub-bot[bot]' } }
  s.waitForChecks = createCheckWait(s, 'head')
  s.comments['20'] = { id: 20, deleted: true, updated_at: '2026-10-03T10:08:24Z' }
  assert.deepEqual(waitBlockers(s, 'pending'), [])
  s.comments['21'] = { id: 21, body: 'Please also cover the retry path.', user: { login: 'onmax' } }
  assert.ok(waitBlockers(s, 'pending').some(reason => reason.startsWith('context-changed')))
})
