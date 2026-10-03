import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWithProviderRetry } from '../server/babysitter.provider-retry.ts'

test('PR closure, cancellation and unrelated failures never pause other PRs', async () => {
  for (const error of [new DOMException('Pull request is no longer open.', 'AbortError'), new DOMException('429 request cancelled', 'AbortError'), new Error('Checkout failed')]) {
    let calls = 0, blocks = 0, delays = 0
    await assert.rejects(runWithProviderRetry(async () => { calls++; throw error }, () => { blocks++ }, async () => { delays++ }), value => value === error)
    assert.deepEqual({ calls, blocks, delays }, { calls: 1, blocks: 0, delays: 0 })
  }
})

test('429 stops after exactly three retries and persists one cooldown', async () => {
  let calls = 0, blocks = 0, delays = 0
  await assert.rejects(runWithProviderRetry(async () => { calls++; throw new Error('HTTP 429') }, () => { blocks++ }, async () => { delays++ }), /429/)
  assert.deepEqual({ calls, blocks, delays }, { calls: 4, blocks: 1, delays: 3 })
})

test('successful retry and cancellation after a 429 do not set a cooldown', async () => {
  for (const cancel of [false, true]) {
    let calls = 0, blocks = 0
    const result = runWithProviderRetry(async () => {
      if (++calls === 1) throw new Error('rate limit')
      if (cancel) throw new DOMException('Pull request is no longer open.', 'AbortError')
      return 'done'
    }, () => { blocks++ }, async () => {})
    if (cancel) await assert.rejects(result, { name: 'AbortError' })
    else assert.equal(await result, 'done')
    assert.equal(calls, 2)
    assert.equal(blocks, 0)
  }
})
