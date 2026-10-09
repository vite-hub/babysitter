import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { github } from 'vite-hub/agent/channels'
import { publishAgentActivity } from 'vite-hub/agent'
import { PullRequestInbox } from 'vite-hub/agent/server/github-inbox'

test('saved installation blockers share the worker session row and leave historical rows inactive', async t => {
  const root = await mkdtemp(join(tmpdir(), 'babysitter-activity-'))
  const repository = 'acme/app'
  const head = 'a'.repeat(40)
  const inbox = new PullRequestInbox({ path: join(root, 'inbox.sqlite'), repositories: [repository], activityAuthors: ['worker[bot]'] })
  t.after(async () => { await inbox.close(); await rm(root, { recursive: true, force: true }) })
  await inbox.seed(repository, { number: 1, state: 'open', head: { sha: head }, base: { sha: 'b'.repeat(40), ref: 'main' } })
  const [claim] = await inbox.claim(1)
  assert.ok(claim)
  claim.startedAt = Date.now()
  claim.runId = 'failed-install'
  const links = [{ label: 'Current session', url: 'https://console.test/agents/babysitter-worker/invocations/failed-install' }]
  claim.activity = { target: { repository, issue: 1 }, links }
  const comments: Array<{ id: number; body: string; user: { login: string } }> = []
  const channel = github({ activity: true, app: {
    apiBaseUrl: 'https://activity.example.test', token: 'test-token', identity: { login: 'worker[bot]' },
    fetch: async (_input, init) => {
      if ((init?.method ?? 'GET') === 'GET') return Response.json(comments)
      const body = JSON.parse(String(init?.body)).body
      if (init?.method === 'POST') comments.push({ id: 10, body, user: { login: 'worker[bot]' } })
      else comments[0]!.body = body
      return Response.json(comments[0])
    },
  } })
  const agent = { name: 'babysitter-worker', channels: { github: channel } }
  const publish = (activity: Parameters<typeof publishAgentActivity>[1]['activity']) =>
    publishAgentActivity(agent, { channelId: 'github', target: { repository, issue: 1 }, activity })
  const startedAt = new Date(claim.startedAt!).toISOString()
  await publish({ runId: claim.runId, status: 'failed', links, startedAt,
    updatedAt: new Date(claim.startedAt! + 2_000).toISOString(), tasks: [], summary: 'Installation failed.' })
  await inbox.finish(claim, { text: 'Installation failed.', wait: { kind: 'external', headSha: head, reason: 'Repair the malformed lockfile.', evidenceKey: 'installer' } })
  const [delivery] = await inbox.claimStatusDeliveries()
  assert.ok(delivery)
  await publish(delivery.activity)
  await inbox.finishStatusDelivery(delivery, 'delivered')
  const rows = () => comments[0]!.body.split('\n').filter(line => line.startsWith('| [View session]'))
  assert.equal(rows().length, 1)
  assert.match(rows()[0]!, /\| Waiting \|/)
  assert.match(rows()[0]!, /Paused/)
  await publish({ runId: 'next-invocation', status: 'running', startedAt, updatedAt: startedAt, tasks: [],
    links: [{ label: 'Current session', url: 'https://console.test/agents/babysitter-worker/invocations/next-invocation' }] })
  assert.equal(rows().length, 2)
  assert.match(rows()[0]!, /In progress/)
  assert.doesNotMatch(rows()[1]!, /In progress/)
})
