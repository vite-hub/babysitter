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

test('a provider rate limit pauses model passes briefly and resumes them at lower concurrency', () => {
  // Codex 429s clear within minutes. A fixed hour left the model about 9 minutes of work per hour.
  assert.doesNotMatch(source, /setMeta\("provider-quota-blocked-until", Date\.now\(\) \+ 36e5\)/)
  assert.match(source, /providerCooldownMs = options\.providerCooldownMs \?\? 3e5;/)
  assert.match(source, /Date\.now\(\) \+ Math\.min\(providerCooldownMs \* 2 \*\* \(strikes - 1\), 36e5\)/)
  // Passes that fail together escalate the cooldown once, and each success steps back one strike.
  assert.match(source, /if \(blockedUntil > Date\.now\(\)\) return;\n\t+const strikes = Math\.min\(await providerStrikes\(\) \+ 1, 5\);/)
  assert.match(source, /if \(strikes > 0\) await pullRequestInbox\.setMeta\("provider-quota-strikes", strikes - 1\);/)
  assert.match(source, /const modelLimit = modelAdmission \? Math\.max\(2, ownerLimit >> await providerStrikes\(\)\) : ownerLimit \+ 5;/)
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

test('a direct merge first updates a branch whose files changed on main after its checks ran', () => {
  // PR checks test the base of that moment. Two PRs that both added the same import passed
  // separately and broke main together, so overlapping PRs are retested on the current base.
  assert.match(source, /const overlap = await staleBaseOverlap\(snapshot, live, signal\);/)
  assert.match(source, /if \(!await updateBranch\(owner, repository, number, decision\.head, signal\)\) return "not-ready";/)
  assert.match(source, /`repos\/\$\{repository\}\/pulls\/\$\{number\}\/update-branch`,\n\t+"-f",\n\t+`expected_head_sha=\$\{head\}`/)
  // The tested base comes from the push history, not commit dates, and the lookups read one page.
  assert.match(source, /activity\?ref=\$\{encodeURIComponent\(`refs\/heads\/\$\{baseRef\}`\)\}&per_page=100`/)
  assert.match(source, /compare\/\$\{testedBase\}\.\.\.\$\{encodeURIComponent\(baseRef\)\}\?per_page=1`/)
  assert.doesNotMatch(source, /readRest\(`repos\/\$\{repository\}\/(commits\?|compare\/)/)
})

test('a live merge read waits for GitHub to compute mergeability', () => {
  assert.match(source, /live\.mergeable === null \|\| live\.mergeable_state === "unknown"\); attempt\+\+\) \{\n\t+await new Promise\(\(resolve\) => setTimeout\(resolve, mergeabilityRetryDelayMs\)\);/)
})

test('provider breaker ignores malformed JSON and recognizes HTTP rate limits', () => {
  assert.equal(isProviderRateLimit(new Error('Command failed: gh api --paginate ... unexpected end of JSON input')), false)
  assert.equal(isProviderRateLimit(new Error('GitHub API returned HTTP 429 Too Many Requests')), true)
})

test('dependency installs share a few slots and wait instead of discarding the checkout', () => {
  // One serial installer of about 70 s made every third pass fail after two minutes and redo its checkout.
  assert.match(source, /const installSlots = Math\.max\(1, Number\.parseInt\(process\.env\.VITEHUB_INSTALL_CONCURRENCY \?\? "", 10\) \|\| 2\);/)
  assert.match(source, /const installQueueTimeoutMs = 6e5;/)
  assert.match(source, /await acquireInstallSlot\(signal\);\n\ttry \{\n\t\tsignal\?\.throwIfAborted\(\);\n\t\tawait installWorkspace\(target, signal, run\);\n\t\} finally \{\n\t\treleaseInstallSlot\(\);/)
  assert.doesNotMatch(source, /let installationTail = /)
})

test('a rejected lockfile waits for a new push instead of reinstalling every few minutes', async () => {
  // Four PRs with broken lockfiles took about 230 checkouts in 30 hours, most of them retried at once from the fleet.
  const { x: lockfileDefect } = await import(join(dist, 'github-C5fJH50u.js'))
  assert.equal(lockfileDefect(new Error('[fleet] Dependency install failed on servarica:\n ERR_PNPM_BROKEN_LOCKFILE  The lockfile at')), true)
  assert.equal(lockfileDefect(new Error('Frozen dependency installation failed: Map keys must be unique at line 961')), true)
  assert.equal(lockfileDefect(new Error('x', { cause: new Error(' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"') })), true)
  // A slow installer, a corrupt download or a network error can pass on the next try.
  assert.equal(lockfileDefect(new Error('Dependency installer capacity remained busy for ten minutes')), false)
  assert.equal(lockfileDefect(new Error('ERR_PNPM_TARBALL_INTEGRITY  Got unexpected checksum')), false)
  assert.match(source, /throw new GitHubWorkspaceInstallError\(error, !lockfileDefect\(error\) && \(retryable \|\| isSystemError\(error\)\)\);/)
  assert.match(source, /\/\^\\\[fleet\\\] Dependency install failed\/\.test\(error\.message\) \|\| lockfileDefect\(error\)\)\) \{/)
  assert.match(source, /if \(!lockfileDefect\(error\)\) wait\.retryAt = Date\.now\(\) \+ 3e5;/)
})

test('a pass waits for checks that still run on its head, even beside an early failure', async () => {
  // 75% of model passes started while required checks were pending: a fast lint failure or the
  // not-yet-created ci aggregator let a 15-minute pass start before the other checks and the review.
  const { w: checksStillRunning } = await import(join(dist, 'server-DZOuXkga.js'))
  const head = 'a'.repeat(40)
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 6e4).toISOString()
  const snapshot = (...checks: object[]) => ({ pr: { head: { sha: head } }, checks: Object.fromEntries(checks.map((check, index) => [index, { id: index + 1, head_sha: head, app: { id: 1 }, ...check }])), statuses: {} })
  const lintFailed = { name: 'fast checks', status: 'completed', conclusion: 'failure', started_at: at(3) }
  assert.equal(checksStillRunning(snapshot(lintFailed, { name: 'pullfrog', status: 'in_progress', started_at: at(3) })), true)
  assert.equal(checksStillRunning(snapshot(lintFailed, { name: 'docs', status: 'queued', started_at: at(1) })), true)
  // Everything settled, or the only running check is stuck: the pass runs now.
  assert.equal(checksStillRunning(snapshot(lintFailed)), false)
  assert.equal(checksStillRunning(snapshot(lintFailed, { name: 'Workers Builds', status: 'in_progress', started_at: at(45) })), false)
  assert.match(source, /if \(checksStillRunning\(snapshot\)\) return reviewCheckRunning\(snapshot, waitPolicy\) \? "review checks" : "running checks";\n\t+if \(failureKeys\(snapshot\)\.length\) return void 0;/)
  assert.match(source, /if \(!conflict && checksStillRunning\(s\)\) return \[\];/)
})

test('green PRs without a stored review are claimed before PRs that need model passes', () => {
  // A fully green PR with no stored review sat behind about 100 older PRs needing 15-minute passes.
  assert.match(source, /mergeReady: looksMergeReady\(s\),/)
  assert.match(source, /json_extract\(m\.value, '\$\.head'\)=p\.head_sha\) DESC,\n\s+coalesce\(json_extract\(p\.summary, '\$\.mergeReady'\), 0\) DESC,/)
  assert.match(source, /return signals\.length > 0 && signals\.every\(\(signal\) => signal\.status === "completed" && \[/)
})

test('failed checks from an older base get one model-free retest on the current base', () => {
  // While main was red, 9 of 12 sampled red PRs failed only main's duplicate import. An update
  // makes them green once main is fixed; a model pass would spend 15 minutes on each.
  assert.match(source, /if \(merge\.mode === "direct" && await retestOnCurrentBase\(inboxClaim\.snapshot, owner, passSignal\)\) \{/)
  assert.match(source, /if \(!failureKeys\(snapshot\)\.length \|\| checksStillRunning\(snapshot\)\) return false;/)
  assert.match(source, /const key = `base-retest:\$\{repository\}#\$\{number\}`;\n\t+if \(\(await pullRequestInbox\.metaNumber\(key\) \?\? 0\) > Date\.now\(\) - 216e5\) return false;/)
  assert.match(source, /const testedBase = await checksTestedBase\(snapshot, head, baseRef, failed, signal\);/)
  // No retest while the base tip itself fails: the update would inherit the failures.
  assert.match(source, /commits\/\$\{encodeURIComponent\(baseRef\)\}\/check-runs\?per_page=100`/)
  assert.match(source, /if \(baseFailures !== 0\) return false;/)
  // The retest runs before model admission, so it also works while the provider is cooling down.
  assert.ok(source.indexOf('await retestOnCurrentBase(inboxClaim.snapshot') < source.indexOf('if (await parkBlockedModelWork()) return;'))
})

test('a pass that reports its pushed head as reviewed records the feedback it inspected', () => {
  // After a repair push, the same comments otherwise needed a second 15-minute pass before the merge.
  assert.match(source, /else if \(pushedHead && passResult\?\.reviewedHead === pushedHead && passResult\?\.wait\?\.kind !== "external"\) await recordAssessment\(inboxClaim\.snapshot\);/)
  // The unchanged-head assessment still binds the head and its check evidence.
  assert.match(source, /const assessed = passResult\?\.wait\?\.kind !== "external" && !pushedHead && disposition === "park"/)
})
