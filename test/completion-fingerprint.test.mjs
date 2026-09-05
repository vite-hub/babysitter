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
  baseRefOid: 'b'.repeat(40),
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
    async (_key, fingerprint) => fingerprint !== completed,
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
    async (_key, fingerprint) => fingerprint !== completed,
    policyFingerprint,
  )

  assert.deepEqual(jobs, [])
})


test('another base advance wakes a PR that was already behind', () => {
  const behind = { ...pullRequest, mergeStateStatus: 'BEHIND' }
  const advanced = { ...behind, baseRefOid: 'c'.repeat(40) }
  assert.notEqual(successfulPassFingerprint(repository, behind, policyFingerprint), successfulPassFingerprint(repository, advanced, policyFingerprint))
})

test('a new failure wakes a PR even while another check remains failed', () => {
  const check = (name, conclusion) => ({ name, conclusion, status: 'COMPLETED' })
  const before = { ...pullRequest, statusCheckRollup: [check('lint', 'FAILURE'), check('test', 'SUCCESS')] }
  const after = { ...pullRequest, statusCheckRollup: [check('lint', 'FAILURE'), check('test', 'FAILURE')] }
  assert.notEqual(successfulPassFingerprint(repository, before, policyFingerprint), successfulPassFingerprint(repository, after, policyFingerprint))
})

test('check ordering and polling timestamps do not wake parked work', () => {
  const before = { ...pullRequest, statusCheckRollup: [{ name: 'lint', state: 'SUCCESS' }, { name: 'test', state: 'SUCCESS' }] }
  const after = { ...before, updatedAt: '2026-09-05T12:00:00Z', statusCheckRollup: [...before.statusCheckRollup].reverse() }
  assert.equal(successfulPassFingerprint(repository, before, policyFingerprint), successfulPassFingerprint(repository, after, policyFingerprint))
})

test('edited feedback wakes parked work without a new comment ID', () => {
  const before = { ...pullRequest, feedback: { comments: 'old-content', reviews: '', threads: '' } }
  const after = { ...before, feedback: { ...before.feedback, comments: 'edited-content' } }
  assert.notEqual(successfulPassFingerprint(repository, before, policyFingerprint), successfulPassFingerprint(repository, after, policyFingerprint))
})
