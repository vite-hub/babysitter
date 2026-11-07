// Contracts of the @vite-hub/agent patch that stops self-cancelled CI and settles
// automated review after two minor rounds. They assert patched-dist text, so a pin
// upgrade that drops a hunk fails here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let modules = dirname(realpathSync(fileURLToPath(import.meta.resolve('vite-hub/agent'))))
while (!modules.endsWith('/node_modules')) modules = dirname(modules)
const dist = join(modules, '@vite-hub/agent/dist')
const source = readdirSync(dist).filter(name => name.endsWith('.js')).map(name => readFileSync(join(dist, name), 'utf8')).join('\n')

test('checks stay running for GitHub queue and run limits, not 30 minutes', () => {
  assert.doesNotMatch(source, /const stuckBefore = Date\.now\(\) - 18e5;/)
  assert.match(source, /const limit = !actions \? 18e5 : status === "in_progress" \? 8 \* 36e5 : 24 \* 36e5;/)
  assert.match(source, /if \(checksStillRunning\(snapshot, waitPolicy\)\) return/)
  assert.match(source, /if \(!conflict && checksStillRunning\(s, policy\)\) return \[\];/)
})

test('two minor automated-review rounds settle review like a spent push budget', () => {
  assert.match(source, /async function recordAutomatedReviewRound\(snapshot, severity, head\)/)
  assert.match(source, /return count >= 2;/)
  assert.match(source, /inboxClaim\.reviewSettled = true;/)
  assert.match(source, /if \(claim\.reviewSettled === true && this\.budgets\.reviewPushes !== void 0\) s\.reviewPushBudget = \{/)
  assert.match(source, /\]\.includes\(value\.automatedReview\)\) normalized\.automatedReview = value\.automatedReview;/)
})

test('settled automated review no longer waits for a running review', () => {
  assert.match(source, /function reviewCheckRunning\(s, policy\) \{\n\t\/\/ [^\n]*\n\tif \(reviewPushBudgetSpent\(s, policy\)\) return false;/)
  assert.match(source, /if \(assessment\.automatedReviewSettled !== true && \(evidence\.checkRuns\.some/)
})

test('a CI check queued for hours still counts as running, unless it passed GitHub limits', async () => {
  const { w: checksStillRunning, x: wakeReasons } = await import(join(dist, 'server-DZOuXkga.js'))
  const head = 'a'.repeat(40)
  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
  const snapshot = (checks: object, count = 0) => ({
    repository: 'vite-hub/vitehub',
    number: 7,
    pr: { state: 'open', head: { sha: head }, base: { sha: '1'.repeat(40), ref: 'main' }, mergeable: true, mergeable_state: 'clean' },
    checks,
    statuses: {},
    comments: {},
    reviews: {},
    reviewComments: {},
    threads: [],
    reviewPushBudget: { count, heads: [head] },
  })
  const actions = { id: 15368, slug: 'github-actions' }
  const check = (id: number, name: string, status: string, startedHoursAgo: number, app: object = actions) => ({ [id]: { id, name, app, head_sha: head, status, started_at: ago(startedHoursAgo) } })
  // 2026-11-06: jobs waited about 2 h for a runner, and the 30-minute rule let passes push over them.
  assert.equal(checksStillRunning(snapshot(check(1, 'ci', 'queued', 2))), true)
  assert.equal(checksStillRunning(snapshot(check(1, 'ci', 'queued', 23))), true)
  assert.equal(checksStillRunning(snapshot(check(1, 'ci', 'queued', 25))), false)
  assert.equal(checksStillRunning(snapshot(check(1, 'ci', 'in_progress', 2))), true)
  assert.equal(checksStillRunning(snapshot(check(1, 'ci', 'in_progress', 9))), false)
  // Other apps keep 30 minutes: Workers Builds can stay in_progress forever.
  assert.equal(checksStillRunning(snapshot(check(1, 'Workers Builds', 'in_progress', 1, { id: 9, slug: 'cloudflare-workers-and-pages' }))), false)

  const policy = {
    workerAuthors: new Set<string>(),
    ignoreFeedbackAuthors: new Set<string>(),
    pendingReviewChecks: new Set(['pullfrog', 'pullfrog-approval']),
    noFindingsReviews: [],
    wakeWhenReady: true,
    reviewPushBudget: 3,
  }
  const pullfrog = check(2, 'pullfrog', 'queued', 1)
  // Before review settles, a running review holds the deferred pass; after, only CI does.
  assert.equal(checksStillRunning(snapshot(pullfrog, 0), policy), true)
  assert.equal(checksStillRunning(snapshot(pullfrog, 3), policy), false)
  assert.equal(checksStillRunning(snapshot({ ...pullfrog, ...check(1, 'ci', 'queued', 1) }, 3), policy), true)
  const deferred = (count: number) => wakeReasons({ ...snapshot(pullfrog, count), wait: { headSha: head, reason: 'checks', defer: 'checks', knownFailures: [] } }, 'passed', policy)
  assert.deepEqual(deferred(0), [])
  assert.deepEqual(deferred(3), ['gates-settled'])
})

test('settled review merges without waiting for a running review, and the result keeps its severity', async () => {
  const { s: directMergeReadiness, p: createBabysitterPassResultSchema } = await import(join(dist, 'babysitter-ZENI2mzg.js'))
  const head = 'a'.repeat(40)
  const snapshot = {
    repository: 'vite-hub/vitehub',
    number: 7,
    pr: { state: 'open', head: { sha: head }, base: { sha: '1'.repeat(40), ref: 'main' }, mergeable: true, mergeable_state: 'clean' },
    checks: { 1: { id: 1, name: 'pullfrog', app: { id: 1 }, head_sha: head, status: 'queued' } },
    statuses: {},
    comments: {},
    reviews: {},
    reviewComments: {},
    threads: [],
    threadsHydrated: true,
  }
  const assessment = { pendingReviewChecks: new Set(['pullfrog', 'pullfrog-approval']) }
  assert.deepEqual(directMergeReadiness(snapshot, 'passed', assessment), { ready: false, reason: 'a current-head review is still running' })
  assert.deepEqual(directMergeReadiness(snapshot, 'passed', { ...assessment, automatedReviewSettled: true }), { ready: true, head })

  const schema = createBabysitterPassResultSchema()['~standard']
  assert.equal(schema.validate({ disposition: 'park', text: 't', automatedReview: 'P2' }).value.automatedReview, 'P2')
  assert.equal(schema.validate({ disposition: 'park', text: 't', automatedReview: 'none' }).value.automatedReview, 'none')
  assert.equal(schema.validate({ disposition: 'park', text: 't', automatedReview: 'high' }).value.automatedReview, undefined)
})
