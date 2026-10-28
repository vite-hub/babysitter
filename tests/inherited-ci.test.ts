import { test } from 'node:test'
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let modules = dirname(realpathSync(fileURLToPath(import.meta.resolve('vite-hub/agent'))))
while (!modules.endsWith('/node_modules')) modules = dirname(modules)
const dist = join(modules, '@vite-hub/agent/dist')
const { s: directMergeReadiness } = await import(join(dist, 'babysitter-ZENI2mzg.js'))
const { fa: failedOwnActions, sf: sameActionFailure, ic: inheritedCheckEvaluation, bs: inheritedBypassSafety, am: requestAsyncMerge, mf: matchingActionFailure, pf: parseFailedActionOutput } = await import(join(dist, 'server-DZOuXkga.js'))
const head = 'a'.repeat(40)
const check = (id: number, name: string, conclusion = 'failure') => ({
  id, name, head_sha: head, status: 'completed', conclusion,
  app: { id: 1, slug: 'github-actions' },
  html_url: `https://github.com/o/r/actions/runs/${id}/job/${id}`,
})
const snapshot = (checks = [check(1, 'ci / build')]) => ({
  repository: 'o/r', number: 1,
  pr: { state: 'open', draft: false, head: { sha: head, ref: 'feature' }, base: { ref: 'main' } },
  checks: Object.fromEntries(checks.map(value => [value.id, value])),
  statuses: {}, comments: {}, reviews: {}, reviewComments: {}, threads: [], threadsHydrated: true,
})

test('a proven inherited failure does not require another assessment to merge', () => {
  assert.deepEqual(directMergeReadiness(snapshot(), 'passed', { inheritedCheckIds: new Set([1]) }), { ready: true, head })
})

test('own CI excludes only the exact inherited run, keeping PR regressions blocked', () => {
  assert.deepEqual(failedOwnActions(snapshot(), new Set(), new Set([1])), [])
  assert.deepEqual(failedOwnActions(snapshot([check(1, 'ci / build'), check(2, 'ci / test')]), new Set(), new Set([1])), ['ci / test'])
  assert.deepEqual(failedOwnActions(snapshot([check(2, 'ci / build')]), new Set(), new Set([1])), ['ci / build'])
})

test('inherited CI does not waive required checks or unassessed review feedback', () => {
  const policy = { inheritedCheckIds: new Set([1]) }
  assert.equal(directMergeReadiness(snapshot(), 'failed', policy).ready, false)
  const reviewed = { ...snapshot(), comments: { 4: { id: 4, body: 'Please fix this regression.', user: { login: 'maintainer' } } } }
  assert.equal(directMergeReadiness(reviewed, 'passed', policy).ready, false)
  assert.equal(directMergeReadiness(snapshot([check(2, 'ci / test')]), 'passed', policy).ready, false)
})

test('matching job names cannot hide different failures or unavailable logs', () => {
  const failure = (lines: string[], step = 'Run pnpm test') => ({ step, lines: new Set(lines) })
  const baseline = failure(['Error: existing main failure', 'another baseline failure'])
  assert.equal(sameActionFailure(failure(['Error: existing main failure']), baseline), true)
  assert.equal(sameActionFailure(failure(['Error: existing main failure', 'Error: PR regression']), baseline), false)
  assert.equal(sameActionFailure(failure(['Error: existing main failure'], 'Run pnpm build'), baseline), false)
  assert.equal(sameActionFailure(undefined, baseline), false)
  assert.equal(sameActionFailure(baseline, undefined), false)
  assert.equal(sameActionFailure(failure([]), baseline), false)
})

const requiredPolicy = {
  repository: 'vite-hub/vitehub', branch: 'main', status: 'known',
  required: [{ context: 'ci', appId: 1 }, { context: 'publish preview packages', appId: 1 }],
}
const protectedSnapshot = (checks = [check(1, 'ci'), check(2, 'publish preview packages', 'success')]) => ({
  ...snapshot(checks.map(value => ({ ...value, html_url: value.html_url.replace('/o/r/', '/vite-hub/vitehub/') }))),
  repository: 'vite-hub/vitehub',
})

test('only the authorized required checks on ViteHub main accept inherited failure evidence', () => {
  const evaluate = (value: ReturnType<typeof snapshot>, ids = [1], policy = requiredPolicy) => inheritedCheckEvaluation(value, policy, new Set(ids), new Set())
  const inherited = evaluate(protectedSnapshot())
  assert.equal(inherited.state, 'passed')
  assert.deepEqual(inherited.bypassedRequiredChecks, ['ci'])
  assert.equal(evaluate(protectedSnapshot(), []).state, 'failed')
  assert.equal(evaluate(protectedSnapshot([check(1, 'ci'), check(2, 'publish preview packages')]), [1]).state, 'failed')
  assert.equal(evaluate(protectedSnapshot([check(1, 'ci'), check(2, 'publish preview packages')]), [1, 2]).state, 'passed')
  assert.equal(evaluate(protectedSnapshot([check(1, 'ci'), check(2, 'publish preview packages', 'success'), check(3, 'ci / tests')])).state, 'failed')
  const otherCheck = { ...requiredPolicy, required: [...requiredPolicy.required, { context: 'security', appId: 1 }] }
  assert.equal(evaluate(protectedSnapshot([check(1, 'ci'), check(2, 'publish preview packages', 'success'), check(3, 'security')]), [1, 3], otherCheck).state, 'failed')
  assert.equal(evaluate(protectedSnapshot(), [1], { ...requiredPolicy, status: 'unknown' }).state, 'unknown')
  assert.equal(evaluate(snapshot([check(1, 'ci'), check(2, 'publish preview packages', 'success')]), [1], { ...requiredPolicy, repository: 'o/r' }).state, 'failed')
  const next = protectedSnapshot()
  next.pr.base.ref = 'next'
  assert.equal(evaluate(next, [1], { ...requiredPolicy, branch: 'next' }).state, 'failed')
})

test('new runs, app bindings, status failures and pending checks cannot be waived', () => {
  const run = protectedSnapshot([check(3, 'ci'), check(2, 'publish preview packages', 'success')])
  assert.equal(inheritedCheckEvaluation(run, requiredPolicy, new Set([1]), new Set()).state, 'failed')
  const wrongApp = protectedSnapshot([{ ...check(1, 'ci'), app: { id: 2, slug: 'github-actions' } }, check(2, 'publish preview packages', 'success')])
  assert.equal(inheritedCheckEvaluation(wrongApp, requiredPolicy, new Set([1]), new Set()).state, 'pending')
  const withStatus = { ...protectedSnapshot(), statuses: { 9: { id: 9, sha: head, context: 'ci', state: 'failure' } } }
  assert.equal(inheritedCheckEvaluation(withStatus, requiredPolicy, new Set([1]), new Set()).state, 'failed')
  const pending = protectedSnapshot([check(1, 'ci'), { ...check(2, 'publish preview packages'), status: 'in_progress', conclusion: '' }])
  assert.equal(inheritedCheckEvaluation(pending, requiredPolicy, new Set([1, 2]), new Set()).state, 'pending')
})

const protection = {
  required_status_checks: { strict: false }, lock_branch: { enabled: false }, required_signatures: { enabled: false },
}
const safety = {
  protection, rules: [], reviewDecision: null, threadsResolved: true, method: 'squash', upToDate: true,
}

test('the inherited-check bypass preserves other branch protections', () => {
  assert.equal(inheritedBypassSafety(safety), true)
  assert.notEqual(inheritedBypassSafety({ ...safety, reviewDecision: 'CHANGES_REQUESTED' }), true)
  assert.notEqual(inheritedBypassSafety({ ...safety, protection: { ...protection, required_pull_request_reviews: { required_approving_review_count: 1 } } }), true)
  assert.equal(inheritedBypassSafety({ ...safety, reviewDecision: 'APPROVED', protection: { ...protection, required_pull_request_reviews: { required_approving_review_count: 1 } } }), true)
  assert.notEqual(inheritedBypassSafety({ ...safety, threadsResolved: false, protection: { ...protection, required_conversation_resolution: { enabled: true } } }), true)
  assert.notEqual(inheritedBypassSafety({ ...safety, upToDate: false, protection: { ...protection, required_status_checks: { strict: true } } }), true)
  assert.notEqual(inheritedBypassSafety({ ...safety, method: 'merge', protection: { ...protection, required_linear_history: { enabled: true } } }), true)
  assert.notEqual(inheritedBypassSafety({ ...safety, protection: { ...protection, lock_branch: { enabled: true } } }), true)
  assert.notEqual(inheritedBypassSafety({ ...safety, protection: { ...protection, required_signatures: { enabled: true } } }), true)
  assert.notEqual(inheritedBypassSafety({ ...safety, protection: { ...protection, restrictions: { users: ['someone'] } } }), true)
  assert.notEqual(inheritedBypassSafety({ ...safety, rules: [{ type: 'merge_queue' }] }), true)
  assert.notEqual(inheritedBypassSafety({ ...safety, rules: [{ type: 'required_deployments' }] }), true)
  assert.notEqual(inheritedBypassSafety({ ...safety, rules: [{ type: 'pull_request', parameters: { allowed_merge_methods: ['merge'] } }] }), true)
  assert.equal(inheritedBypassSafety({ ...safety, rules: [{ type: 'pull_request', parameters: { allowed_merge_methods: ['squash'] } }] }), true)
  assert.notEqual(inheritedBypassSafety({ ...safety, rules: [{ type: 'new_unknown_rule' }] }), true)
  assert.notEqual(inheritedBypassSafety({ ...safety, protection: undefined }), true)
})

test('the merge request binds the bypass flag and exact head to GitHub’s receipt', async () => {
  const calls: string[][] = []
  const uuid = '11111111-1111-1111-1111-111111111111'
  const command = async (args: string[]) => {
    calls.push(args)
    return { stdout: JSON.stringify({ status: 'pending', details: {
      uuid, expected_head_sha: head, merge_method: 'squash', merge_action: 'direct_merge', bypass_rules: args.includes('bypass_rules=true'),
    } }) }
  }
  await requestAsyncMerge({ command }, 'vite-hub/vitehub', 1, head, 'squash', undefined)
  await requestAsyncMerge({ command }, 'vite-hub/vitehub', 1, head, 'squash', undefined, true)
  assert.ok(calls[0]?.includes('bypass_rules=false'))
  assert.ok(calls[1]?.includes('bypass_rules=true'))
  const wrongReceipt = { command: async () => ({ stdout: JSON.stringify({ status: 'pending', details: {
    uuid, expected_head_sha: 'b'.repeat(40), merge_method: 'squash', merge_action: 'direct_merge', bypass_rules: true,
  } }) }) }
  await assert.rejects(requestAsyncMerge(wrongReceipt, 'vite-hub/vitehub', 1, head, 'squash', undefined, true), /authorized request/)
  await assert.rejects(requestAsyncMerge({ command: async () => command(['bypass_rules=false']) }, 'vite-hub/vitehub', 1, head, 'squash', undefined, true), /authorized request/)
})

test('failure evidence uses Actions job IDs, which differ from check-run IDs', async () => {
  const own = { ...check(1, 'ci'), html_url: 'https://github.com/o/r/actions/runs/50/job/500' }
  const base = { ...check(2, 'ci'), html_url: 'https://github.com/o/r/actions/runs/60/job/600' }
  const calls: number[] = []
  const output = { step: 'Run pnpm build', lines: new Set(['Error: existing baseline failure']) }
  const read = async (jobId: number) => { calls.push(jobId); return output }
  assert.equal(await matchingActionFailure('o/r', own, base, read), true)
  assert.deepEqual(calls, [500, 600])
  assert.equal(await matchingActionFailure('o/r', own, { ...base, html_url: 'https://github.com/o/r/actions/runs/60' }, read), false)
  assert.equal(await matchingActionFailure('o/r', own, { ...base, app: { slug: 'another-app' } }, read), false)
  assert.equal(await matchingActionFailure('o/r', own, base, async () => undefined), false)
})

test('failure comparison uses command output, excluding shell metadata and the generic exit code', () => {
  const log = (output: string[], shell = 'bash') => [
    '##[group]Run pnpm build', `shell: ${shell}`, 'env:', '  CI: true', '##[endgroup]',
    ...output, '##[error]Process completed with exit code 1.',
  ].map(line => `2026-10-28T16:00:00.000Z ${line}`).join('\n')
  const baseline = parseFailedActionOutput(log(['Error: duplicate import']))
  assert.deepEqual(baseline.lines, new Set(['Error: duplicate import']))
  assert.equal(sameActionFailure(parseFailedActionOutput(log(['Error: duplicate import'], 'zsh')), baseline), true)
  assert.equal(sameActionFailure(parseFailedActionOutput(log(['Error: new PR failure'])), baseline), false)
  assert.equal(sameActionFailure(parseFailedActionOutput(log([])), baseline), false)
  assert.equal(parseFailedActionOutput('truncated output'), undefined)
})
