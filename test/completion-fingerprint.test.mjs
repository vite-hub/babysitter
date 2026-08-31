import assert from 'node:assert/strict'
import test from 'node:test'
import {
  selectPullRequestJobs,
  successfulPassFingerprint,
} from '../server/babysitter.queue.ts'

const repository = 'vite-hub/vitehub'
const policyFingerprint = 'policy'
const pullRequest = {
  baseRefName: 'main',
  body: '',
  comments: [],
  headRefName: 'fix/session-history',
  headRefOid: 'a'.repeat(40),
  headRepository: { nameWithOwner: repository },
  isDraft: false,
  labels: [],
  mergeStateStatus: 'CLEAN',
  number: 42,
  reviewDecision: null,
  reviews: [],
  state: 'OPEN',
  statusCheckRollup: [],
  title: 'Fix session history',
  updatedAt: '2026-08-31T00:00:00.000Z',
  url: 'https://github.com/vite-hub/vitehub/pull/42',
}

test('a base advance wakes a clean parked pull request when it becomes behind', async () => {
  const completed = successfulPassFingerprint(repository, pullRequest, policyFingerprint)
  const advanced = { ...pullRequest, mergeStateStatus: 'BEHIND' }

  assert.notEqual(successfulPassFingerprint(repository, advanced, policyFingerprint), completed)
  const jobs = await selectPullRequestJobs(
    [repository],
    async () => [advanced],
    async () => completed,
    policyFingerprint,
  )

  assert.equal(jobs.length, 1)
  assert.equal(jobs[0]?.pullRequest.number, pullRequest.number)
})

test('an unchanged behind pull request remains parked', async () => {
  const behind = { ...pullRequest, mergeStateStatus: 'BEHIND' }
  const completed = successfulPassFingerprint(repository, behind, policyFingerprint)
  const jobs = await selectPullRequestJobs(
    [repository],
    async () => [behind],
    async () => completed,
    policyFingerprint,
  )

  assert.deepEqual(jobs, [])
})
