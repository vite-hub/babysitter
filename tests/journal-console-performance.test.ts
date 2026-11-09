import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { createMemoryAgentInvocationStore, defineAgentInvocations } from 'vite-hub/agent/server'

import type { AgentInvocationRecord } from 'vite-hub/agent'

const require = createRequire(import.meta.resolve('vite-hub'))
const packageRoot = (name: string) => dirname(require.resolve(`${name}/package.json`))
const agentRoot = packageRoot('@vite-hub/agent')
const consoleRoot = packageRoot('vite-hub')
const timestamp = '2026-11-09T00:00:00.000Z'

async function helper(symbol: string) {
  const directory = join(consoleRoot, 'dist')
  const owners = await Promise.all((await readdir(directory)).filter(file => file.endsWith('.js')).map(async file => ({
    file, source: await readFile(join(directory, file), 'utf8'),
  })))
  const owner = owners.find(({ source }) => source.includes(`function ${symbol}(`))
  assert.ok(owner, `installed Console contains ${symbol}`)
  const url = `${pathToFileURL(join(directory, owner.file)).href}?journal-console=${symbol}`
  const hooks = registerHooks({ load(specifier, context, next) {
    const loaded = next(specifier, context)
    return specifier === url ? { ...loaded, source: `${loaded.source}\nexport { ${symbol} as probe };` } : loaded
  } })
  try { return (await import(url)).probe }
  finally { hooks.deregister() }
}

const record = (observations: AgentInvocationRecord['observations']): AgentInvocationRecord => ({
  id: 'run', traceId: 'trace', createdAt: timestamp, updatedAt: timestamp, status: 'running',
  annotations: { project: 'original' }, observations,
})
const observation = (sequence: number, name = 'cursor.test.observation'): AgentInvocationRecord['observations'][number] => ({
  sequence, name, type: 'run', timestamp,
  attributes: { text: `Unicode 雪 😀 e\u0301 and escape \\" ${sequence}` },
})

for (const observationNames of [[], ['agent.invocation.finish']]) {
  test(`memory journal clones only selected observation payloads for ${JSON.stringify(observationNames)}`, async t => {
    const store = createMemoryAgentInvocationStore()
    const selected = { ...observation(2, 'agent.invocation.finish'), payload: { visibility: 'public', value: { answer: 'done' } } } satisfies AgentInvocationRecord['observations'][number]
    const observations = [{ ...observation(1, 'agent.tool.result'), attributes: { excluded: 'tool payload'.repeat(1_000) } }, selected]
    await store.create(record(observations))
    const clone = structuredClone
    let excludedClones = 0
    const spy = t.mock.method(globalThis, 'structuredClone', (input: unknown, options?: StructuredSerializeOptions) => {
      if (input !== null && typeof input === 'object' && 'excluded' in input) excludedClones++
      return clone(input, options)
    })
    const result = await store.get('run', { observationNames })
    spy.mock.restore()
    assert.deepEqual(result?.observations, observationNames.length ? [selected] : [])
    assert.equal(excludedClones, 0, 'excluded payloads must never be cloned')
    assert.ok(result?.annotations)
    result.annotations.project = 'changed'
    const returned = result.observations[0]
    if (returned?.attributes) returned.attributes.text = 'changed'
    if (returned?.payload?.visibility === 'public') returned.payload.value = 'changed'
    const complete = await store.get('run')
    assert.deepEqual(complete?.annotations, { project: 'original' })
    assert.deepEqual(complete?.observations, observations)
    assert.equal(await store.get('missing', { observationNames }), undefined)
  })
}

test('SQLite journal indexes selected names and returns append order across an additive reopen', async t => {
  const { createClient } = await import(pathToFileURL(require.resolve('@libsql/client', { paths: [agentRoot] })).href)
  const { createLibsqlAgentInvocationStore } = await import(pathToFileURL(join(agentRoot, 'dist/invocations/sqlite.js')).href)
  const directory = await mkdtemp(join(tmpdir(), 'babysitter-journal-'))
  const url = `file:${join(directory, 'journal.sqlite')}`
  const client = createClient({ url })
  const clients = [client]
  t.after(async () => {
    for (const connection of clients) if (!connection.closed) connection.close()
    await rm(directory, { recursive: true, force: true })
  })
  const statements: string[] = []
  const recording = new Proxy(client, { get(target, key) {
    if (key === 'batch') return (batch: Array<string | { sql: string }>, mode: string) => {
      statements.push(...batch.map(statement => typeof statement === 'string' ? statement : statement.sql))
      return target.batch(batch, mode)
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const options = { client: recording, maxAge: false, maxRecords: false }
  const store = createLibsqlAgentInvocationStore(options)
  const observations = [observation(3, 'finish'), observation(2, 'tool'), observation(1, 'finish'), observation(4, 'usage')]
  await store.create(record(observations))
  const names = ['finish', 'usage']
  statements.length = 0
  const filtered = await store.get('run', { observationNames: names })
  assert.deepEqual(filtered?.observations, [observations[0], observations[2], observations[3]])
  const query = statements.find(sql => sql.startsWith('SELECT position, observation FROM'))
  assert.ok(query, 'store.get issues an observation-row query')
  const plan = await client.execute({ sql: `EXPLAIN QUERY PLAN ${query}`, args: ['run', JSON.stringify(names)] })
  t.diagnostic(`Selected observation query plan: ${JSON.stringify(plan.rows)}`)
  assert.ok(plan.rows.some((row: { detail: unknown }) => typeof row.detail === 'string' && row.detail.includes('invocation_sequence=? AND <expr>=?')), JSON.stringify(plan.rows))
  assert.deepEqual((await store.get('run'))?.observations, observations)
  assert.deepEqual((await store.get('run', { observationNames: [] }))?.observations, [])
  const prefix = 'vitehub_agent_invocations_observations'
  const indexes = (await client.execute(`PRAGMA index_list(${prefix})`)).rows.map((row: { name: string }) => row.name)
  assert.ok(indexes.includes(`${prefix}_invocation`), 'keep the full-read index')
  assert.ok(indexes.includes(`${prefix}_invocation_name`), 'add the selected-name index')
  client.close()
  const connection = createClient({ url })
  clients.push(connection)
  await connection.execute(`DROP INDEX ${prefix}_invocation_name`)
  const reopened = createLibsqlAgentInvocationStore({ ...options, client: connection })
  assert.deepEqual((await reopened.get('run', { observationNames: names }))?.observations, filtered.observations)
  assert.deepEqual((await reopened.get('run'))?.observations, observations)
  const reopenedIndexes = (await connection.execute(`PRAGMA index_list(${prefix})`)).rows.map((row: { name: string }) => row.name)
  assert.ok(reopenedIndexes.includes(`${prefix}_invocation_name`), 'recreate the additive index on older databases')
  assert.equal(await reopened.get('missing', { observationNames: names }), undefined)
})

async function consoleJournal() {
  const store = createMemoryAgentInvocationStore()
  const install = await helper('installConsoleInvocationFallback')
  install(defineAgentInvocations({ store }), '/journal-console-consumer')
  const { getConsoleInvocationDetail } = await import(pathToFileURL(join(consoleRoot, 'dist/console/runtime/server/invocation.get.js')).href)
  const read = (params = new URLSearchParams()) => getConsoleInvocationDetail({ req: new Request(`http://localhost/_vitehub/api/invocations/run?${params}`) })
  return { store, read }
}

test('Console resets an opaque legacy cursor once and resumes empty and appended polls', async () => {
  const { store, read } = await consoleJournal()
  await store.create(record([]))
  const reset = await read(new URLSearchParams({ observationCount: '0', observationCursor: '0-ztntfp-45h' }))
  assert.deepEqual(reset.observations, [])
  assert.equal(reset.appendObservations, undefined)
  assert.match(reset.observationCursor, /^0-[a-f0-9]{64}$/)
  const params = new URLSearchParams({ observationCount: '0', observationCursor: reset.observationCursor })
  const unchanged = await read(params)
  assert.equal(unchanged.appendObservations, true)
  assert.deepEqual(unchanged.observations, [])
  const appended = observation(1)
  await store.update('run', { observation: appended, timestamp })
  const next = await read(params)
  assert.equal(next.appendObservations, true)
  assert.deepEqual(next.observations, [appended])
})

for (const count of [0, 2, 31, 32, 33, 63, 64, 65]) {
  test(`Console hashes ${count} retained observations in bounded batches and resets a changed prefix`, async t => {
    const { store, read } = await consoleJournal()
    const observations = Array.from({ length: 65 }, (_, index) => observation(index + 1))
    await store.create(record(observations.slice(0, count)))
    const initial = await read()
    for (const entry of observations.slice(count)) await store.update('run', { observation: entry, timestamp })
    const stringify = JSON.stringify
    const serialized: unknown[] = []
    const spy = t.mock.method(JSON, 'stringify', (value: unknown) => {
      const entries: unknown[] = Array.isArray(value) ? value : [value]
      const selected = entries.filter(entry => entry !== null && typeof entry === 'object' && 'name' in entry && entry.name === 'cursor.test.observation')
      if (selected.length) {
        assert.ok(Array.isArray(value), 'serialize observations in arrays')
        assert.ok(value.length <= 32, 'bound each serialization batch')
        serialized.push(...selected)
      }
      return stringify(value)
    })
    const params = new URLSearchParams({ observationCount: String(count), observationCursor: initial.observationCursor })
    const appended = await read(params)
    spy.mock.restore()
    assert.equal(appended.appendObservations, true)
    assert.deepEqual(appended.observations, observations.slice(count))
    assert.equal(appended.observationCursor, `1t-${createHash('sha256').update(JSON.stringify(observations)).digest('hex')}`)
    assert.deepEqual(serialized, observations, 'visit the full history once')
    const full = await read()
    assert.equal(full.observationCursor, appended.observationCursor)
    if (count > 0) {
      const changed = structuredClone(observations)
      changed[0] = observation(1, 'rewritten')
      await store.update('run', { status: 'completed', timestamp })
      await store.delete('run')
      await store.create(record(changed))
      const reset = await read(params)
      assert.equal(reset.appendObservations, undefined)
      assert.deepEqual(reset.observations, changed)
    }
    for (const invalidCount of ['-1', '66', '1.5', 'NaN']) {
      const reset = await read(new URLSearchParams({ observationCount: invalidCount, observationCursor: full.observationCursor }))
      assert.equal(reset.appendObservations, undefined)
      assert.equal(reset.observations.length, 65)
    }
    await store.update('run', { status: 'completed', timestamp })
    await store.delete('run')
    await store.create({ ...record(observations), observationsTruncated: true })
    const truncated = await read(new URLSearchParams({ observationCount: '65', observationCursor: full.observationCursor }))
    assert.equal(truncated.appendObservations, undefined)
    assert.deepEqual(truncated.observations, observations)
  })
}
