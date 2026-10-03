import { test } from 'node:test'
import assert from 'node:assert/strict'
import { directMergeReadiness, liveMergeReadiness } from '../server/babysitter.direct-merge.ts'
import type { Snapshot } from '../server/babysitter.inbox.ts'

const head = 'a'.repeat(40)
function snapshot(patch: Partial<Snapshot> = {}): Snapshot {
  return {
    repository: 'vite-hub/vitehub', number: 7, generation: 2, handled: 1, status: 'working', reasons: [],
    pr: { state: 'open', draft: false, user: { login: 'onmax' }, head: { sha: head, ref: 'fix' }, base: { ref: 'main' } },
    comments: {}, reviews: {}, reviewComments: {}, statuses: {},
    checks: {
      1: { name: 'ci', head_sha: head, status: 'completed', conclusion: 'success' },
      2: { name: 'pullfrog-approval', head_sha: head, status: 'completed', conclusion: 'success' },
      3: { name: 'docs', head_sha: head, status: 'completed', conclusion: 'skipped' },
      4: { name: 'ci', head_sha: 'b'.repeat(40), status: 'completed', conclusion: 'failure' },
    },
    threads: [{ id: 't1', isResolved: true }], threadsHydrated: true,
    ...patch,
  } as Snapshot
}

test('a PR with green checks, Pullfrog approval, and resolved threads merges directly', () => {
  assert.deepEqual(directMergeReadiness(snapshot(), 'passed'), { ready: true, head })
  assert.deepEqual(liveMergeReadiness({ state: 'open', draft: false, mergeable_state: 'clean', head: { sha: head }, base: { ref: 'main', repo: { default_branch: 'main' } } }, head), { ready: true, head })
})

test('every gate independently sends the PR to a worker pass', () => {
  const blocked = (value: Snapshot, state = 'passed') => directMergeReadiness(value, state).ready
  assert.equal(blocked(snapshot(), 'pending'), false)
  assert.equal(blocked(snapshot({ pr: { ...snapshot().pr, draft: true } })), false)
  assert.equal(blocked(snapshot({ pr: { ...snapshot().pr, user: { login: 'someone' } } })), false)
  assert.equal(blocked(snapshot({ checks: { ...snapshot().checks, 2: { name: 'pullfrog-approval', head_sha: head, status: 'completed', conclusion: 'failure' } } })), false)
  assert.equal(blocked(snapshot({ checks: { 1: snapshot().checks[1] } })), false)
  assert.equal(blocked(snapshot({ checks: { ...snapshot().checks, 5: { name: 'lint', head_sha: head, status: 'in_progress' } } })), false)
  assert.equal(blocked(snapshot({ statuses: { ci: { sha: head, context: 'x', state: 'pending' } } })), false)
  assert.equal(blocked(snapshot({ threads: [{ id: 't1', isResolved: false }] })), false)
  assert.equal(blocked(snapshot({ threadsHydrated: false })), false)
  for (const live of [
    { state: 'open', mergeable_state: 'clean', head: { sha: head }, base: { ref: 'feat/parent', repo: { default_branch: 'main' } } },
    { state: 'open', mergeable_state: 'clean', head: { sha: head } },
    { state: 'open', mergeable_state: 'blocked', head: { sha: head } },
    { state: 'open', mergeable_state: 'clean', head: { sha: 'c'.repeat(40) } },
    { state: 'closed', mergeable_state: 'clean', head: { sha: head } },
    { state: 'open', draft: true, mergeable_state: 'clean', head: { sha: head } },
  ]) assert.equal(liveMergeReadiness(live, head).ready, false)
})
