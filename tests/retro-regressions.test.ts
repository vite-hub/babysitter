// Smoke checks for the upstream Babysitter preview. Detailed behavior tests
// live with @vite-hub/agent; these checks only verify the published package
// exposes the operational contracts this service relies on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let modules = dirname(realpathSync(fileURLToPath(import.meta.resolve('vite-hub/agent'))))
while (!modules.endsWith('/node_modules')) modules = dirname(modules)
const dist = join(modules, '@vite-hub/agent/dist')
const source = readdirSync(dist).filter(name => name.endsWith('.js')).map(name => readFileSync(join(dist, name), 'utf8')).join('\n')

test('published Babysitter keeps the durable wait and review contract', () => {
  assert.match(source, /set wait\.kind to "checks" and wait\.headSha to the current HEAD SHA/)
  assert.match(source, /set reviewedHead to the current HEAD SHA/)
})

test('published checkout code uses complete source history', () => {
  assert.match(source, /"--no-checkout"/)
  assert.doesNotMatch(source, /--filter=blob:none/)
  assert.doesNotMatch(source, /generated\[\^\/\]\*\$/)
})

test('published CI recovery and admission guards are present', () => {
  assert.match(source, /function diagnosticExcerpt\(/)
  assert.match(source, /function rerunFailedActions\(/)
  assert.match(source, /function babysitterAdmissionDecision\(/)
  assert.match(source, /function readInvocationInputTokens\(/)
  assert.match(source, /admission-skipped/)
})

test('published scheduler preserves active repairs across new webhook evidence', () => {
  // The published host still uses this error for a genuinely changed head.
  // The regression is the old generation-only abort, which also interrupted
  // the worker's own pushed repair before it could finish.
  assert.doesNotMatch(source, /current\.generation !== inboxClaim\.generation\) throw new DOMException\("Pull request evidence changed\./)
  assert.match(source, /const selfHead = observedHead !== pullRequest\.headRefOid && verifiedPushHeads\.has\(observedHead \?\? ""\)/)
  assert.match(source, /current\.generation !== inboxClaim\.generation && !\(\(selfHead \|\| repairOperation\.getStore\(\)\) && repairEvidenceKey\(current\) === repairEvidenceKey\(inboxClaim\.snapshot, current\)\)/)
  assert.match(source, /function claimStopReason\(/)
  assert.match(source, /stackBlocked/)
})
