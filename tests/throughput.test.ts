// Throughput rules of the patched Babysitter preset: merges without a model pass,
// deferred passes while gates run, and evidence from the newest check runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let modules = dirname(realpathSync(fileURLToPath(import.meta.resolve('vite-hub/agent'))))
while (!modules.endsWith('/node_modules')) modules = dirname(modules)
const dist = join(modules, '@vite-hub/agent/dist')
const chunks = readdirSync(dist).filter(name => name.endsWith('.js')).map(name => ({ name, source: readFileSync(join(dist, name), 'utf8') }))
const chunk = (marker: string) => {
  const found = chunks.find(({ source }) => source.includes(marker))
  assert.ok(found, `no agent chunk contains ${marker}`)
  return found
}

// The preset chunk imports a virtual registry, so evaluate the merge region on its own.
const preset = chunk('function feedbackFingerprints(').source
const region = preset.slice(preset.indexOf('//#region src/presets/babysitter/merge.ts'), preset.indexOf('//#region src/presets/babysitter-definition.ts'))
const isRuntimeRecord = (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value)
const hasRuntimeType = (value: unknown, type: string) => typeof value === type
const gate = new Function('createHash', 'isRuntimeRecord', 'hasRuntimeType', `${region}\nreturn { directMergeReadiness, feedbackFingerprints };`)(createHash, isRuntimeRecord, hasRuntimeType)

const head = 'a'.repeat(40)
function snapshot(extra: Record<string, unknown> = {}) {
  return {
    repository: 'acme/app',
    pr: { state: 'open', head: { sha: head }, base: { ref: 'main' }, title: 'Fix', body: '' },
    checks: { 'check_run:1': { id: 1, head_sha: head, name: 'ci', app: { id: 15368 }, status: 'completed', conclusion: 'success' } },
    statuses: {},
    comments: {},
    reviews: {},
    reviewComments: {},
    threads: [],
    threadsHydrated: true,
    ...extra,
  }
}
const policy = {
  pendingReviewChecks: new Set(['reviewer']),
  workerAuthors: new Set(['worker[bot]']),
  ignoreFeedbackAuthors: new Set(['preview[bot]']),
  noFindingsReviews: ['> ✅ No new issues found.'],
}

test('no-findings verdicts, preview bots and the worker\'s own notes merge without a pass', () => {
  const s = snapshot({
    reviews: { 1: { id: 1, state: 'COMMENTED', body: '> ✅ No new issues found.\n\nReviewed.', user: { login: 'reviewer[bot]', type: 'Bot' } } },
    comments: { 2: { id: 2, body: 'Preview ready', user: { login: 'preview[bot]', type: 'Bot' } } },
    reviewComments: { 3: { id: 3, body: 'Fixed in abc123.', user: { login: 'worker[bot]', type: 'Bot' } } },
  })
  assert.deepEqual(gate.directMergeReadiness(s, 'passed', policy), { ready: true, head })
})

test('a finding needs an assessment until a pass covers it, also on later heads', () => {
  const finding = { 4: { id: 4, state: 'COMMENTED', body: 'P2: handle the empty cursor', user: { login: 'reviewer[bot]', type: 'Bot' } } }
  const s = snapshot({ reviews: finding })
  assert.equal(gate.directMergeReadiness(s, 'passed', policy).ready, false)
  const assessedFeedback = new Set(gate.feedbackFingerprints(s, policy))
  const nextHead = snapshot({ reviews: finding, pr: { ...s.pr, head: { sha: 'b'.repeat(40) } } })
  nextHead.checks['check_run:1'].head_sha = 'b'.repeat(40)
  assert.equal(gate.directMergeReadiness(nextHead, 'passed', { ...policy, assessedFeedback }).ready, true)
  const another = { ...finding, 5: { id: 5, state: 'COMMENTED', body: 'P1: new defect', user: { login: 'reviewer[bot]', type: 'Bot' } } }
  assert.equal(gate.directMergeReadiness(snapshot({ reviews: another }), 'passed', { ...policy, assessedFeedback }).ready, false)
})

test('bot activity comment edits keep an assessment; requested changes always count', () => {
  const panel = (body: string) => ({ 6: { id: 6, body, user: { login: 'summary[bot]', type: 'Bot' } } })
  const assessedFeedback = new Set(gate.feedbackFingerprints(snapshot({ comments: panel('Reviewing…') }), policy))
  assert.equal(gate.directMergeReadiness(snapshot({ comments: panel('Done reviewing') }), 'passed', { ...policy, assessedFeedback }).ready, true)
  const blocked = snapshot({ reviews: { 7: { id: 7, state: 'CHANGES_REQUESTED', body: '', user: { login: 'maintainer', type: 'User' } } } })
  assert.equal(gate.directMergeReadiness(blocked, 'passed', policy).ready, false)
})

test('a rerun replaces the failed run in merge evidence', () => {
  const s = snapshot({
    checks: {
      'check_run:1': { id: 1, head_sha: head, name: 'ci', app: { id: 15368 }, status: 'completed', conclusion: 'failure' },
      'check_run:2': { id: 2, head_sha: head, name: 'ci', app: { id: 15368 }, status: 'completed', conclusion: 'success' },
    },
  })
  assert.deepEqual(gate.directMergeReadiness(s, 'passed', policy), { ready: true, head })
})

test('unprotected branches wait for the newest run of every current-head check', async () => {
  const github = await import(pathToFileURL(join(dist, chunk('for (const value of evidence.checkRuns)').name)).href)
  const evaluate = Object.values(github).find((value): value is Function => typeof value === 'function' && value.name === 'evaluateGitHubRequiredChecks')
  assert.ok(evaluate)
  const policyKnown = { status: 'known', repository: 'acme/app', branch: 'main', required: [] }
  const evidence = (runs: Array<Record<string, unknown>>) => ({ repository: 'acme/app', branch: 'main', headSha: head, checkRuns: runs, statuses: [] })
  const abandoned = { id: 10, head_sha: head, name: 'Workers Builds', app: { id: 1 }, status: 'in_progress', conclusion: null }
  const finished = { id: 11, head_sha: head, name: 'Workers Builds', app: { id: 1 }, status: 'completed', conclusion: 'success' }
  assert.equal(evaluate(policyKnown, evidence([abandoned, finished])).state, 'passed')
  assert.equal(evaluate(policyKnown, evidence([abandoned])).state, 'pending')
})

test('the preset instructions state the repository-guidance sentence once', () => {
  const sentence = 'The checkout AGENTS.md contains these generated instructions'
  assert.equal(preset.split(sentence).length - 1, 1)
})

test('the scheduler defers passes, claims stack parents first and releases leases at startup', () => {
  const host = chunk('async function pendingGateDeferral(').source
  assert.match(host, /reason: `deferred:\$\{deferral\}`/)
  assert.match(host, /inbox\.releaseLeases\(\)/)
  const inbox = chunk('async releaseLeases()').source
  assert.match(inbox, /ORDER BY \(SELECT COUNT\(\*\) FROM \$\{t\.pullRequests\} c WHERE c\.scope=p\.scope AND c\.repository=p\.repository AND c\.state='open' AND c\.base_ref=p\.head_ref\) DESC/)
})

test('a paused admission still claims PRs for host-only merges and waits', () => {
  const host = chunk('const hostOnlyChecked = ').source
  assert.match(host, /if \(!modelAdmission\) \{\n\t+await pullRequestInbox\.release\(inboxClaim\);/)
  // Host-only work must run before the model pass is skipped: merge, reviewed-head park, deferral.
  assert.ok(host.indexOf('const deferral = await pendingGateDeferral(') < host.indexOf('if (!modelAdmission) {\n'))
  assert.match(chunk('if (options.skip?.(s)) continue;').source, /async claim\(limit, options = \{\}\)/)
})

test('pass prompts keep only the newest run per check and drop passing check output', () => {
  const source = chunk('const newestChecks = ').source
  assert.match(source, /checks: knownChecks\.map\(\(value\) => passed\(value\) \? \{\n\t+id: value\.id,\n\t+name: value\.name,\n\t+conclusion: value\.conclusion,\n\t+app: value\.app\?\.slug\n\t+\} :/)
})

test('a zero token budget pauses every claim; a spent budget only pauses model passes', () => {
  const host = chunk('function babysitterAdmissionDecision(').source
  const decide = host.match(/function babysitterAdmissionDecision\([\s\S]*?\n}\n/)?.[0]
  assert.ok(decide)
  const decision = new Function(`${decide}\nreturn babysitterAdmissionDecision;`)()
  const windows = { hourEnd: 1, dayEnd: 2 }
  const limits = { minFreeTmpBytes: 0, hourlyInputTokens: 15e6, dailyInputTokens: 2e8, proxyMaxWeeklyPercent: 80, proxyProvider: 'codex' }
  assert.deepEqual(decision({ windows, hourlyInputTokens: 0 }, { ...limits, hourlyInputTokens: 0 }).hostOnly, false)
  const spent = decision({ windows, hourlyInputTokens: 16e6 }, limits)
  assert.equal(spent.accepting, false)
  assert.equal(spent.hostOnly, true)
  assert.match(host, /if \(!admission\.hostOnly\) return;/)
})
