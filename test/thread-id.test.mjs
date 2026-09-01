import assert from 'node:assert/strict'
import test from 'node:test'
import { pullRequestThreadId } from '../server/babysitter.queue.ts'

test('keeps every pass for one pull request on the same provider thread', () => {
  assert.equal(
    pullRequestThreadId('Vite-Hub/ViteHub', 1210),
    'github:vite-hub/vitehub:pull-request:1210',
  )
})
