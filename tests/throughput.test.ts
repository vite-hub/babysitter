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

test('provider breaker ignores malformed JSON and recognizes HTTP rate limits', () => {
  assert.equal(isProviderRateLimit(new Error('Command failed: gh api --paginate ... unexpected end of JSON input')), false)
  assert.equal(isProviderRateLimit(new Error('GitHub API returned HTTP 429 Too Many Requests')), true)
})
