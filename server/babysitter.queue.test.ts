import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkTracker } from 'vite-hub/runtime'
import { selectPullRequestJobs, successfulPassFingerprint, type PullRequest } from './babysitter.queue.ts'

const repository = 'vite-hub/vitehub'
const key = `babysitter/${repository}/pull-requests/1342`
const policy = 'test-policy'
const pullRequest = {
  number: 1342, state: 'OPEN', headRefOid: 'head-a', headRefName: 'fix/example',
  baseRefName: 'main', updatedAt: '2026-09-10T09:00:00Z', mergeStateStatus: 'DIRTY',
  statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }],
} as unknown as PullRequest

function setup(checkpoint?: unknown) {
  const records = new Map<string, unknown>(checkpoint ? [[key, checkpoint]] : [])
  let now = 1_000
  const work = createWorkTracker({
    now: () => now, retryMs: 100,
    store: { get: async key => records.get(key), set: async (key, value) => { records.set(key, value) } },
  })
  return {
    work,
    advance: () => { now += 100 },
    select: (pr = pullRequest) => selectPullRequestJobs([repository], async () => [pr], work.eligible, policy),
  }
}

test('an unchanged parked failure or conflict stays parked', async () => {
  const { select } = setup({ version: 1, fingerprint: successfulPassFingerprint(repository, pullRequest, policy), disposition: 'park', attempt: 0 })
  assert.equal((await select()).length, 0)
})

test('retry backoff applies to both selection and execution', async () => {
  const { work, select, advance } = setup()
  const [job] = await select()
  await work.run(job!.completionKey, job!.completionFingerprint, async () => ({ disposition: 'retry' }))
  assert.equal((await select()).length, 0)
  advance()
  const [retry] = await select()
  let invoked = false
  assert.equal(await work.run(retry!.completionKey, retry!.completionFingerprint, async () => {
    invoked = true
    return { disposition: 'park' }
  }), true)
  assert.equal(invoked, true)
  assert.equal((await select()).length, 0)
})

test('changed head wakes a parked PR, executes once, and parks', async () => {
  const { work, select } = setup({ version: 1, fingerprint: successfulPassFingerprint(repository, pullRequest, policy), disposition: 'park', attempt: 0 })
  const changed = { ...pullRequest, headRefOid: 'head-b' }
  const [job] = await select(changed)
  let calls = 0
  assert.equal(await work.run(job!.completionKey, job!.completionFingerprint, async () => {
    calls++
    return { disposition: 'park' }
  }), true)
  assert.equal(calls, 1)
  assert.equal((await select(changed)).length, 0)
})

test('a changed policy gives old checkpoints one fresh pass', async () => {
  const { work, select } = setup({ version: 1, fingerprint: successfulPassFingerprint(repository, pullRequest, 'old-policy'), disposition: 'park', attempt: 0 })
  const [job] = await select()
  assert.equal(await work.run(job!.completionKey, job!.completionFingerprint, async () => ({ disposition: 'park' })), true)
  assert.equal((await select()).length, 0)
})
