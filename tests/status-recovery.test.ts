import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { github } from 'vite-hub/agent/channels'
import { publishAgentActivity } from 'vite-hub/agent'

let modules = dirname(realpathSync(fileURLToPath(import.meta.resolve('vite-hub/agent'))))
while (!modules.endsWith('/node_modules')) modules = dirname(modules)
const dist = join(modules, '@vite-hub/agent/dist')
const inboxFile = (await readdir(dist)).find(name => /^github-inbox-.*\.js$/.test(name))!
const { p: PullRequestInbox } = await import(pathToFileURL(join(dist, inboxFile)).href)
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
  return { inbox, claim, open }
}

test('saving a blocked pass also persists its PR status delivery', async t => {
  const { inbox, claim } = await fixture(t)
  await inbox.finish(claim, { text: 'Cannot commit because .git is read-only.', wait: { kind: 'external', headSha: head, reason: 'Provide writable .git metadata.', evidenceKey: 'blocker' } })
  assert.equal((await inbox.get(repository, 239)).status, 'waiting')
  const pending = await inbox.metaEntries('status-outbox:v1:')
  assert.equal(pending.length, 1, 'a saved result must not depend on a model successfully posting a comment')
  assert.equal(pending[0][1].text, 'Cannot commit because .git is read-only.')
})

const loadRecovery = () => import(pathToFileURL(join(dist, 'babysitter-status-recovery.js')).href)
const blocked = (text = 'Cannot commit because .git is read-only.') => ({ text, wait: { kind: 'external', headSha: head, reason: 'Provide writable .git metadata.', evidenceKey: 'blocker' } })

test('status retries after restart and reconciles a comment accepted before a connection failure', async t => {
  const { inbox, claim, open } = await fixture(t)
  const { createBabysitterStatusRecovery } = await loadRecovery()
  await inbox.finish(claim, blocked())
  let posts = 0, updates = 0, loseResponse = true
  const comments: Array<{ id: number; body: string; user: { login: string } }> = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url.endsWith('/user')) return Response.json({ login: 'worker[bot]' })
    if (method === 'GET' && url.includes('/comments')) return Response.json(comments)
    const body = JSON.parse(String(init?.body)).body
    if (method === 'POST') {
      posts++
      comments.push({ id: 10, body, user: { login: 'worker[bot]' } })
      if (loseResponse) { loseResponse = false; throw new Error('Connection lost after GitHub accepted the comment') }
      return Response.json(comments[0])
    }
    if (method === 'PATCH') { updates++; comments[0].body = body; return Response.json(comments[0]) }
    throw new Error(`Unexpected request ${method} ${url}`)
  }
  const publisher = () => {
    const channel = github({ activity: true, app: { token: 'test-token', fetch: fetcher, identity: { login: 'worker[bot]' } } })
    return pending => publishAgentActivity({ name: 'babysitter-worker', channels: { github: channel } }, { channelId: 'github', target: { repository, issue: 239 }, activity: pending.activity })
  }
  await createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: publisher() }).flush()
  const pending = await inbox.metaEntries('status-outbox:v1:')
  assert.equal(pending[0][1].attempts, 1)
  assert.equal(posts, 1)
  await inbox.close()
  const restored = open()
  t.after(() => restored.close())
  restored.clock = () => pending[0][1].nextAt + 1
  await createBabysitterStatusRecovery({ inbox: restored, revision: 'release-1', publish: publisher() }).flush()
  assert.equal(posts, 1, 'retry must find the already-created managed comment')
  assert.equal(updates, 1)
  assert.equal((await restored.metaEntries('status-outbox:v1:')).length, 0)
  assert.match(comments[0].body, /Cannot commit because \.git is read-only/)
})

test('finishing an old delivery cannot erase a newer result saved during publication', async t => {
  const { inbox, claim } = await fixture(t)
  const { createBabysitterStatusRecovery } = await loadRecovery()
  await inbox.finish(claim, blocked('First result'))
  const delivered: string[] = []
  const recovery = createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: async pending => {
    delivered.push(pending.text)
    if (delivered.length === 1) {
      await inbox.wake(await inbox.get(repository, 239), 'new-feedback')
      const [next] = await inbox.claim(1)
      await inbox.finish(next, blocked('New result'))
    }
  } })
  await recovery.flush()
  assert.equal((await inbox.metaEntries('status-outbox:v1:'))[0][1].text, 'New result')
  await recovery.flush()
  assert.deepEqual(delivered, ['First result', 'New result'])
  assert.equal((await inbox.metaEntries('status-outbox:v1:')).length, 0)
})

test('stale claims and replaced heads do not publish an obsolete result', async t => {
  const { inbox, claim } = await fixture(t)
  const { createBabysitterStatusRecovery } = await loadRecovery()
  await inbox.release(claim)
  assert.equal(await inbox.finish(claim, blocked()), false)
  assert.equal((await inbox.metaEntries('status-outbox:v1:')).length, 0)
  const [current] = await inbox.claim(1)
  await inbox.finish(current, blocked())
  await inbox.seed(repository, { ...pr, head: { ...pr.head, sha: 'c'.repeat(40) } })
  await createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: () => assert.fail('obsolete head must not be published') }).flush()
  assert.equal((await inbox.metaEntries('status-outbox:v1:')).length, 0)
})

test('a new release wakes a worker blocker once and leaves real external blockers parked', async t => {
  const { inbox, claim } = await fixture(t)
  const { createBabysitterStatusRecovery } = await loadRecovery()
  await inbox.finish(claim, blocked())
  const recovery = createBabysitterStatusRecovery({ inbox, revision: 'release-2' })
  await recovery.recover()
  assert.equal((await inbox.get(repository, 239)).status, 'ready')
  const [retry] = await inbox.claim(1)
  await recovery.recordWorkerBlocker(retry.snapshot, blocked().wait.reason)
  await inbox.finish(retry, blocked())
  await recovery.recover()
  assert.equal((await inbox.get(repository, 239)).status, 'waiting', 'unchanged worker failure must not loop')
  await createBabysitterStatusRecovery({ inbox, revision: 'release-3' }).recover()
  assert.equal((await inbox.get(repository, 239)).status, 'ready')
  const [external] = await inbox.claim(1)
  await inbox.finish(external, { text: 'Waiting for maintainer credentials.', wait: { kind: 'external', headSha: head, reason: 'Maintainer must authorize the external database account.', evidenceKey: 'credentials' } })
  await createBabysitterStatusRecovery({ inbox, revision: 'release-4' }).recover()
  assert.equal((await inbox.get(repository, 239)).status, 'waiting')
})

test('historical results are backfilled once and worker recovery survives restart', async t => {
  const { inbox, claim, open } = await fixture(t)
  const { createBabysitterStatusRecovery } = await loadRecovery()
  await inbox.finish(claim, blocked())
  await inbox.deleteMeta('status-outbox:v1:acme/app#239')
  const recovery = createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: async () => {} })
  await recovery.recover()
  await recovery.flush()
  const [retry] = await inbox.claim(1)
  await recovery.recordWorkerBlocker(retry.snapshot, blocked().wait.reason)
  await inbox.finish(retry, blocked())
  await recovery.flush()
  await inbox.close()
  const restored = open()
  t.after(() => restored.close())
  await createBabysitterStatusRecovery({ inbox: restored, revision: 'release-1', publish: async () => assert.fail('already delivered result must not be reposted') }).recover()
  assert.equal((await restored.get(repository, 239)).status, 'waiting')
  assert.equal((await restored.metaEntries('status-outbox:v1:')).length, 0)
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
  const credentials = createGitHubAppCredentials({ appId: 1, privateKey, installationId: 101, owner: 'vite-hub', installations: { onmax: 202 } } as any)
  assert.equal((await credentials.credentials({ repository: 'vite-hub/vitehub' })).installationId, 101)
  assert.equal((await credentials.credentials({ repository: 'onmax/vite-doctor' })).installationId, 202)
  assert.equal((await credentials.credentials({ repository: 'nuxt-modules/better-auth' })).installationId, 303)
  assert.equal((await credentials.credentials({ repository: 'nuxt-modules/another' })).installationId, 303)
  assert.deepEqual(discovered, ['https://api.github.com/repos/nuxt-modules/better-auth/installation'])
})
