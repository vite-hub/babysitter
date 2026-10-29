import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publishAgentActivity } from 'vite-hub/agent'
import { createGitHubAppCredentials, createGitHubHost } from 'vite-hub/agent/server/github'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { PullRequestInbox } from 'vite-hub/agent/server/github-inbox'

const repository = 'acme/app'
const appId = 4698907
const oldLogin = 'vitehub-bot[bot]'
const newLogin = 'vite-hub[bot]'
const head = 'a'.repeat(40)
const pr = { number: 64, state: 'open', head: { sha: head }, base: { sha: 'b'.repeat(40), ref: 'main' } }
const marker = '<!-- vitehub-agent-activity:eyJoaXN0b3J5IjpbXSwicHJldmlvdXNSdW5JZHMiOltdfQ -->'
const comment = (id: number, login = newLogin, sourceApp = appId, body = `${marker}\n\nNew pull request evidence is queued.`) =>
  ({ id, body, user: { login, type: 'Bot' }, performed_via_github_app: { id: sourceApp }, updated_at: id === 10 ? '2026-10-28T13:00:00Z' : '2026-10-28T18:00:00Z' })

test('App credentials preserve the immutable ID used by the host and activity channel', async t => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname === '/app') return Response.json({ id: appId, slug: 'vitehub-bot' })
    assert.equal(url.pathname, `/users/${encodeURIComponent(oldLogin)}`)
    return Response.json({ id: 320448255, login: oldLogin })
  })
  const credentials = createGitHubAppCredentials({ appId, privateKey })
  const identity = await credentials.identity()
  assert.equal(identity.appId, appId)
  assert.equal(createGitHubHost({ credentials: credentials.credentials, identity }).appId?.(), appId)
})

test('host activity reuses the original App comment across a rename and restart', async t => {
  const comments = [comment(10), comment(11), comment(12, 'other[bot]', 99)]
  const state = { current: { agentName: 'babysitter-worker', runId: createHash('sha256').update('babysitter-worker\0first').digest('base64url'), status: 'queued', links: [], updatedAt: '2026-10-28T18:00:00Z' }, history: [], previousRunIds: [] }
  comments[1]!.body = `<!-- vitehub-agent-activity:${Buffer.from(JSON.stringify(state)).toString('base64url')} -->\n\nNew pull request evidence is queued.`
  const historicalBody = comments[1]!.body
  const writes: Array<{ method: string; id?: number }> = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    if (url.pathname === '/user') return Response.json({ message: 'Resource not accessible by integration' }, { status: 403 })
    if (method === 'GET') return Response.json(comments)
    const { body } = JSON.parse(String(init?.body))
    const id = method === 'PATCH' ? Number(url.pathname.split('/').at(-1)) : undefined
    writes.push({ method, id })
    if (id !== undefined) {
      const existing = comments.find(item => item.id === id)
      assert.ok(existing)
      existing.body = body
      existing.updated_at = '2026-10-28T19:00:00Z'
      return Response.json(existing)
    }
    const created = comment(comments.length + 20, newLogin, appId, body)
    comments.push(created)
    return Response.json(created)
  })
  const publish = async (runId: string) => {
    const host = createGitHubHost({ credentials: () => ({ token: 'fixture', rateLimitKey: 'fixture' }), identity: { login: oldLogin, appId } })
    t.mock.method(host, 'access', async () => ({ token: 'fixture', env: {} }))
    await publishAgentActivity({ name: 'babysitter-worker', channels: { github: host.channel({ activity: true }) } }, {
      channelId: 'github', target: { repository, issue: 64 },
      activity: { runId, status: 'waiting', links: [], tasks: [], summary: 'Waiting for parent.', updatedAt: '2026-10-28T18:00:00Z' },
    })
  }
  await publish('first')
  await publish('after-restart')
  assert.equal(comments.length, 3, 'a renamed App must edit its existing comment, never create another')
  assert.equal(writes.filter(item => item.method === 'POST').length, 0)
  assert.match(comments[0]!.body, /Waiting for parent/)
  assert.equal(comments[1]!.body, historicalBody, 'publishing current status does not rewrite historical duplicates')
  assert.equal(comments[2]!.body, comment(12, 'other[bot]', 99).body, 'another App owns its own comment')
  assert.deepEqual(writes, [{ method: 'PATCH', id: 10 }, { method: 'PATCH', id: 10 }])
})

test('renamed App activity webhooks do not wake a waiting PR, while real feedback does', async t => {
  const inbox = new PullRequestInbox({ path: ':memory:', repositories: [repository], activityAuthors: [oldLogin], activityAppId: appId })
  t.after(() => inbox.close())
  await inbox.seed(repository, pr)
  const [claim] = await inbox.claim(1)
  assert.ok(claim)
  await inbox.finish(claim, { text: 'Waiting for parent.', wait: { kind: 'external', headSha: head, reason: 'Parent is open.', evidenceKey: 'parent' } })
  const before = await inbox.get(repository, 64)
  const deliver = (id: string, item: ReturnType<typeof comment>) => inbox.ingest(id, 'issue_comment', {
    repository: { full_name: repository }, action: 'edited', issue: { number: 64, pull_request: {} }, comment: item, sender: item.user,
  })
  for (const id of ['first', 'retry']) {
    const result = await deliver(id, comment(10))
    assert.deepEqual(result.updated, [], 'publishing activity must not become new PR evidence')
    assert.deepEqual(result.queued, [])
  }
  const after = await inbox.get(repository, 64)
  assert.equal(after?.generation, before?.generation)
  assert.equal(after?.status, 'waiting')
  assert.deepEqual(after?.comments, {})
  assert.deepEqual((await deliver('foreign', comment(11, 'other[bot]', 99))).updated, [64])
  assert.deepEqual((await deliver('reused-login', comment(13, oldLogin, 99))).updated, [64], 'App ownership takes precedence over a cached login')
  assert.deepEqual((await deliver('real-feedback', comment(12, newLogin, appId, 'P2: handle the empty case.'))).updated, [64])
})

test('a repaired inbox removes persisted App activity and keeps ordinary feedback', async t => {
  const { createNodeSqliteInboxStorage } = await import('vite-hub/agent/server/github-inbox')
  const storage = createNodeSqliteInboxStorage(':memory:')
  t.after(() => storage.close?.())
  const old = new PullRequestInbox({ storage, repositories: [repository], activityAuthors: [oldLogin] })
  await old.seed(repository, pr)
  await old.ingest('polluted', 'issue_comment', { repository: { full_name: repository }, action: 'created', issue: { number: 64, pull_request: {} }, comment: comment(10) })
  const repaired = new PullRequestInbox({ storage, repositories: [repository], activityAuthors: [oldLogin], activityAppId: appId })
  assert.deepEqual((await repaired.get(repository, 64))?.comments, {})
  assert.deepEqual((await repaired.all())[0]?.comments, {})
  const [claim] = await repaired.claim(1)
  assert.ok(claim)
  await repaired.hydrate(claim, { comments: { 10: comment(10), 11: comment(11, newLogin, appId, 'Please fix this.') } })
  assert.deepEqual(Object.keys(claim.snapshot.comments), ['11'])
  assert.deepEqual(Object.keys((await repaired.get(repository, 64))!.comments), ['11'])
})
