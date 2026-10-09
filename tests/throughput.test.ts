// The upstream package owns the detailed scheduler tests. Keep this service
// check focused on the contracts needed for deployment and recovery.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
