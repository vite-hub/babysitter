import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PullRequestInbox } from 'vite-hub/agent/server/github-inbox'
const head = 'a'.repeat(40)
const repository = 'acme/app'
const pr = { number: 239, state: 'open', draft: false, title: 'Repair cache', user: { login: 'developer' }, head: { sha: head, ref: 'fix', repo: { full_name: repository } }, base: { sha: 'b'.repeat(40), ref: 'main' } }

async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'babysitter-status-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'inbox.sqlite')
  const open = () => new PullRequestInbox({ path, repositories: [repository], activityAuthors: ['worker[bot]'] })
  const inbox = open()
  t.after(() => inbox.close())
  await inbox.seed(repository, pr)
  const [claim] = await inbox.claim(1)
  return { inbox, claim: claim!, open }
}

test('saving a blocked pass also persists its PR status delivery', async t => {
  const { inbox, claim, open } = await fixture(t)
  await inbox.finish(claim, { text: 'Cannot commit because .git is read-only.', wait: { kind: 'external', headSha: head, reason: 'Provide writable .git metadata.', evidenceKey: 'blocker' } })
  assert.equal((await inbox.get(repository, 239))?.status, 'waiting')
  const pending = await inbox.pendingStatusDeliveries()
  assert.equal(pending.length, 1, 'a saved result must not depend on a model successfully posting a comment')
  assert.equal((await inbox.pendingStatusDeliveries())[0]?.text, 'Cannot commit because .git is read-only.')
  const [delivery] = await inbox.claimStatusDeliveries()
  assert.ok(delivery?.lease)
  assert.notEqual(delivery.activity.runId, claim.runId)
  assert.equal(await inbox.renewStatusDelivery(delivery), true)
  assert.equal(await inbox.renewStatusDelivery({ ...delivery, lease: 'old-host' }), false)
  const other = open()
  t.after(() => other.close())
  assert.deepEqual(await other.claimStatusDeliveries(), [])
  assert.equal(await inbox.finishStatusDelivery(delivery, 'delivered'), true)
  assert.deepEqual(await other.pendingStatusDeliveries(), [])
})

test('GitHub App credentials select each owner installation instead of reusing the default', async t => {
  const { createGitHubAppCredentials } = await import('vite-hub/agent/server/github')
  const { generateKeyPairSync } = await import('node:crypto')
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const discovered: string[] = []
  globalThis.fetch = async input => {
    discovered.push(String(input))
    return Response.json({ id: 303 })
  }
  const credentials = createGitHubAppCredentials({ appId: 1, privateKey, installationId: 101, owner: 'vite-hub', installations: { onmax: 202 } })
  assert.equal((await credentials.credentials({ repository: 'vite-hub/vitehub' })).installationId, 101)
  assert.equal((await credentials.credentials({ repository: 'onmax/vite-doctor' })).installationId, 202)
  assert.equal((await credentials.credentials({ repository: 'nuxt-modules/better-auth' })).installationId, 303)
  assert.equal((await credentials.credentials({ repository: 'nuxt-modules/another' })).installationId, 303)
  assert.deepEqual(discovered, ['https://api.github.com/repos/nuxt-modules/better-auth/installation'])
})

for (const change of ['closed', 'feedback'] as const) test(`the installed package persists status correction after concurrent ${change}`, async t => {
  const { inbox, claim, open } = await fixture(t)
  await inbox.finish(claim, { text: 'Waiting for old checks', wait: { kind: 'checks', headSha: head, reason: 'Old checks remain pending', evidenceKey: 'old-checks' } })
  const [delivery] = await inbox.claimStatusDeliveries()
  assert.ok(delivery)
  if (change === 'closed') await inbox.seed(repository, { ...pr, state: 'closed' })
  else await inbox.ingest('feedback-during-write', 'issue_comment', {
    repository: { full_name: repository }, action: 'created', issue: { number: pr.number, pull_request: {} },
    comment: { id: 1, body: 'New requirements', user: { login: 'reviewer' } },
  })
  assert.equal(await inbox.finishStatusDelivery(delivery, 'delivered'), false)
  const restarted = open()
  t.after(() => restarted.close())
  const [correction] = await restarted.claimStatusDeliveries()
  assert.ok(correction)
  assert.equal(correction.text, change === 'closed' ? 'Pull request closed.' : 'New pull request evidence is queued.')
  assert.equal(await restarted.finishStatusDelivery(correction, 'delivered'), true)
  const snapshot = (await restarted.get(repository, pr.number))!
  assert.equal(snapshot.lastResult, 'Waiting for old checks')
  if (change === 'feedback') assert.ok(snapshot.generation > snapshot.handled)
})
