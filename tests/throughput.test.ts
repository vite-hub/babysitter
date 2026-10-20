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

test('parks on one head count against the no-progress budget, and exhausted heads still merge', () => {
  // vite-hub/vitehub#2479: external and reviewed-head parks used to start unbounded passes.
  assert.match(source, /progress: \{ kind: "no-progress" \},\n\t+wait: await externalWait\(/)
  assert.match(source, /\} else if \(assessed\) \{\n\t+outcome = "waiting";\n\t+recorded = await pullRequestInbox\.finish\(inboxClaim, \{\n\t+text: resultText,\n\t+progress: \{ kind: "no-progress" \},/)
  assert.match(source, /const regular = await pullRequestInbox\.claim\([^\n]*\{ includeBlocked: true, skip:/)
})

test('a cancelled model pass on one head counts against the no-progress budget', () => {
  // vite-hub/vitehub#2509: conflict repairs cancelled by a moving base restarted without limit.
  assert.match(source, /modelDispatched = true;\n\t+return await runAgent\(agent, \{/)
  assert.match(source, /"Pass interrupted; current webhook state retained\.",\n\t+retry: !pushSucceeded,\n[^\n]*\n\t+\.\.\.modelDispatched && !pushSucceeded && !providerLimited \? \{ progress: \{ kind: "no-progress" \} \} : \{\}/)
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
  // Passes that fail together escalate the cooldown once. 2026-10-18: stepping back a strike on every
  // success held the cooldown at five minutes all night, so only a success 30 minutes after the last one counts.
  assert.match(source, /if \(blockedUntil > Date\.now\(\)\) return;\n\t+const strikes = Math\.min\(await providerStrikes\(\) \+ 1, 5\);/)
  assert.match(source, /if \(strikes > 0 && Date\.now\(\) - lastBlockedUntil > 18e5\) await pullRequestInbox\.setMeta\("provider-quota-strikes", strikes - 1\);/)
  // BABYSITTER_MODEL_CONCURRENCY caps model passes to what the remaining accounts can serve.
  assert.match(source, /const modelLimit = modelAdmission \? Math\.min\(providerConcurrency, Math\.max\(2, ownerLimit >> await providerStrikes\(\)\)\) : ownerLimit \+ 5;/)
})

test('a pass that runs out of provider retries waits for the cooldown instead of failing the PR', () => {
  // 2026-10-17: 53 of 55 owner failures were Codex 429s, each published as a failed PR status.
  assert.match(source, /\} else if \(!pushSucceeded && isProviderRateLimit\(error\) && await parkBlockedModelWork\(\)\) \{\n(?:\t+\/\/[^\n]*\n)*\t+schedulerEvent\("babysitter\.owner\.deferred", \{\n\t+reason: "provider-rate-limit",/)
})

test('PRs with a reviewed current head are claimed before model passes', () => {
  // Their claim is a host merge check, so it must not wait behind every model pass.
  assert.match(source, /ORDER BY \(p\.head_ref LIKE 'babysitter\/repair-main-%'\) DESC,\n\t*\s*EXISTS \(SELECT 1 FROM \$\{t\.meta\} m WHERE m\.scope=p\.scope AND m\.key='review-assessment:' \|\| p\.repository \|\| '#' \|\| p\.number AND json_extract\(m\.value, '\$\.head'\)=p\.head_sha\) DESC,/)
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

test('an assessed bot thread left open does not block a green PR', async () => {
  // 2026-10-19: seven green PRs sat parked for hours behind outdated chatgpt-codex-connector threads
  // the agent had assessed but not resolved. GitHub only requires `ci`; threads by people still block.
  const { s: directMergeReadiness } = await import(join(dist, 'babysitter-ZENI2mzg.js'))
  const snapshot = (user: { login: string, type: string }) => ({
    repository: 'vite-hub/vitehub',
    pr: { state: 'open', draft: false, head: { sha: 'a'.repeat(40), ref: 'fix' }, base: { sha: '1'.repeat(40), ref: 'main', repo: { full_name: 'vite-hub/vitehub' } } },
    checks: {},
    statuses: {},
    comments: {},
    reviews: {},
    reviewComments: { 9: { id: 9, body: 'P2: handle aliases.', user } },
    threads: [{ id: 'T1', isResolved: false, isOutdated: true, comments: [{ id: 'C1', databaseId: 9 }] }],
    threadsHydrated: true,
  })
  const assessment = { assessedFeedback: new Set<string>(), reviewedEvidenceKey: undefined }
  const { c: feedbackFingerprints } = await import(join(dist, 'babysitter-ZENI2mzg.js'))
  const bot = snapshot({ login: 'chatgpt-codex-connector[bot]', type: 'Bot' })
  assert.equal(directMergeReadiness(bot, 'passed', { ...assessment, assessedFeedback: new Set(feedbackFingerprints(bot)) }).ready, true)
  const person = snapshot({ login: 'onmax', type: 'User' })
  assert.deepEqual(directMergeReadiness(person, 'passed', { ...assessment, assessedFeedback: new Set(feedbackFingerprints(person)) }), { ready: false, reason: 'unresolved review threads' })
  // The wake check ignores the same assessed bot threads.
  assert.match(source, /if \(s\.threads\.some\(\(thread\) => thread\.isResolved !== true && humanThread\(thread\)\)\) reasons\.push\("unresolved-thread"\);/)
})

test('a direct merge first updates a branch whose files changed on main after its checks ran', () => {
  // PR checks test the base of that moment. Two PRs that both added the same import passed
  // separately and broke main together, so overlapping PRs are retested on the current base.
  assert.match(source, /const overlap = await staleBaseOverlap\(snapshot, live, signal\);/)
  assert.match(source, /if \(!await updateBranch\(owner, repository, number, decision\.head, signal, live\)\) return "not-ready";/)
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
  // No retest while the base tip fails the same checks: the update would inherit them. Other base
  // failures (release proposal, docs deploy) fail on most main pushes and must not block it.
  assert.match(source, /commits\/\$\{encodeURIComponent\(baseRef\)\}\/check-runs\?per_page=100`/)
  assert.doesNotMatch(source, /if \(baseFailures !== 0\) return false;/)
  assert.match(source, /baseFailing\.has\(String\(check\.name \?\? check\.context\)\)\)\) return false;/)
  // The retest runs before model admission, so it also works while the provider is cooling down.
  assert.ok(source.indexOf('await retestOnCurrentBase(inboxClaim.snapshot') < source.indexOf('if (await parkBlockedModelWork()) return;'))
})

test('failures that the base tip shares park without a model pass until the base passes', () => {
  // On 2026-10-19 main's preview build failed for 4 h; 47 of 69 open PRs inherited the failure and
  // each still took a 1-4M token pass to assess it.
  const gate = source.slice(source.indexOf('async function inheritedBaseFailures('), source.indexOf('async function staleBaseOverlap('))
  assert.match(gate, /startsWith\("babysitter\/repair-main-"\)\) return \[\];/)
  assert.match(gate, /if \(conflictedSnapshot\(snapshot\) \|\| checksStillRunning\(snapshot\)\) return \[\];/)
  assert.match(gate, /if \(\(snapshot\.humanFeedbackGeneration \?\? 0\) > \(snapshot\.handled \?\? 0\)\) return \[\];/)
  assert.match(gate, /hasHumanComment\(thread, waitPolicy\.workerAuthors, snapshot\)\)\) return \[\];/)
  assert.match(gate, /return failing\.every\(\(name\) => inherited\.has\(name\)\) \? failing : \[\];/)
  // An optional inherited failure still gets the pass that assesses it, so the PR can merge.
  assert.match(gate, /if \(!failing\.length \|\| await requiredCheckState\(snapshot\) !== "failed"\) return \[\];/)
  assert.match(source, /reason: "base-failing",/)
  assert.match(source, /wait\.retryAt = Date\.now\(\) \+ 9e5;/)
  // After the retest (which updates the branch once the base is green) and before model admission.
  const call = source.indexOf('await inheritedBaseFailures(inboxClaim.snapshot')
  assert.ok(source.indexOf('await retestOnCurrentBase(inboxClaim.snapshot') < call)
  assert.ok(call < source.indexOf('if (await parkBlockedModelWork()) return;'))
})

test('a pass that reports its pushed head as reviewed records the feedback it inspected', () => {
  // After a repair push, the same comments otherwise needed a second 15-minute pass before the merge.
  assert.match(source, /else if \(pushedHead && passResult\?\.reviewedHead === pushedHead\) await recordAssessment\(inboxClaim\.snapshot\);/)
  // The unchanged-head assessment still binds the head and its check evidence.
  assert.match(source, /const assessed = !pushedHead && disposition === "park"/)
})

test('an exhausted head gets one more pass for a new conflict or new bot feedback, once each', () => {
  // vite-hub/vitehub: grants on the no-progress budget.
  assert.match(source, /grants: v\.optional\(v\.array\(v\.picklist\(\["conflict", "bot-feedback"\]\)\)\)/)
  assert.match(source, /if \(previous && !newHead && conflicted\(s\.pr\) && !conflicted\(previous\)\) this\.grantProgress\(s, "conflict"\);/)
  assert.match(source, /toLowerCase\(\) === "bot" && !this\.activityAuthors\.has\([^\n]*\)\) this\.grantProgress\(s, "bot-feedback"\);/)
  assert.match(source, /budget\.grants\?\.includes\(grant\)\) return;/)
  assert.match(source, /resetReason: previous\?\.resetReason,\n\t+\.\.\.previous\?\.grants \? \{ grants: previous\.grants \} : \{\}/)
})

test('a pass whose wait loses to new bot evidence still counts', () => {
  // vite-hub/vitehub#2531
  assert.match(source, /this\.recordRejectedProgress\(s, claim, result\.progress\);\n\t+await this\.put\(tx, s\);\n\t+return false;/)
  assert.match(source, /if \(\(s\.humanFeedbackGeneration \?\? 0\) <= claim\.generation\) this\.recordProgress\(s, claim, progress\);/)
})

test('a conflict repair continues when its base only moved forward', () => {
  // vite-hub/vitehub#2550
  assert.match(source, /readOnePage\(`repos\/\$\{repository\}\/compare\/\$\{from\}\.\.\.\$\{to\}\?per_page=1`, "\{status, behind_by\}"/)
  assert.match(source, /if \(!liveBase \|\| liveBase !== preparedMergeBase && !await baseAdvanced\(preparedMergeBase, liveBase\)\) \{/)
})

test('transient GitHub reads and token requests are retried, writes are not', () => {
  // vite-hub/vitehub#2551
  assert.match(source, /return await retryTransient\(\(\) => exec\("gh", args, execOptions\), operation\.signal, isRestRead\(args\)\);/)
  assert.match(source, /auth = await retryTransient\(\(\) => scopedAccess\(/)
  assert.match(source, /if \(rateLimitMessage\(error\)\) return false;/)
})

test('a lockfile the frozen install rejects goes to a model pass on the same head', () => {
  // 2026-10-18: four PRs with broken lockfiles failed about 110 installs overnight and waited for a human push.
  assert.match(source, /await pullRequestInbox\.setMeta\(installDefectKey, \{\n\t+head: inboxClaim\.snapshot\.pr\.head\.sha,/)
  // Local installs throw GitHubWorkspaceInstallError and fleet installs a plain Error; both hand off.
  assert.match(source, /if \(error\.retryable\) wait\.retryAt = Date\.now\(\) \+ 3e5;\n\t+else if \(lockfileDefect\(error\)\) await handInstallDefect\(error, wait\);/)
  assert.match(source, /if \(!lockfileDefect\(error\)\) wait\.retryAt = Date\.now\(\) \+ 3e5;\n\t+else await handInstallDefect\(error, wait\);/)
  // peerDependencyRules only shapes peer resolution; onmax/vite-doctor#271 could not install at all.
  assert.match(source, /"overrides",\n\t"peerDependencyRules",\n\t"minimumReleaseAge",\n\t"minimumReleaseAgeExclude",/)
  assert.match(source, /if \(fleet && !workerSettings\.box && !installDefect\) \{/)
  assert.match(source, /<dependency-install-failure>/)
})

test('a failed dependency install never blocks the pass', () => {
  // 2026-10-18: install is optional. The pass continues without dependencies and the model reads
  // .git/vitehub-install.json; commits after a failed install leave validation to hosted CI.
  assert.match(source, /schedulerEvent\("babysitter\.install\.continued"/)
  assert.match(source, /const verifyDependencies = presetOptions\.install !== false && !fleetPlacement\?\.box && !await installFailed\(providerDirectory\);/)
})

test('a pass interrupted by provider rate limits keeps the same-head budget', () => {
  // 2026-10-18: overnight 429s spent the 3-pass budget of 18 PRs, several of them green, so they
  // waited for a human comment instead of one cheap assessment pass.
  assert.match(source, /\.\.\.modelDispatched && !pushSucceeded && !providerLimited \? \{ progress: \{ kind: "no-progress" \} \} : \{\}/)
  assert.match(source, /onRateLimit\?\.\(\);/)
})

test('a refused update-branch for a stacked PR falls back to the merges API', () => {
  // 2026-10-18: GitHub refused update-branch for #2498 18 times in an hour; it never merged.
  assert.match(source, /if \(\/stacked PR\/i\.test\(message\) && pr\?\.head\?\.ref && pr\?\.base\?\.ref && pr\.head\.repo\?\.full_name === repository\) try \{/)
  assert.match(source, /`repos\/\$\{repository\}\/merges`/)
})

test('a transient network error retries the pass instead of failing it', () => {
  // 2026-10-18: GitHub App token timeouts and TLS disconnects showed up as failed Babysitter runs.
  assert.match(source, /\} else if \(!pushSucceeded && transientNetworkError\(error\)\) \{/)
  assert.match(source, /reason: "network",/)
})

test('a head that already contains the base passes the stale-base overlap gate', () => {
  // 2026-10-18: #2567 was 0 commits behind main, yet update-branch was retried 7 times in an hour.
  assert.match(source, /if \(isRuntimeRecord\(behind\) && behind\.behind === 0\) return \[\];/)
})

test('no deferral waits for the Codex review', () => {
  // 2026-10-19: the Codex-review wait read sourcePushHeads, which claim() empties, so it never ran.
  // Codex reviews in about two minutes, and the running-checks deferral already covers that window.
  assert.doesNotMatch(source, /reviewSettleDeadline|"automated review"/)
})

test('a main repair PR is claimed before every other PR', () => {
  // A red main fails every PR that runs the full suites, so its repair goes first.
  assert.match(source, /ORDER BY \(p\.head_ref LIKE 'babysitter\/repair-main-%'\) DESC,/)
})

test('no PR stays parked until a person acts', () => {
  // 2026-10-19: about 45 PRs sat in external waits for 13+ hours, 30 of them on a vite-doctor
  // install error the host had already fixed, and exhausted heads waited for a human push.
  assert.match(source, /kind: "external",\n\t+reason,\n\t+retryAt: Date\.now\(\) \+ 72e5\n/)
  // A checks wake gets the same retry; only a wait for another PR, which merges or closes, does not.
  assert.match(source, /const otherPullRequest = wake\.kind === "pull-request" && !\([^\n]*wake\.number === observed\.number\);/)
  assert.match(source, /wake,\n\t+\.\.\.otherPullRequest \? \{\} : \{ retryAt: Date\.now\(\) \+ 72e5 \}/)
  assert.match(source, /const progressCooldownMs = 3 \* 36e5;/)
  assert.match(source, /if \(s\.wait\) s\.wait\.retryAt = s\.wait\.retryAt === void 0 \? due : Math\.min\(s\.wait\.retryAt, due\);/)
  assert.match(source, /this\.clock\(\) - \(budget\.exhaustedAt \?\? 0\) >= progressCooldownMs\) s\.progressBudget = \{\n\t+\.\.\.budget,\n\t+count: budget\.limit - 1,/)
})

test('a reviewed head counts as assessed even when the pass parks on an external reason', () => {
  // 2026-10-19: #2279 reported no P0/P1 and reviewedHead on its head three times, but parked
  // "external" on pullfrog-approval, which cleared the assessment, so it never merged.
  assert.match(source, /const assessed = !pushedHead && disposition === "park" && passResult\?\.reviewedHead === pullRequest\.headRefOid/)
  assert.match(source, /\} else if \(!assessed && disposition === "park" && current\?\.pr\?\.head\?\.sha === pullRequest\.headRefOid && passResult\?\.wait\?\.kind === "external"\) \{/)
})

test('repair pushes are capped per PR except for conflict repairs', () => {
  // Review loops reached 23-94 commits per PR (#2596, #2198, #2186).
  assert.match(source, /const repairPushCap = 5;/)
  assert.match(source, /if \(pushes\.length >= repairPushCap && current\.pr\?\.mergeable !== false\) throw new Error\(`Push cap reached/)
  assert.match(source, /await pullRequestInbox\.setMeta\(`repair-pushes:\$\{repository\}#\$\{number\}`, \[/)
})

test('a green PR behind a strict base is updated instead of skipped', () => {
  // 2026-10-19: better-auth requires up-to-date branches; renovate #603 was skipped 19 times an hour.
  assert.match(source, /if \(!pending && !current\.ready && current\.reason === "mergeable_state behind"\) \{/)
})

test('a pass that reviewed the unchanged head keeps its result when events arrived during the pass', async () => {
  // 2026-10-19: 70 of 317 passes ended as unqualified_park because a webhook or snapshot refresh made the
  // claim stale; 34 of 35 sampled had reported the current head as reviewed. Port of vite-hub/vitehub#2631.
  assert.match(source, /const assessed = !pushedHead && disposition === "park" && passResult\?\.reviewedHead === pullRequest\.headRefOid && current\?\.pr\?\.head\?\.sha === pullRequest\.headRefOid && await pullRequestInbox\.holdsClaimedHead\(inboxClaim\);/)
  // The assessment binds the claim-time evidence, so newer feedback or checks still need a pass.
  assert.match(source, /if \(assessed\) await recordAssessment\(inboxClaim\.snapshot, \{\n\t+head: pullRequest\.headRefOid,\n\t+evidenceKey: mergeReviewEvidenceKey\(inboxClaim\.snapshot, waitPolicy\)/)
  // Its wait pins the head; finish() accepts a pinned wait after the generation moved, and still charges the pass once.
  assert.match(source, /\} else if \(assessed\) \{\n\t+outcome = "waiting";\n\t+recorded = await pullRequestInbox\.finish\(inboxClaim, \{\n\t+text: resultText,\n\t+progress: \{ kind: "no-progress" \},\n\t+wait: \{\n\t+\.\.\.createCheckWait\(inboxClaim\.snapshot, waitPolicy\),\n\t+headSha: pullRequest\.headRefOid,/)
  const { p: PullRequestInbox } = await import(join(dist, 'github-inbox-emRhJnWe.js'))
  let now = 1_000
  const head = 'a'.repeat(40)
  const pr = (sha = head) => ({ number: 42, state: 'open', draft: false, title: 't', body: '', user: { login: 'onmax' }, head: { sha, ref: 'feature', repo: { full_name: 'vite-hub/vitehub' } }, base: { sha: '1'.repeat(40), ref: 'main', repo: { full_name: 'vite-hub/vitehub' } } })
  const inbox = new PullRequestInbox({ path: ':memory:', repositories: ['vite-hub/vitehub'], clock: () => now })
  try {
    await inbox.ingest('opened', 'pull_request', { repository: { full_name: 'vite-hub/vitehub' }, action: 'opened', pull_request: pr() })
    const [claim] = await inbox.claim(1)
    await inbox.ingest('comment-during-pass', 'issue_comment', { repository: { full_name: 'vite-hub/vitehub' }, issue: { number: 42, pull_request: {} }, action: 'created', comment: { id: 1, body: 'Looks fine', user: { login: 'review-bot[bot]', type: 'Bot' } } })
    assert.equal(await inbox.isClaimCurrent(claim), false)
    assert.equal(await inbox.holdsClaimedHead(claim), true)
    assert.equal(await inbox.finish(claim, { text: 'Reviewed', progress: { kind: 'no-progress' }, wait: { reason: 'checks', evidenceKey: 'k', headSha: head } }), true)
    assert.equal((await inbox.get('vite-hub/vitehub', 42)).status, 'waiting')
    // A lost lease or a new head discards the result.
    await inbox.ingest('push', 'pull_request', { repository: { full_name: 'vite-hub/vitehub' }, action: 'synchronize', pull_request: pr('b'.repeat(40)) })
    const [next] = await inbox.claim(1)
    if (next) {
      await inbox.ingest('push-2', 'pull_request', { repository: { full_name: 'vite-hub/vitehub' }, action: 'synchronize', pull_request: pr('c'.repeat(40)) })
      assert.equal(await inbox.holdsClaimedHead(next), false)
    }
    now += 3 * 36e5
    assert.equal(await inbox.holdsClaimedHead(claim), false)
  } finally { await inbox.close() }
})

test('after the review push budget, bot feedback and review checks stop waking passes', async () => {
  // 2026-10-19: 72% of pushes were followed by another push within two passes, and 51% of passes had
  // pullfrog-approval as their only failing check. Port of vite-hub/vitehub#2633.
  const { x: wakeReasons, y: repairContextKey, z: reviewPushBudgetWork, k: pushCause } = await import(join(dist, 'server-DZOuXkga.js'))
  const head = 'a'.repeat(40)
  const bot = { login: 'pullfrog[bot]', type: 'Bot' }
  const person = { login: 'onmax', type: 'User' }
  const snapshot = (count: number, extra: { reviews?: object, checks?: object, mergeable?: boolean } = {}) => ({
    repository: 'vite-hub/vitehub',
    number: 7,
    pr: { state: 'open', title: 't', body: 'b', head: { sha: head }, base: { sha: '1'.repeat(40), ref: 'main' }, mergeable: extra.mergeable ?? true, mergeable_state: extra.mergeable === false ? 'dirty' : 'clean' },
    checks: { 1: { id: 1, name: 'ci', app: { id: 1 }, head_sha: head, status: 'completed', conclusion: 'success' }, ...extra.checks },
    statuses: {},
    comments: {},
    reviews: { 1: { id: 1, state: 'COMMENTED', body: 'P2: an older finding', user: bot }, ...extra.reviews },
    reviewComments: {},
    threads: [],
    reviewPushBudget: { count, heads: [head] },
  })
  const policy = {
    workerAuthors: new Set<string>(),
    ignoreFeedbackAuthors: new Set<string>(),
    pendingReviewChecks: new Set(['pullfrog', 'pullfrog-approval']),
    noFindingsReviews: [],
    wakeWhenReady: true,
    reviewPushBudget: 3,
  }
  const wake = (count: number, extra: object, required = 'pending') => wakeReasons({ ...snapshot(count, extra as never), wait: { headSha: head, reason: 'checks', evidenceKey: repairContextKey(snapshot(count), policy), knownFailures: [] } }, required, policy)
  const botReview = { reviews: { 2: { id: 2, state: 'CHANGES_REQUESTED', body: 'P1: another hardening idea', user: bot } } }
  const approvalFailed = { checks: { 2: { id: 2, name: 'pullfrog-approval', app: { id: 2 }, head_sha: head, status: 'completed', conclusion: 'failure' } } }
  // Before the budget is spent, both wake a pass.
  assert.deepEqual(wake(2, botReview), ['feedback-changed'])
  assert.deepEqual(wake(2, approvalFailed), ['new-failure'])
  // After it, neither does; a person, another failing check and a conflict still do.
  assert.deepEqual(wake(3, botReview), [])
  assert.deepEqual(wake(3, approvalFailed), [])
  assert.deepEqual(wake(3, { reviews: { 3: { id: 3, state: 'COMMENTED', body: 'Please rename this.', user: person } } }), ['feedback-changed'])
  assert.deepEqual(wake(3, { checks: { 3: { id: 3, name: 'test', app: { id: 1 }, head_sha: head, status: 'completed', conclusion: 'failure' } } }), ['new-failure'])
  assert.deepEqual(wake(3, { mergeable: false }), ['merge-conflict'])
  assert.deepEqual(wake(3, approvalFailed, 'passed'), ['ready-to-merge'])
  // The host decides whether a push answered review, from the claimed snapshot.
  assert.equal(pushCause(snapshot(0, approvalFailed), policy), 'review')
  assert.equal(pushCause(snapshot(0, { mergeable: false }), policy), 'repair')
  // A spent PR with only bot work left parks; a head someone else pushed still gets a pass.
  assert.deepEqual(reviewPushBudgetWork(snapshot(3, { ...botReview, ...approvalFailed }), policy, new Set()), [])
  assert.deepEqual(reviewPushBudgetWork({ ...snapshot(3), reviewPushBudget: { count: 3, heads: [] } }, policy, new Set()), ['new-head'])
  assert.match(source, /if \(babysitterModelAdmission\(admitted, inboxClaim\.snapshot\)\) return await parkSpentReviewPushBudget\(\) \|\| await parkSpentDailyPassBudget\(\);/)
  assert.match(source, /reason: "review-push-budget"\n/)
  // Pushes are counted on the snapshot in finish(), once per head, even when the wait is rejected.
  assert.match(source, /this\.recordReviewPush\(s, claim, result\.progress\);\n\t+const pinnedHead = result\.wait\?\.headSha;/)
  // The 5-per-24h repair push cap stays as a backstop.
  assert.match(source, /const repairPushCap = 5;/)
})

test('the review push record counts review-driven pushes once per head', async () => {
  const { e: nextReviewPushBudget } = await import(join(dist, 'github-inbox-emRhJnWe.js'))
  const push = (head: string, reviewDriven = true) => ({ kind: 'verified', evidence: `push:${head}`, ...reviewDriven ? { reviewDriven } : {} })
  let budget = nextReviewPushBudget(undefined, 3, push('a'), 'h0')
  budget = nextReviewPushBudget(budget, 3, push('a'), 'h0')
  budget = nextReviewPushBudget(budget, 3, push('b', false), 'a')
  assert.deepEqual(budget, { count: 1, heads: ['a', 'b'] })
  budget = nextReviewPushBudget(nextReviewPushBudget(budget, 3, push('c'), 'b'), 3, push('d'), 'c')
  assert.equal(budget.count, 3)
  // Once spent, a model pass adds its claimed head, so that head is no longer new.
  assert.deepEqual(nextReviewPushBudget(budget, 3, { kind: 'no-progress' }, 'x').heads.at(-1), 'x')
})

test('after the review push budget, a green PR merges despite review bots', async () => {
  const { s: directMergeReadiness, c: feedbackFingerprints } = await import(join(dist, 'babysitter-ZENI2mzg.js'))
  const head = 'a'.repeat(40)
  const snapshot = (reviews: object) => ({
    repository: 'vite-hub/vitehub',
    pr: { state: 'open', draft: false, head: { sha: head, ref: 'fix' }, base: { sha: '1'.repeat(40), ref: 'main', repo: { full_name: 'vite-hub/vitehub' } } },
    checks: { 1: { id: 1, name: 'pullfrog-approval', head_sha: head, status: 'completed', conclusion: 'failure' } },
    statuses: {},
    comments: {},
    reviews,
    reviewComments: {},
    threads: [],
    threadsHydrated: true,
  })
  const botReview = { 2: { id: 2, state: 'COMMENTED', body: 'P1: harden against Proxies', user: { login: 'pullfrog[bot]', type: 'Bot' } } }
  const policy = { pendingReviewChecks: new Set(['pullfrog', 'pullfrog-approval']), assessedFeedback: new Set<string>() }
  const settled = { ...policy, automatedReviewSettled: true }
  assert.equal(directMergeReadiness(snapshot(botReview), 'passed', policy).ready, false)
  assert.deepEqual(directMergeReadiness(snapshot(botReview), 'passed', settled), { ready: true, head })
  // Feedback from people and required checks still gate it.
  const person = { 3: { id: 3, state: 'COMMENTED', body: 'Please keep the old name.', user: { login: 'onmax', type: 'User' } } }
  assert.equal(directMergeReadiness(snapshot(person), 'passed', settled).ready, false)
  assert.equal(directMergeReadiness(snapshot(person), 'passed', { ...settled, assessedFeedback: new Set(feedbackFingerprints(snapshot(person))) }).ready, true)
  assert.equal(directMergeReadiness(snapshot(botReview), 'failed', settled).ready, false)
  assert.match(source, /automatedReviewSettled: reviewPushBudgetSpent\(snapshot, waitPolicy\)/)
})

test('a PR gets at most dailyPassBudget model passes in 24 hours, with exemptions', async () => {
  // Simulated on 2026-10-18: a cap of 16 model passes per PR per day removes about 20% of passes.
  // Port of vite-hub/vitehub#2634.
  const { y: dailyPassResumeAt } = await import(join(dist, 'github-inbox-emRhJnWe.js'))
  const { q: dailyPassExemption } = await import(join(dist, 'server-DZOuXkga.js'))
  const now = 10 * 864e5
  const passes = Array.from({ length: 16 }, (_, index) => now - (16 - index) * 6e4)
  assert.equal(dailyPassResumeAt({ passes: passes.slice(1), exemptions: [] }, 16, now), undefined)
  assert.equal(dailyPassResumeAt({ passes, exemptions: [] }, 16, now), passes[0] + 864e5)
  const head = 'a'.repeat(40)
  const s = (extra: object = {}) => ({ pr: { head: { sha: head }, base: { sha: '1'.repeat(40) }, mergeable: true }, checks: {}, statuses: {}, threads: [], humanFeedbackGeneration: 4, ...extra })
  assert.equal(dailyPassExemption(s(), 'passed', { passes, human: 3, exemptions: [] }), 'human-feedback')
  assert.equal(dailyPassExemption(s(), 'passed', { passes, human: 4, exemptions: [] }), undefined)
  assert.equal(dailyPassExemption(s(), 'failed', { passes, human: 4, exemptions: [] }), `required-failure:${head}`)
  assert.equal(dailyPassExemption(s(), 'failed', { passes, human: 4, exemptions: [`required-failure:${head}`] }), undefined)
  assert.equal(dailyPassExemption(s({ pr: { head: { sha: head }, base: { sha: '1'.repeat(40) }, mergeable: false } }), 'passed', { passes, human: 4, exemptions: [] }), `conflict:${head}:${'1'.repeat(40)}`)
  // Counted on the snapshot once per pass, right before the model starts; the park names the resume time.
  assert.match(source, /if \(!modelDispatched && dailyPassBudget !== false\) await pullRequestInbox\.recordModelPass\(inboxClaim, /)
  assert.match(source, /reason: "daily-pass-budget",\n\t+retryAt: resumeAt/)
  assert.match(source, /parked: budgetParks\(queue\)/)
})

test('an assessed head merges past failing review checks without an exact evidence key', () => {
  // 2026-10-19: #2156 took three passes on one head; each assessed it, but the stored evidence key
  // never matched again, so "current-head failures need assessment" repeated until the budget ran out.
  assert.match(source, /const reviewChecksAssessed = failedChecks && !nonReviewFailure && !unassessed && hasRuntimeType\(assessment\.reviewedEvidenceKey, "string"\);/)
  assert.match(source, /if \(\(failedChecks \|\| unassessed\) && !reviewChecksAssessed && !matchesMergeReviewEvidence\(/)
})

test('reconcile deliveries of unchanged reviews keep their ID across probes', () => {
  // 2026-10-19: the ID hashed the embedded PR, so each probe re-stored every review and comment
  // (27k deliveries, 500 MB an hour); the state DB reached 18 GB and reads stalled the main thread.
  assert.match(source, /const identity = event === "pull_request" \|\| !pr \? full : \{\n\t+\.\.\.full,\n\t+pull_request: \{\n\t+number: pr\.number,\n\t+head: pr\.head\?\.sha\n/)
  assert.match(source, /const id = `reconcile:\$\{createHash\("sha256"\)\.update\(JSON\.stringify\(\[event, identity\]\)\)\.digest\("hex"\)\}`;/)
})

test('a reviewed head with failing required checks waits only while the push cap blocks its repair', () => {
  // 2026-10-19: five PRs had a repair refused by the push cap, reported the head as reviewed, and
  // then took the reviewed-head shortcut every two minutes without ever getting the repair pass.
  assert.match(source, /if \(await requiredCheckState\(inboxClaim\.snapshot\) === "failed"\) \{/)
  assert.match(source, /reviewedRetryAt = pushes\.length >= repairPushCap \? Math\.min\(\.\.\.pushes\) \+ 864e5 \+ 6e4 : void 0;/)
  assert.match(source, /if \(reviewedRetryAt !== void 0 && isRuntimeRecord\(assessment\) && assessment\.version === 2/)
})

test('new checks and bot reviews do not reject a pass, and a real evidence change ends it at once', () => {
  // 2026-10-19: about 51% of passes had a write rejected as "evidence changed" by a check run or bot
  // review that landed mid-pass, then spent about four more tool calls before ending.
  const key = source.slice(source.indexOf('const repairEvidenceKey = (snapshot) => {'), source.indexOf('let observePendingPush;'))
  assert.match(key, /head: head === pullRequest\.headRefOid/)
  assert.match(key, /base: base && \{\n\t+ref: base\.ref,/)
  assert.match(key, /filter\(\(\[id\]\) => handledThreads\.has\(id\) \|\| ownedResolutions\.has\(id\)\)/)
  assert.doesNotMatch(key, /checks|statuses|reviews|comments|mergeReviewEvidenceKey/)
  assert.match(source, /const handledThreads = new Set\(inboxClaim\.snapshot\.threads\.filter\(\(thread\) => thread\.isResolved !== true\)/)
  // The first rejection aborts the pass, so the claim requeues like a changed base.
  assert.match(source, /const changed = new DOMException\("Pull request evidence changed\.", "AbortError"\);\n(?:[^\n]*\n){5}\t+passController\.abort\(changed\);\n\t+throw changed;/)
  // Read-only tools only check the lease.
  assert.match(source, /command: async \(args, request\) => \{\n\t+await \(readOperation\.getStore\(\) \? assertLeaseHeld\(\) : assertLease\(\)\);/)
  assert.match(source, /"readCheckLogs",\n\t+"readBaseCheckEvidence",\n\t+"readBaseCheckLogs"\n\t+\]\) \{\n\t+const read = operations\[name\];\n\t+operations\[name\] = \(\.\.\.args\) => readOperation\.run\(true, \(\) => read\(\.\.\.args\)\);/)
  // Merges still re-read required checks and the live PR before merging.
  assert.match(source, /const evaluation = evaluateGitHubRequiredChecks\(policy, snapshotCheckEvidence\(snapshot\)\);/)
  assert.match(source, /const current = liveMergeReadiness\(live, decision\.head\);/)
})
