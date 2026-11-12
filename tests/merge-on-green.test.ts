// Merge on green (2026-11-12): a PR merges with no model pass once its required checks pass or fail
// only the way main fails them. Automated review never holds the merge; bot P0/P1 findings still start a pass.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dist } from './agent-dist.ts'

const { s: directMergeReadiness, t: babysitter } = await import(join(dist, 'babysitter-ZENI2mzg.js'))
const { y: repairContextKey, z: reviewPushBudgetWork } = await import(join(dist, 'server-DZOuXkga.js'))
const head = 'a'.repeat(40)
const check = (id: number, name: string, status: string, conclusion: string | null) => ({
  id, name, head_sha: head, status, conclusion,
  app: { id: 15368, slug: 'github-actions' },
  html_url: `https://github.com/o/r/actions/runs/${id}/job/${id}`,
})
const bot = { login: 'pullfrog[bot]', type: 'Bot' }
const snapshot = (overrides: Record<string, unknown> = {}) => ({
  repository: 'o/r', number: 1,
  pr: { state: 'open', draft: false, head: { sha: head, ref: 'feature' }, base: { ref: 'main', repo: { full_name: 'o/r' } } },
  checks: {}, statuses: {}, comments: {}, reviews: {}, reviewComments: {}, threads: [], threadsHydrated: true,
  ...overrides,
})
const policy = (mergeOnGreen: boolean) => ({
  mergeOnGreen,
  automatedReviewSettled: mergeOnGreen,
  pendingReviewChecks: new Set(['pullfrog', 'pullfrog-approval']),
  workerAuthors: new Set<string>(),
  ignoreFeedbackAuthors: new Set<string>(),
  noFindingsReviews: [],
  reviewPushBudget: 3,
})

test('a green PR merges while Pullfrog still runs and its bot feedback is below P1', () => {
  const pr = snapshot({
    checks: { 1: check(1, 'pullfrog', 'in_progress', null), 2: check(2, 'docs', 'completed', 'failure') },
    reviews: { 3: { id: 3, body: 'P2: this edge case lacks a test.', state: 'COMMENTED', user: bot } },
  })
  assert.deepEqual(directMergeReadiness(pr, 'passed', policy(true)), { ready: true, head })
  assert.equal(directMergeReadiness(pr, 'passed', policy(false)).ready, false)
})

test('a bot P0 or P1 finding still needs an assessment pass', () => {
  const pr = snapshot({ reviews: { 3: { id: 3, body: '**P1** The guard skips the session check.', state: 'COMMENTED', user: bot } } })
  assert.deepEqual(directMergeReadiness(pr, 'passed', policy(true)), { ready: false, reason: '1 new feedback item needs assessment' })
  const below = snapshot({ reviews: { 3: { id: 3, body: 'P2 nit.', state: 'COMMENTED', user: bot } } })
  assert.notEqual(repairContextKey(pr, policy(true)), repairContextKey(snapshot(), policy(true)))
  assert.equal(repairContextKey(below, policy(true)), repairContextKey(snapshot(), policy(true)))
})

test('failing required checks, people and conflicts still gate the merge', () => {
  assert.equal(directMergeReadiness(snapshot(), 'failed', policy(true)).ready, false)
  const person = snapshot({ comments: { 4: { id: 4, body: 'Please rename this option.', user: { login: 'maintainer', type: 'User' } } } })
  assert.equal(directMergeReadiness(person, 'passed', policy(true)).ready, false)
  const conflict = snapshot({ pr: { ...snapshot().pr, mergeable: false } })
  assert.ok(reviewPushBudgetWork(conflict, policy(true), new Set()).includes('merge-conflict'))
})

test('a new green head merges without an assessment pass', () => {
  assert.deepEqual(reviewPushBudgetWork(snapshot(), policy(true), new Set()), [])
  assert.ok(reviewPushBudgetWork(snapshot({ reviewPushBudget: { count: 3, heads: [] } }), policy(false), new Set()).includes('new-head'))
})

test('the preset defaults mergeOnGreen off, validates it, and the Babysitter enables it with the Codex connector ignored', () => {
  assert.equal(babysitter.mergeOnGreen, false)
  assert.match(readFileSync(join(dist, 'babysitter-ZENI2mzg.js'), 'utf8'), /if \(!hasRuntimeType\(mergeOnGreen, "boolean"\)\) throw new TypeError\("\[vitehub\] Babysitter mergeOnGreen must be a boolean\."\);/)
  const config = readFileSync(new URL('../server/agents/babysitter/agent.ts', import.meta.url), 'utf8')
  assert.match(config, /mergeOnGreen: true/)
  assert.match(config, /'chatgpt-codex-connector\[bot\]'/)
  assert.match(config, /BABYSITTER_REASONING_EFFORT \|\| 'medium'/)
})
