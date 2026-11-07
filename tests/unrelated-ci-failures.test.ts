// 2026-11-05: vitehub#3024 and comark-ui#351 spent their repair pushes on CI failures their changes
// did not cause. A check that fails the same way on the base, or a runner or network error, gets no
// repair pass; a failure the PR may have caused still does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let modules = dirname(realpathSync(fileURLToPath(import.meta.resolve('vite-hub/agent'))))
while (!modules.endsWith('/node_modules')) modules = dirname(modules)
const server = join(modules, '@vite-hub/agent/dist/server-DZOuXkga.js')
const { il: infrastructureFailureLine, uw: unrelatedFailureWait, jf: jobFailureFacts } = await import(server)
const source = readFileSync(server, 'utf8')

const log = (...lines: string[]) => lines.map(line => `2026-11-05T09:30:00.0000000Z ${line}`).join('\n')

test('runner and network errors are infrastructure', () => {
  for (const line of [
    '##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.',
    '##[error]The self-hosted runner: slimbook-3 lost communication with the server.',
    ' ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/vite: request to https://registry.npmjs.org/vite failed, reason: socket hang up',
    ' ERR_PNPM_FETCH_503  GET https://registry.npmjs.org/typescript/-/typescript-6.0.3.tgz: Service Unavailable - 503',
    "fatal: unable to access 'https://github.com/vite-hub/vitehub/': The requested URL returned error: 502",
    'npm error code ECONNRESET',
    // denoland/setup-deno on vitehub job 127338610593, 2026-11-05.
    '##[error]Error: Unexpected HTTP response: 504',
  ]) assert.equal(infrastructureFailureLine(log('##[group]Run pnpm install', line, '##[error]Process completed with exit code 1.')), line.trim().replace('##[error]', ''), line)
})

test('failures a PR can cause are not infrastructure', () => {
  for (const line of [
    ' FAIL  test/channel-task-enqueue.test.ts > enqueues a task\nError: Test timed out in 5000ms.',
    'Error: connect ECONNREFUSED 127.0.0.1:3000',
    "src/index.ts(4,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    ' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json',
  ]) assert.equal(infrastructureFailureLine(log(line, '##[error]Process completed with exit code 1.')), undefined, line)
})

test('a PR whose failures it did not cause waits without a pass', () => {
  const now = 1_000_000
  const inherited = unrelatedFailureWait([{ name: 'ci / test', cause: 'inherited' }], 'main', now)
  assert.equal(inherited.reason, 'No repair pass: this PR did not cause its failing checks. ci / test fails the same way on main; the host retests this PR when main passes.')
  assert.equal(inherited.retryAt, now + 15 * 60_000)
  const runner = unrelatedFailureWait([{ name: 'ci / build', cause: 'infrastructure', line: 'npm error code ECONNRESET' }], 'main', now)
  assert.match(runner.reason, /ci \/ build \(npm error code ECONNRESET\) hit a runner or network error; a rerun of the job clears it\.$/)
  // The rerun sends a check webhook, so a runner error alone needs no timed retry.
  assert.equal(runner.retryAt, undefined)
  const both = unrelatedFailureWait([{ name: 'ci / test', cause: 'inherited' }, { name: 'ci / build', cause: 'infrastructure', line: 'x' }], 'main', now)
  assert.deepEqual(both.checks, ['ci / test', 'ci / build'])
})

test('one failure the PR may have caused still gets a repair pass', () => {
  assert.equal(unrelatedFailureWait([], 'main'), undefined)
  assert.equal(unrelatedFailureWait([{ name: 'ci / test', cause: 'inherited' }, { name: 'ci / lint', cause: 'pr' }], 'main'), undefined)
})

test("a gate job that only reports other jobs' results takes their cause", () => {
  // vitehub's required `ci` job on run 42054370582, 2026-11-05.
  const gate = log("##[group]Run node <<'NODE'", '##[endgroup]', 'package-tests: failure', 'package-tests-success: skipped', '##[error]Process completed with exit code 1.', 'Cleaning up orphan processes')
  assert.deepEqual(jobFailureFacts(gate), { infrastructure: undefined, gate: true })
  const tests = log('##[group]Run pnpm test', '##[endgroup]', ' FAIL  test/a.test.ts', '##[error]Process completed with exit code 1.')
  assert.deepEqual(jobFailureFacts(tests), { infrastructure: undefined, gate: false })
  const runner = { name: 'package tests', runId: 1, cause: 'infrastructure', line: '##[error]Error: Unexpected HTTP response: 504' }
  const ci = { name: 'ci', runId: 1, cause: 'pr', gate: true }
  assert.deepEqual(unrelatedFailureWait([runner, ci], 'main').checks, ['package tests'])
  // Alone, or beside a failure from another run, a failed gate still counts as the PR's.
  assert.equal(unrelatedFailureWait([ci], 'main'), undefined)
  assert.equal(unrelatedFailureWait([{ ...runner, runId: 2 }, ci], 'main'), undefined)
  assert.equal(unrelatedFailureWait([{ ...runner, cause: 'pr' }, ci], 'main'), undefined)
})

test('the unrelated-failure park runs before any budget park and before the model starts', () => {
  const has = (pattern: RegExp, message: string) => assert.ok(pattern.test(source), message)
  has(/return await parkUnrelatedFailures\(\) \|\| await parkSpentReviewPushBudget\(\) \|\| await parkClosedPushWindow\(\) \|\| await parkSpentDailyPassBudget\(\);/, 'checked first in parkBlockedModelWork')
  has(/const parkUnrelatedFailures = async \(\) => \{\n\t+if \(modelDispatched \|\| pushedHead \|\| merge\.mode !== "direct"\) return false;/, 'only before the first dispatch')
  has(/if \(await requiredCheckState\(snapshot\) !== "failed"\) return false;\n\t+const unrelated = unrelatedFailureWait\(await failureCauses\(snapshot, passSignal\)/, 'only when the gates fail')
  // The park records no progress kind, so it spends neither the no-progress nor the push budget.
  const park = source.slice(source.indexOf('const parkUnrelatedFailures'), source.indexOf('const reviewDrivenPush'))
  assert.doesNotMatch(park, /progress:|repair-pushes|recordModelPass/)
})
