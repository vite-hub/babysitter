import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyPassScheduling, parsePassResult, pushedRepairWaitHead, resolveExternalWaitHead, resolveWaitHead } from '../server/babysitter.pass-result.ts'

test('observed abbreviated successful push remains completed and resolves to exact owned Git proof', () => {
  const value = parsePassResult({ disposition: 'park', text: 'Pushed repair, waiting on CI.', waitForChecksHead: '4709d95e' })!
  assert.equal(value.disposition, 'park')
  const proved = '4709d95ec60a490f38679698d8c5e08c97496a59'
  assert.equal(resolveWaitHead(value.waitForChecksHead, proved, 'a'.repeat(40)), proved)
  assert.equal(resolveWaitHead(value.waitForChecksHead, undefined, 'a'.repeat(40)), undefined)
})

test('invalid optional wait hint never rejects an otherwise valid repair result', () => {
  for (const hint of [null, 42, 'pending', {}, 'xyz']) {
    const value = parsePassResult({ disposition: 'park', text: 'Repair pushed.', waitForChecksHead: hint })!
    assert.equal(value.disposition, 'park')
    assert.equal(value.waitForChecksHead, undefined)
  }
  assert.equal(parsePassResult({ disposition: 'merge-anyway', text: 'Bad result' }), undefined)
})

test('wait hint cannot claim an unproved remote commit', () => {
  const current = 'b'.repeat(40)
  assert.equal(resolveWaitHead('a'.repeat(8), current, 'a'.repeat(40)), undefined)
  assert.equal(resolveWaitHead('b'.repeat(8), current, 'a'.repeat(40)), current)
})

test('an unhonored park on a merge-ready PR counts toward the same-head no-op budget', () => {
  assert.deepEqual(classifyPassScheduling({ disposition: 'park',
    text: 'PR is open, clean, mergeable, and all checks pass. No source changes require action.' }),
  { parked: false, noOp: true })
  assert.deepEqual(classifyPassScheduling({ disposition: 'retry', text: 'Nothing changed.' }),
    { parked: false, noOp: true })
  assert.deepEqual(classifyPassScheduling({ disposition: 'park', text: 'Required CI failed and needs repair.' }),
    { parked: false, noOp: true })
})

test('durable CI waits and terminal PRs do not consume the no-op budget', () => {
  for (const result of [
    { disposition: 'park' as const, text: 'Waiting for checks.' },
    { disposition: 'retry' as const, text: 'Package tests remain in progress.' },
    { disposition: 'park' as const, text: 'Repair pushed.', waitForChecksHead: 'b'.repeat(40) },
    { disposition: 'park' as const, text: 'Merged.', terminal: true },
  ]) assert.deepEqual(classifyPassScheduling(result), { parked: true, noOp: false })
})

test('the observed CI and Pullfrog queued-or-running result parks until its webhook', () => {
  assert.deepEqual(classifyPassScheduling({ disposition: 'park',
    text: 'Fixed and pushed root-level Auth refresh handling for Source and Blob, added regression coverage, resolved all three review threads, and confirmed the PR is mergeable with no conflicts. Focused tests and Blob/Source typechecks pass. CI and Pullfrog are queued or running; wait for their webhooks.' }),
  { parked: true, noOp: false })
  assert.deepEqual(classifyPassScheduling({ disposition: 'park', text: 'Pullfrog is running.' }),
    { parked: true, noOp: false })
  assert.deepEqual(classifyPassScheduling({ disposition: 'retry', text: 'Wait for the check webhook.' }),
    { parked: true, noOp: false })
  assert.deepEqual(classifyPassScheduling({ disposition: 'park', text: 'The local server is running. Required CI failed and still needs repair.' }),
    { parked: false, noOp: true })
})

test('a repair without a wait hint checkpoints its final proved head rather than its initial head', () => {
  const initial = 'a'.repeat(40), repaired = 'b'.repeat(40)
  const result = parsePassResult({ disposition: 'park', text: 'Repairs pushed; CI and Pullfrog are pending.' })!
  assert.equal(result.waitForChecksHead, undefined)
  assert.equal(classifyPassScheduling(result).parked, true)
  assert.equal(resolveExternalWaitHead(repaired, initial, repaired), repaired)
  assert.equal(resolveExternalWaitHead(undefined, initial, initial), initial)
})

test('external wait fallback rejects a changed head without owned Git proof', () => {
  const initial = 'a'.repeat(40), repaired = 'b'.repeat(40), external = 'c'.repeat(40)
  assert.equal(resolveExternalWaitHead(undefined, initial, repaired), undefined)
  assert.equal(resolveExternalWaitHead(repaired, initial, external), undefined)
  assert.equal(resolveExternalWaitHead('pending', initial, 'pending'), undefined)
})

test('the reproduced Actions permission blocker parks without hiding ordinary failed CI', () => {
  const result = parsePassResult({ disposition: 'park', text: 'PR #1511 remains blocked by required CI. Build and five focused tests passed, including all three CI failures. All review pages are clear. CI rerun reproduced “Resource not accessible by integration”; Actions write access is needed to rerun job 36733199333. Blocker recorded at https://github.com/vite-hub/vitehub/pull/1511#issuecomment-5916703811. Full local suite was stopped and remains unverified. No source changes pushed.' })!
  assert.deepEqual(classifyPassScheduling(result), { parked: true, noOp: false })
  const head = '94cd02af'.padEnd(40, '0')
  assert.equal(resolveExternalWaitHead(undefined, head, head), head)
  for (const text of [
    'Required package tests failed. Repair the provider implementation.',
    'Resource not accessible by integration while resolving a thread. Pull request write access is needed.',
    'Actions write access is available. CI rerun failed because the tests are broken.',
  ]) assert.deepEqual(classifyPassScheduling({ disposition: 'park', text }), { parked: false, noOp: true })
})

test('a proved repair push parks on the pushed head only while it is the PR head', () => {
  const initial = 'a'.repeat(40), pushed = 'b'.repeat(40), external = 'c'.repeat(40)
  assert.equal(pushedRepairWaitHead(pushed, initial, pushed), pushed)
  assert.equal(pushedRepairWaitHead(undefined, initial, initial), undefined)
  assert.equal(pushedRepairWaitHead(initial, initial, initial), undefined)
  assert.equal(pushedRepairWaitHead(pushed, initial, external), undefined)
  assert.deepEqual(classifyPassScheduling({ disposition: 'retry', text: 'Pushed a repair.', waitForChecksHead: pushedRepairWaitHead(pushed, initial, pushed) }), { parked: true, noOp: false })
})
