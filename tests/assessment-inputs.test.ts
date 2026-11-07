import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { dist } from './agent-dist.ts'

const { c: feedback, s: readiness, u: evidence, v: matches } = await import(pathToFileURL(join(dist, 'babysitter-ZENI2mzg.js')).href)
const head = 'a'.repeat(40)
const snapshot = () => ({
  repository: 'vite-hub/drop',
  pr: { state: 'open', draft: false, title: 'fix viewer', body: 'Keep the viewer controls clear.', head: { sha: head, ref: 'fix' }, base: { ref: 'main', repo: { full_name: 'vite-hub/drop' } } },
  checks: {}, statuses: {}, comments: {}, reviews: {},
  reviewComments: { 9: { id: 9, body: 'Please handle the empty case.', user: { login: 'onmax', type: 'User' } } },
  threads: [{ id: 'T1', isResolved: false, comments: [{ id: 'C1', databaseId: 9 }] }],
  threadReopens: { T1: 0 }, threadsHydrated: true,
})
const scores = '\n\n## Council review\n\nRounds: 3\n\n| Delegate | Round 1 | Round 2 | Round 3 |\n| --- | --- | --- | --- |\n| Claude Opus 5.5 | 8/10 | 8.5/10 | 9/10 |\n| GPT-6.1 Sol | 8.5/10 | 9/10 | 9/10 |\n| Grok 4.7 | 7/10 | 8/10 | 9/10 |\n'

test('thread resolution and a council score table reuse the assessment while merge gates still run', () => {
  const reviewed = snapshot()
  const key = evidence(reviewed)
  const resolved = snapshot()
  resolved.threads.forEach(thread => { thread.isResolved = true })
  assert.equal(evidence(resolved), key, 'resolving assessed feedback must not start another model pass')
  resolved.pr.body += scores
  assert.equal(evidence(resolved), key, 'review scores must not start another model pass')
  const assessment = { reviewedEvidenceKey: key, assessedFeedback: new Set(feedback(reviewed)) }
  assert.deepEqual(readiness(resolved, 'pending', assessment), { ready: false, reason: 'required checks pending' })
  assert.deepEqual(readiness(resolved, 'passed', assessment), { ready: true, head })
  assert.deepEqual(readiness(reviewed, 'passed', assessment), { ready: false, reason: 'unresolved review threads' })
  const server = readFileSync(join(dist, 'server-DZOuXkga.js'), 'utf8')
  const parkGate = server.split('if (reviewedRetryAt !== void 0')[1]?.split(') {')[0]
  assert.ok(parkGate)
  assert.match(parkGate, /matchesMergeReviewEvidence/)
  assert.doesNotMatch(parkGate, /threads\.every/, 'assessed unresolved threads are merge gates, not new model work')

  const direction = structuredClone(resolved)
  direction.pr.body += '\nDo not merge before the migration is finished.'
  assert.equal(matches(key, direction), false)
  const councilDirection = structuredClone(resolved)
  councilDirection.pr.body += `${scores}\nDo not merge before approval.\n`
  assert.equal(matches(key, councilDirection), false)
  const finding = structuredClone(resolved)
  finding.reviewComments[9].body += ' Also handle null.'
  assert.equal(matches(key, finding), false)
  const reopened = structuredClone(resolved)
  reopened.threads.forEach(thread => { thread.isResolved = false })
  reopened.threadReopens.T1++
  assert.equal(matches(key, reopened), false)
  assert.equal(readiness(reopened, 'passed', assessment).ready, false)
  const failed = { ...resolved, checks: { 1: { id: 1, name: 'ci', head_sha: head, status: 'completed', conclusion: 'failure', output: { text: 'Broken docs links' } } } }
  assert.equal(matches(key, failed), false)
  assert.equal(readiness(failed, 'failed', assessment).ready, false)
})
