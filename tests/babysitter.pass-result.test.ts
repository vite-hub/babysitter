import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePassResult, resolveWaitHead } from '../server/babysitter.pass-result.ts'

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
