import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PullRequestInbox } from 'vite-hub/agent/server/github-inbox'

test('installed inbox retains a verified review resolution across restart without a webhook', async t => {
  const root = await mkdtemp(join(tmpdir(), 'babysitter-resolution-'))
  const repository = 'acme/app'
  const options = { path: join(root, 'inbox.sqlite'), repositories: [repository] }
  let inbox = new PullRequestInbox(options)
  t.after(async () => { await inbox.close(); await rm(root, { recursive: true, force: true }) })
  await inbox.seed(repository, { number: 1, state: 'open', head: { sha: 'a'.repeat(40) }, base: { sha: 'b'.repeat(40), ref: 'main' } })
  const [claim] = await inbox.claim(1)
  assert.ok(claim)
  assert.equal(await inbox.hydrate(claim, { threads: [{ id: 'review-thread', isResolved: false, comments: [] }], threadsHydrated: true }), true)
  assert.equal(await inbox.recordThreadResolution(claim, 'review-thread', structuredClone(claim.snapshot)), true)
  assert.equal(await inbox.isClaimCurrent(claim), true)
  assert.equal(await inbox.finish(claim, { text: 'Reviewed this head.', wait: { reason: 'checks', evidenceKey: 'reviewed-head' } }), true)
  await inbox.close()
  inbox = new PullRequestInbox(options)
  const restored = await inbox.get(repository, 1)
  assert.equal(restored?.threads[0]?.isResolved, true)
  assert.equal(restored?.status, 'waiting')
  assert.equal(restored?.lastResult, 'Reviewed this head.')
  assert.deepEqual(await inbox.claim(1), [])
})
