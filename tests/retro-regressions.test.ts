// Smoke checks for the upstream Babysitter preview. Detailed behavior tests
// live with @vite-hub/agent; these checks only verify the published package
// exposes the operational contracts this service relies on.
import { test } from 'node:test'
import { PullRequestInbox } from 'vite-hub/agent/server/github-inbox'
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

for (const ownPush of [true, false]) test(`published inbox ${ownPush ? 'retains its own repair' : 'rejects an unrelated source push'} before synchronization`, async t => {
  const repository = 'acme/app'
  const original = 'a'.repeat(40), repair = 'b'.repeat(40), external = 'c'.repeat(40)
  const inbox = new PullRequestInbox({ path: ':memory:', repositories: [repository] })
  t.after(() => inbox.close())
  await inbox.seed(repository, { number: 42, state: 'open', user: { login: 'developer' }, head: { sha: original, ref: 'fix', repo: { full_name: repository } }, base: { sha: external, ref: 'main' } })
  const [claim] = await inbox.claim(1)
  assert.ok(claim)
  await inbox.ingest('source-push', 'push', { repository: { full_name: repository }, ref: 'refs/heads/fix', after: ownPush ? repair : external })
  await inbox.ingest('new-feedback', 'issue_comment', { repository: { full_name: repository }, action: 'created', issue: { number: 42, pull_request: {} }, comment: { id: 1, body: 'Check the new requirement.', user: { login: 'reviewer' } } })
  const finished = await inbox.finish(claim, { text: 'Repair pushed.', progress: { kind: 'verified', evidence: `push:${repair}` }, verifiedPushHeads: [repair], wait: { kind: 'checks', headSha: repair, reason: 'Waiting for new checks.', evidenceKey: 'repair-push' } })
  assert.equal(finished, ownPush)
  const current = (await inbox.get(repository, 42))!
  assert.equal(current.lease, null)
  assert.equal(current.status, ownPush ? 'waiting' : 'ready')
  assert.equal(current.wait?.headSha, ownPush ? repair : undefined)
  assert.ok(current.generation > current.handled, 'new feedback remains unhandled')
})
