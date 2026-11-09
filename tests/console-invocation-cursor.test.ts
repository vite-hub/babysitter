import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { getConsoleInvocationsDatabase, installConsoleInvocations } from 'vite-hub/console/server'

const require = createRequire(import.meta.resolve('vite-hub'))
const dist = join(dirname(require.resolve('vite-hub/package.json')), 'dist')
const { default: invocationHandler } = await import(pathToFileURL(join(dist, 'console/runtime/server/invocation.get.js')).href)
const { installConsoleAccess } = await import(pathToFileURL(join(dist, 'console/runtime/server/sections.js')).href)
const { createMemoryAgentInvocationStore, defineAgentInvocations } = await import(pathToFileURL(require.resolve('@vite-hub/agent/server')).href)
const { createLibsqlAgentInvocationStore } = await import(pathToFileURL(require.resolve('@vite-hub/agent/invocations/sqlite')).href)
const agentRequire = createRequire(require.resolve('@vite-hub/agent/package.json'))
const { createClient } = agentRequire('@libsql/client')
const timestamp = '2026-11-08T00:00:00.000Z'
const emptyCursor = '0-4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
const observations = [1, 2, 3].map(sequence => ({
  name: 'cursor.consumer.observation',
  sequence,
  timestamp,
  type: 'lifecycle',
  attributes: { text: `café 漢字 😀 \u0000 ${sequence}`, nested: { value: null, escaped: '\\"\n' } },
}))

for (const journal of ['memory', 'sqlite']) {
  test(`installed guarded Console route hashes once and preserves cursors with ${journal} journal`, async t => {
    await mkdir(join(process.cwd(), '.perf-validation'), { recursive: true })
    const root = await mkdtemp(join(process.cwd(), '.perf-validation/console-cursor-'))
    const previousURL = process.env.VITEHUB_CONSOLE_DATABASE_URL
    delete process.env.VITEHUB_CONSOLE_DATABASE_URL
    const client = journal === 'sqlite' ? createClient({ url: pathToFileURL(join(root, 'journal.sqlite')).href }) : undefined
    const store = client
      ? createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false })
      : createMemoryAgentInvocationStore()
    t.after(async () => {
      client?.close()
      if (previousURL === undefined) delete process.env.VITEHUB_CONSOLE_DATABASE_URL
      else process.env.VITEHUB_CONSOLE_DATABASE_URL = previousURL
      await rm(root, { recursive: true, force: true })
    })
    const record = (id: string, entries = observations, observationsTruncated = false) => ({
      id, createdAt: timestamp, updatedAt: timestamp, traceId: `${journal}-${id}`,
      status: 'running', observations: entries, observationsTruncated,
    })
    await store.create(record('cursor-test', observations.slice(0, 2)))
    const selected = client
      ? installConsoleInvocations(root, undefined, undefined, pathToFileURL(join(root, 'journal.sqlite')).href)
      : installConsoleInvocations(root, defineAgentInvocations({ store }))
    if (client) assert.equal(getConsoleInvocationsDatabase().driver, 'libsql')
    installConsoleAccess({ mode: 'open', authorize: () => ({ sections: ['agents'] }) })

    const read = async (query: Record<string, string> = {}, id = 'cursor-test') => {
      const headers = new Headers()
      const result = await invocationHandler({
        req: new Request(`http://localhost/_vitehub/api/invocations/${id}?${new URLSearchParams(query)}`),
        res: { headers }, context: {},
      })
      assert.ok(!(result instanceof Response), 'authorized request reaches the installed route')
      assert.equal(headers.get('cache-control'), 'no-store')
      return result
    }
    const initial = await read()
    assert.deepEqual(initial.observations, observations.slice(0, 2))
    assert.equal(initial.invocation.traceId, `${journal}-cursor-test`)
    assert.equal(initial.observationCursor, '2-ddac9b008d22db832df476ff56d034005490a37a6e84fb7df9c497e94d237f68')
    assert.equal(initial.appendObservations, undefined)
    await store.update('cursor-test', { observation: observations[2], timestamp })
    const complete = await read()
    assert.equal(complete.observationCursor, '3-e18c0117f26cf38eb089747314a4123052358ad4f72d8a0eeb26381063ab13db')
    assert.deepEqual(complete.observations, observations)

    const serializations: number[] = []
    for (const [count, cursor, expected] of [
      [3, complete.observationCursor, []],
      [2, initial.observationCursor, observations.slice(2)],
    ] as const) {
      const stringify = t.mock.method(JSON, 'stringify')
      let result
      try {
        result = await read({ observationCount: String(count), observationCursor: cursor })
        serializations.push(stringify.mock.calls.flatMap(({ arguments: [value] }) => Array.isArray(value) ? value : [value]).filter((value: unknown) => {
          return value !== null && typeof value === 'object' && 'name' in value && value.name === 'cursor.consumer.observation'
        }).length)
      }
      finally { stringify.mock.restore() }
      assert.equal(result.appendObservations, true)
      assert.equal(result.observationCursor, complete.observationCursor)
      assert.deepEqual(result.observations, expected)
    }
    for (const [observationCount, observationCursor] of [['0', '0-ztntfp-45h'], ['2', '2-qfhh6x-msj41x'], ['3', '3-awn1hj-1jn86hv']] as const) {
      const legacy = await read({ observationCount, observationCursor })
      assert.equal(legacy.appendObservations, undefined)
      assert.equal(legacy.observationCursor, complete.observationCursor)
      assert.deepEqual(legacy.observations, observations)
      const resumed = await read({ observationCount: '3', observationCursor: legacy.observationCursor })
      assert.equal(resumed.appendObservations, true)
      assert.deepEqual(resumed.observations, [])
    }
    const zero = await read({ observationCount: '0', observationCursor: emptyCursor })
    assert.equal(zero.appendObservations, true)
    assert.deepEqual(zero.observations, observations)

    for (const observationCount of ['-1', '1.5', 'NaN', 'Infinity', '4', '9007199254740992']) {
      const result = await read({ observationCount, observationCursor: complete.observationCursor })
      assert.equal(result.appendObservations, undefined, observationCount)
      assert.deepEqual(result.observations, observations)
    }
    const invalidQueries: Record<string, string>[] = [
      { observationCursor: complete.observationCursor },
      { observationCount: '3' },
      { observationCount: '3', observationCursor: '' },
      { observationCount: '3', observationCursor: `${complete.observationCursor}x` },
      { observationCount: '0', observationCursor: complete.observationCursor },
      { observationCount: '2', observationCursor: complete.observationCursor },
    ]
    for (const query of invalidQueries) {
      const result = await read(query)
      assert.equal(result.appendObservations, undefined)
      assert.deepEqual(result.observations, observations)
    }
    for (const observationCount of ['', '  ', '0.0']) {
      assert.equal((await read({ observationCount, observationCursor: emptyCursor })).appendObservations, true)
    }
    await store.create(record('truncated', observations, true))
    const truncated = await read({ observationCount: '3', observationCursor: complete.observationCursor }, 'truncated')
    assert.equal(truncated.appendObservations, undefined)
    assert.deepEqual(truncated.observations, observations)
    await store.create(record('empty', []))
    const empty = await read({ observationCount: '0', observationCursor: emptyCursor }, 'empty')
    assert.equal(empty.appendObservations, true)
    assert.equal(empty.observationCursor, emptyCursor)
    assert.deepEqual(empty.observations, [])

    // The same ID, length, and timestamp must still detect a rewritten prefix.
    const rewritten = observations.map(entry => ({ ...entry, attributes: { ...entry.attributes, text: 'changed prefix' } }))
    if (client) {
      await client.execute({ sql: 'UPDATE vitehub_agent_invocations SET record = ? WHERE id = ?', args: [JSON.stringify(record('cursor-test', rewritten)), 'cursor-test'] })
      await client.execute("DELETE FROM vitehub_agent_invocations_observations WHERE invocation_sequence = (SELECT sequence FROM vitehub_agent_invocations WHERE id = 'cursor-test')")
    }
    else {
      const replacement = createMemoryAgentInvocationStore()
      await replacement.create(record('cursor-test', rewritten))
      installConsoleInvocations(root, defineAgentInvocations({ store: replacement }))
    }
    const reset = await read({ observationCount: '2', observationCursor: initial.observationCursor })
    assert.equal(reset.appendObservations, undefined)
    assert.notEqual(reset.observationCursor, complete.observationCursor)
    assert.deepEqual(reset.observations, rewritten)
    const sameLength = await read({ observationCount: '3', observationCursor: complete.observationCursor })
    assert.equal(sameLength.appendObservations, undefined)
    assert.deepEqual(sameLength.observations, rewritten)

    const otherStore = createMemoryAgentInvocationStore()
    await otherStore.create({ ...record('cursor-test', []), traceId: 'other-journal' })
    installConsoleInvocations(join(root, 'other'), defineAgentInvocations({ store: otherStore }))
    assert.equal((await read()).invocation.traceId, 'other-journal')
    installConsoleInvocations(root, selected)
    assert.equal((await read()).invocation.traceId, `${journal}-cursor-test`)

    for (const authorize of [() => false, () => ({ sections: ['logs'] })]) {
      installConsoleAccess({ mode: 'open', authorize })
      const stringify = t.mock.method(JSON, 'stringify')
      try {
        const denied = await invocationHandler({ req: new Request('http://localhost/_vitehub/api/invocations/cursor-test'), context: {} })
        assert.ok(denied instanceof Response)
        assert.equal(denied.status, 403)
        assert.equal(stringify.mock.calls.flatMap(({ arguments: [value] }) => Array.isArray(value) ? value : [value]).filter((value: unknown) => {
          return value !== null && typeof value === 'object' && 'name' in value && value.name === 'cursor.consumer.observation'
        }).length, 0)
      }
      finally { stringify.mock.restore() }
    }
    assert.deepEqual(serializations, [3, 3], 'unchanged and append polls serialize each retained observation once')
  })
}
