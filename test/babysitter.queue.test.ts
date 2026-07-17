import assert from 'node:assert/strict'
import test from 'node:test'
import {
  completionKey,
  type PullRequest,
  pullRequestFingerprint,
  resolveRepositories,
  selectPullRequestJobs,
} from '../server/babysitter.queue.ts'

function pullRequest(number: number): PullRequest {
  return {
    body: '',
    headRefName: `branch-${number}`,
    headRefOid: `head-${number}`,
    isDraft: true,
    mergeStateStatus: 'CLEAN',
    number,
    reviewDecision: null,
    state: 'OPEN',
    statusCheckRollup: [],
    title: `PR ${number}`,
    updatedAt: '2026-07-17T00:00:00Z',
    url: `https://github.com/example/repo/pull/${number}`,
  }
}

test('uses the singular repository when the plural setting is empty', () => {
  assert.deepEqual(resolveRepositories('', 'vite-hub/vitehub'), ['vite-hub/vitehub'])
  assert.deepEqual(resolveRepositories('vite-hub/brief, vite-hub/nuxt-agent', 'vite-hub/vitehub'), [
    'vite-hub/brief',
    'vite-hub/nuxt-agent',
  ])
})

test('enumerates repositories into one globally capped queue', async () => {
  const listed: string[] = []
  const jobs = await selectPullRequestJobs(
    ['vite-hub/vitehub', 'vite-hub/brief'],
    2,
    async repository => {
      listed.push(repository)
      return repository === 'vite-hub/vitehub' ? [pullRequest(1)] : [pullRequest(2), pullRequest(3)]
    },
    async () => null,
  )

  assert.deepEqual(listed.sort(), ['vite-hub/brief', 'vite-hub/vitehub'])
  assert.deepEqual(jobs.map(job => [job.repository, job.pullRequest.number]), [
    ['vite-hub/vitehub', 1],
    ['vite-hub/brief', 2],
  ])
})

test('keeps completion state qualified by repository', async () => {
  const completed = pullRequest(1)
  const jobs = await selectPullRequestJobs(
    ['vite-hub/vitehub', 'vite-hub/brief'],
    6,
    async () => [completed],
    async key => key === completionKey('vite-hub/vitehub', 1) ? pullRequestFingerprint('vite-hub/vitehub', completed) : null,
  )

  assert.equal(completionKey('vite-hub/brief', 1), 'babysitter/vite-hub/brief/pull-requests/1')
  assert.notEqual(pullRequestFingerprint('vite-hub/vitehub', completed), pullRequestFingerprint('vite-hub/brief', completed))
  assert.deepEqual(jobs.map(job => job.repository), ['vite-hub/brief'])
})
