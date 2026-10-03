import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createLibsqlAgentInvocationStore } from 'vite-hub/agent/invocations/sqlite'

test('patched invocation store applies every concurrent update in order', async t => {
  const root = await mkdtemp(join(tmpdir(), 'babysitter-invocation-batch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'invocations.sqlite')
  const store = createLibsqlAgentInvocationStore({ url: `file:${file}` })
  const now = new Date().toISOString()
  await store.create({ id: 'run-1', traceId: 'trace-1', agentName: 'babysitter', status: 'running', createdAt: now, updatedAt: now, observations: [] })
  const results = await Promise.all(Array.from({ length: 50 }, (_, index) => store.update('run-1', {
    observation: { name: `step.${index}`, type: 'lifecycle', sequence: index + 1, timestamp: now, attributes: { index } },
    timestamp: now,
  })))
  assert.equal(results.length, 50)
  assert.equal(results.at(-1)?.observations.length, 50)
  await store.update('run-1', { status: 'completed', timestamp: new Date().toISOString() })
  const db = new DatabaseSync(file, { readOnly: true })
  t.after(() => db.close())
  const row = db.prepare('SELECT status, record FROM vitehub_agent_invocations WHERE id = ?').get('run-1') as { status: string, record: string }
  const record = JSON.parse(row.record) as { observations: Array<{ name: string }> }
  assert.equal(row.status, 'completed')
  assert.deepEqual(record.observations.map(observation => observation.name), Array.from({ length: 50 }, (_, index) => `step.${index}`))
})
