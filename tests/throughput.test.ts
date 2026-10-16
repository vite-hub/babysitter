// The upstream package owns the detailed scheduler tests. Keep this service
// check focused on the contracts needed for deployment and recovery.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProviderRateLimit } from 'vite-hub/agent/presets/babysitter/server'

let modules = dirname(realpathSync(fileURLToPath(import.meta.resolve('vite-hub/agent'))))
while (!modules.endsWith('/node_modules')) modules = dirname(modules)
const dist = join(modules, '@vite-hub/agent/dist')
const source = readdirSync(dist).filter(name => name.endsWith('.js')).map(name => readFileSync(join(dist, name), 'utf8')).join('\n')

test('scheduler includes the CI recovery lane and stack-aware queue state', () => {
  assert.match(source, /ci-recovery-next:/)
  assert.match(source, /stackBlocked/)
  assert.match(source, /recoveryHead/)
})

test('admission pauses model passes while leaving durable host state visible', () => {
  assert.match(source, /function babysitterAdmissionDecision\(/)
  assert.match(source, /hostOnly: true/)
  assert.match(source, /admission-skipped/)
  assert.match(source, /budget: \{/)
})

test('provider capacity has a bounded pending queue', () => {
  assert.match(source, /maxPending: agent\.options\.concurrency/)
  assert.match(source, /timeout: 36e5/)
})

test('a model quota cooldown keeps host merges running while GitHub limits stop the scheduler', () => {
  // The model breaker only closes model admission, so ready PRs still merge.
  assert.match(source, /providerBlockedUntil > Date\.now\(\) && modelAdmission\) \{\n\t+modelAdmission = false;/)
  assert.match(source, /babysitter\.provider\.quota\.host_only/)
  assert.doesNotMatch(source, /schedulerEvent\("babysitter\.provider\.quota\.blocked", \{ retryAt: providerBlockedUntil \}\);\n\t+return;/)
  // GitHub rate limits keep their own breaker and still stop every forge request.
  assert.match(source, /setMeta\("forge-quota-blocked-until", blockedUntil\)/)
  assert.match(source, /forgeBlockedUntil > Date\.now\(\)\) \{\n[^\n]*\n\t+return;/)
})

test('PRs with a reviewed current head are claimed before model passes', () => {
  // Their claim is a host merge check, so it must not wait behind every model pass.
  assert.match(source, /ORDER BY EXISTS \(SELECT 1 FROM \$\{t\.meta\} m WHERE m\.scope=p\.scope AND m\.key='review-assessment:' \|\| p\.repository \|\| '#' \|\| p\.number AND json_extract\(m\.value, '\$\.head'\)=p\.head_sha\) DESC,/)
})

test('a new main commit does not reopen an assessed review', async () => {
  // Each merge moves main. When the base commit was part of the review key, every PR went
  // back to a model pass after every merge, and that work all hit the provider quota.
  const { c: feedbackFingerprints, s: directMergeReadiness, u: mergeReviewEvidenceKey } = await import(join(dist, 'babysitter-ZENI2mzg.js'))
  const snapshot = (baseSha: string, baseRef = 'main') => ({
    repository: 'vite-hub/vitehub',
    pr: { state: 'open', draft: false, head: { sha: 'a'.repeat(40), ref: 'fix' }, base: { sha: baseSha, ref: baseRef, repo: { full_name: 'vite-hub/vitehub' } } },
    checks: { 1: { id: 1, name: 'docs', head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'failure' } },
    statuses: {},
    comments: {},
    reviews: { 7: { id: 7, body: 'Please handle the empty case.', state: 'COMMENTED', user: { login: 'maintainer' } } },
    reviewComments: {},
    threads: [],
    threadsHydrated: true,
  })
  const reviewed = snapshot('1'.repeat(40))
  const assessment = { assessedFeedback: new Set(feedbackFingerprints(reviewed)), reviewedEvidenceKey: mergeReviewEvidenceKey(reviewed) }
  assert.deepEqual(directMergeReadiness(snapshot('2'.repeat(40)), 'passed', assessment), { ready: true, head: 'a'.repeat(40) })
  // Assessments stored before this change still match while the base has not moved.
  const legacy = { assessedFeedback: new Set(feedbackFingerprints(reviewed, {}, true)), reviewedEvidenceKey: mergeReviewEvidenceKey(reviewed, {}, true) }
  assert.equal(directMergeReadiness(reviewed, 'passed', legacy).ready, true)
  // A retargeted PR still needs a new review.
  assert.equal(directMergeReadiness(snapshot('2'.repeat(40), 'next'), 'passed', assessment).ready, false)
})

test('a live merge read waits for GitHub to compute mergeability', () => {
  assert.match(source, /live\.mergeable === null \|\| live\.mergeable_state === "unknown"\); attempt\+\+\) \{\n\t+await new Promise\(\(resolve\) => setTimeout\(resolve, mergeabilityRetryDelayMs\)\);/)
})

test('provider breaker ignores malformed JSON and recognizes HTTP rate limits', () => {
  assert.equal(isProviderRateLimit(new Error('Command failed: gh api --paginate ... unexpected end of JSON input')), false)
  assert.equal(isProviderRateLimit(new Error('GitHub API returned HTTP 429 Too Many Requests')), true)
})
