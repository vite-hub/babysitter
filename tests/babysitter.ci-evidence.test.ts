import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PullRequestInbox, type Json } from '../server/babysitter.inbox.ts'
import { diagnosticExcerpt, hydrateFailedCiEvidence } from '../server/babysitter.ci-evidence.ts'
const repository = 'vite-hub/vitehub'
const pr = { number: 7, state: 'open', user: { login: 'onmax' }, head: { sha: 'head', ref: 'fix' }, base: { ref: 'main' } }
const check = (patch: Json = {}) => ({ id: 11, name: 'types', app: { slug: 'github-actions' }, head_sha: 'head', status: 'completed', conclusion: 'failure', completed_at: '2026-09-13T10:00:00Z', html_url: `https://github.com/${repository}/actions/runs/1/job/11`, ...patch })
const job = (patch: Json = {}) => ({ id: 11, run_id: 1, run_attempt: 1, name: 'types', head_sha: 'head', status: 'completed', conclusion: 'failure', completed_at: '2026-09-13T10:00:00Z', steps: [{ number: 2, name: 'Typecheck', conclusion: 'failure' }], ...patch })
function fixture(t: { after: (fn: () => void) => void }, checks: Json[] = [check()]) {
 const inbox = new PullRequestInbox(':memory:', [repository]); t.after(() => inbox.close()); inbox.seed(repository, pr)
 const claim = inbox.claim(1)[0]!; inbox.hydrate(claim, { checks: Object.fromEntries(checks.map(c => [`check_run:${c.id}`, c])) })
 return { inbox, claim }
}
test('failed current-head job metadata and log are fetched once, cached and attached before model launch', async t => {
 const { inbox, claim } = fixture(t); let jsonCalls = 0, logCalls = 0
 const readers = { readJson: async (path: string) => { jsonCalls++; assert.equal(path, `repos/${repository}/actions/jobs/11`); return [job()] }, readLog: async () => { logCalls++; return '##[error] Type mismatch\nsource.ts:2' } }
 assert.equal(await hydrateFailedCiEvidence(inbox, claim, readers), true)
 assert.equal(await hydrateFailedCiEvidence(inbox, claim, readers), true)
 assert.equal(jsonCalls, 1); assert.equal(logCalls, 1)
 const evidence = claim.snapshot.ciEvidence![0]!
 assert.equal(evidence.status, 'available'); assert.equal(evidence.complete, true)
 assert.equal(evidence.excerpt, '##[error] Type mismatch\nsource.ts:2'); assert.equal(evidence.failedSteps[0].name, 'Typecheck')
 assert.equal(inbox.meta<{ value: { log: string } }>(evidence.cacheKey)?.value.log, evidence.excerpt)
})
test('pending, skipped, success and old-head checks never fetch job metadata or logs', async t => {
 const { inbox, claim } = fixture(t, [check({ id: 1, status: 'queued', conclusion: null }), check({ id: 2, conclusion: 'success' }), check({ id: 3, conclusion: 'skipped' }), check({ id: 4, head_sha: 'old' })])
 await hydrateFailedCiEvidence(inbox, claim, { readJson: async () => assert.fail('no metadata request'), readLog: async () => assert.fail('no log request') })
 assert.deepEqual(claim.snapshot.ciEvidence, [])
})
test('failed run mapping downloads only completed failed current-head jobs and deduplicates direct job', async t => {
 const { inbox, claim } = fixture(t, [check({ id: 100, app: undefined, html_url: `https://github.com/${repository}/actions/runs/1` }), check()]); let logs = 0, json = 0
 await hydrateFailedCiEvidence(inbox, claim, { readJson: async path => { json++; assert.ok(path.includes('/runs/1/jobs?')); return [job(), job({ id: 12, conclusion: 'success' }), job({ id: 13, status: 'in_progress' }), job({ id: 14, head_sha: 'old' })] }, readLog: async () => { logs++; return 'failed' } })
 assert.equal(logs, 1); assert.equal(json, 1); assert.equal(claim.snapshot.ciEvidence?.length, 1)
})
test('unavailable logs are distinct from CI failures and retried only after two minutes', async t => {
 const { inbox, claim } = fixture(t); let logCalls = 0
 const readers = { readJson: async () => [job()], readLog: async () => { logCalls++; throw new Error('API unavailable with arbitrary sensitive response') } }
 await hydrateFailedCiEvidence(inbox, claim, readers, 1000)
 await hydrateFailedCiEvidence(inbox, claim, readers, 120_999)
 assert.equal(logCalls, 1)
 assert.equal(claim.snapshot.ciEvidence![0]!.status, 'unavailable')
 assert.equal(JSON.stringify(claim.snapshot.ciEvidence).includes('sensitive'), false)
 await hydrateFailedCiEvidence(inbox, claim, readers, 121_000); assert.equal(logCalls, 2)
})
test('external reviewer check and unrelated job head never download an action log', async t => {
 const { inbox, claim } = fixture(t, [check({ id: 8, app: { slug: 'pullfrog' } }), check()])
 await hydrateFailedCiEvidence(inbox, claim, { readJson: async () => [job({ head_sha: 'default-branch' })], readLog: async () => assert.fail('unrelated log') })
 assert.equal(claim.snapshot.ciEvidence![0]!.status, 'unsupported')
 assert.equal(claim.snapshot.ciEvidence![1]!.status, 'unavailable')
})
test('webhook received during log fetch invalidates stale evidence but preserves reusable cached log', async t => {
 const { inbox, claim } = fixture(t)
 const result = await hydrateFailedCiEvidence(inbox, claim, { readJson: async () => [job()], readLog: async () => {
  inbox.ingest('pending', 'status', { repository: { full_name: repository }, sha: 'head', context: 'other', state: 'pending' })
  return '##[error] proof'
 } })
 assert.equal(result, false); assert.equal(inbox.get(repository, 7)?.ciEvidence, undefined)
 assert.equal(inbox.get(repository, 7)?.statuses.other?.state, 'pending')
})
test('diagnostic excerpts disclose every omitted or partial line and respect budgets', () => {
 const lines = Array.from({ length: 2000 }, (_, n) => n === 1000 ? '##[error] important diagnostic' : `log line ${n} ${'x'.repeat(60)}`)
 const result = diagnosticExcerpt(lines.join('\n'), 1600)
 assert.equal(result.complete, false); assert.equal(result.totalLines, 2000)
 assert.ok(result.excerpt.includes('important diagnostic')); assert.ok(result.excerpt.length <= 1600)
 assert.deepEqual(result.includedLineRanges, [[997, 1006]])
 const partial = diagnosticExcerpt('##[error] '+ 'x'.repeat(50_000), 100)
 assert.equal(partial.excerpt.length, 100); assert.deepEqual(partial.partialLines, [1])
 assert.equal(diagnosticExcerpt('large log', 0).excerpt, '')
})
test('whole snapshot excerpt budget caps at 48k while complete logs remain cached', async t => {
 const checks = [11,12,13,14].map(id => check({ id, html_url: `https://github.com/${repository}/actions/runs/1/job/${id}` }))
 const { inbox, claim } = fixture(t, checks)
 await hydrateFailedCiEvidence(inbox, claim, { readJson: async path => [job({ id: Number(path.split('/').at(-1)) })], readLog: async () => '##[error] '+ 'x'.repeat(20_000) })
 assert.equal(claim.snapshot.ciEvidence!.reduce((total, e) => total + e.excerpt.length, 0), 48_000)
 assert.equal(claim.snapshot.ciEvidence![3]!.complete, false); assert.equal(claim.snapshot.ciEvidence![3]!.fullLogCached, true)
})

test('new immutable job attempt refreshes its log while previous successful fetch remains cached', async t => {
 const { inbox, claim } = fixture(t); let calls = 0; let attempt = 1
 const readers = { readJson: async () => [job({ run_attempt: attempt, completed_at: `attempt-${attempt}` })], readLog: async () => { calls++; return `attempt ${attempt} log` } }
 await hydrateFailedCiEvidence(inbox, claim, readers, 1000)
 const firstKey = claim.snapshot.ciEvidence![0]!.cacheKey
 attempt = 2
 inbox.hydrate(claim, { checks: { changed: check({ run_attempt: 2, completed_at: 'attempt-2' }) } })
 await hydrateFailedCiEvidence(inbox, claim, readers, 2000)
 assert.equal(calls, 2)
 assert.notEqual(claim.snapshot.ciEvidence![0]!.cacheKey, firstKey)
 assert.equal(inbox.meta<{ value: { log: string } }>(firstKey)?.value.log, 'attempt 1 log')
 await hydrateFailedCiEvidence(inbox, claim, readers, 3000)
 assert.equal(calls, 2); assert.equal(claim.snapshot.ciEvidence![0]!.fetchedAt, new Date(2000).toISOString())
})
