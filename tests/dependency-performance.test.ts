import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.resolve('vite-hub'))
const packageRoot = (name: string) => dirname(require.resolve(`${name}/package.json`))
const installed = (name: string) => import(pathToFileURL(require.resolve(name)).href)

// Build helpers are private and inlined into each package. Export them in memory only.
async function buildHelpers(name: string, exports: string[]) {
  const directory = join(packageRoot(name), 'dist')
  const files = await readdir(directory)
  const owner = (await Promise.all(files.filter(file => file.endsWith('.js')).map(async file => ({
    file, source: await readFile(join(directory, file), 'utf8'),
  })))).find(({ source }) => source.includes('function createResolvedAliasPlugin('))
  assert.ok(owner, `${name} has a bundled build helper`)
  const url = `${pathToFileURL(join(directory, owner.file)).href}?babysitter-performance=${exports.join(',')}`
  const additions = exports.map(name => `${name} as probe_${name}`)
  const hooks = registerHooks({
    load(specifier, context, next) {
      const result = next(specifier, context)
      return specifier === url ? { ...result, source: `${result.source}\nexport { ${additions.join(', ')} };` } : result
    },
  })
  const previousBinary = process.env.ESBUILD_BINARY_PATH
  // These older packages inline esbuild 0.27.7. Its API needs its matching installed binary.
  if (name === '@vite-hub/kv' || name === '@vite-hub/rate-limit') {
    const esbuildRequire = createRequire(join(packageRoot('vite-hub'), '../../../esbuild@0.27.7/node_modules/esbuild/package.json'))
    process.env.ESBUILD_BINARY_PATH = esbuildRequire.resolve(`@esbuild/${process.platform}-${process.arch}/bin/esbuild`)
  }
  try {
    const module = await import(url)
    return Object.fromEntries(exports.map(name => [name, module[`probe_${name}`]]))
  }
  finally {
    hooks.deregister()
    if (previousBinary === undefined) delete process.env.ESBUILD_BINARY_PATH
    else process.env.ESBUILD_BINARY_PATH = previousBinary
  }
}

const buildPackages = [
  'vite-hub', '@vite-hub/agent', '@vite-hub/blob', '@vite-hub/browser',
  '@vite-hub/database', '@vite-hub/kv', '@vite-hub/queue', '@vite-hub/rate-limit',
  '@vite-hub/schedule', '@vite-hub/workflow', '@vite-hub/workspace',
]

for (const name of buildPackages) {
  test(`${name} keeps selected provider entries and imported aliases`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'babysitter-build-alias-'))
    try {
      const { bundleEsmEntry, writeCloudflareDeploymentOutput, writeVercelDeploymentOutput, writeNetlifyDeploymentOutput } = await buildHelpers(name, [
        'bundleEsmEntry', 'writeCloudflareDeploymentOutput', 'writeVercelDeploymentOutput', 'writeNetlifyDeploymentOutput',
      ])
      const directory = join(root, 'node_modules/fixture-owner')
      await mkdir(directory, { recursive: true })
      const entry = join(directory, 'index.js')
      const replacement = join(root, 'replacement.mjs')
      await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'fixture-owner', type: 'module', exports: './index.js' }))
      await writeFile(entry, `export {default as imported} from ${JSON.stringify(entry)}; export {default as bareImported} from "fixture-owner"; export default "selected"`)
      await writeFile(replacement, 'export default "replacement"')
      const options = { alias: { 'fixture-owner': replacement }, platform: 'node', workingDir: root }
      const direct = join(root, 'direct.mjs')
      await bundleEsmEntry(entry, direct, options)
      assert.equal((await import(pathToFileURL(direct).href)).default, 'replacement')
      for (const optIn of [false, true]) {
        const bundleOptions = { ...options, ...(optIn ? { resolveEntryPackageAliases: true } : {}) }
        const common = { rootDir: root, clientOutDir: 'client', bundleEntry: entry, bundleOptions }
        const cloudflare = join(root, `cloudflare-${optIn}`)
        const vercel = join(root, `vercel-${optIn}`)
        const netlify = join(root, `netlify-${optIn}`)
        await writeCloudflareDeploymentOutput({ ...common, outputRoot: cloudflare, bundleOutfileName: 'index.mjs' })
        await writeVercelDeploymentOutput({ ...common, outputRoot: vercel })
        await writeNetlifyDeploymentOutput({ ...common, outputRoot: netlify, functions: [{ bundleEntry: entry, bundleOptions, functionName: 'fixture' }] })
        for (const output of [join(cloudflare, 'index.mjs'), join(vercel, 'functions/__server.func/index.mjs'), join(netlify, 'functions/fixture.mjs')]) {
          const result = await import(pathToFileURL(output).href)
          assert.equal(result.default, optIn ? 'replacement' : 'selected')
          if (!optIn) {
            assert.equal(result.imported, 'replacement')
            assert.equal(result.bareImported, 'replacement')
          }
        }
      }
      const absolute = join(root, 'absolute.mjs')
      await bundleEsmEntry(entry, absolute, { ...options, resolveEntryPackageAliases: false, alias: { [entry]: replacement } })
      assert.equal((await import(pathToFileURL(absolute).href)).default, 'replacement')
    }
    finally { await rm(root, { recursive: true, force: true }) }
  })
}

test('standalone Workflow discovery ignores colliding Agents while full discovery validates them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babysitter-workflow-discovery-'))
  try {
    const { discoverWorkflowDevDefinitions, discoverWorkflowDefinitions } = await buildHelpers('@vite-hub/workflow', ['discoverWorkflowDevDefinitions', 'discoverWorkflowDefinitions'])
    for (const [file, contents] of [
      ['server/workflows/welcome.ts', 'export default async () => 42'],
      ['server/agents/bot/agent.ts', 'export default defineAgent({runtime:workflow("welcome")})'],
    ]) {
      await mkdir(dirname(join(root, file)), { recursive: true })
      await writeFile(join(root, file), contents)
    }
    assert.deepEqual(discoverWorkflowDevDefinitions(root).map(({ name }: { name: string }) => name), ['welcome'])
    assert.throws(() => discoverWorkflowDefinitions({ rootDir: root }), /Duplicate workflow name/)
    await mkdir(join(root, 'node_modules/@vite-hub'), { recursive: true })
    await symlink(packageRoot('@vite-hub/workflow'), join(root, 'node_modules/@vite-hub/workflow'), 'dir')
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    const { resolveConfig } = await import('vite')
    const { hubWorkflow } = await import(pathToFileURL(require.resolve('@vite-hub/workflow/vite')).href)
    await resolveConfig({ root, configFile: false, plugins: [hubWorkflow({ provider: 'vercel' })], logLevel: 'silent' }, 'serve')
    const registry = await import(pathToFileURL(join(root, '.vitehub/nitro/workflow/dev-registry.mjs')).href)
    assert.deepEqual(Object.keys(registry.default), ['welcome'])
    assert.equal(await (await registry.default.welcome()).default(), 42)
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

test('public Box Home uploads overlap, copy callback bytes, and drain before cleanup', async () => {
  const { resolveBox } = await installed('@vite-hub/box')
  for (const mode of ['success', 'write-failure', 'directory-failure', 'resolve-failure', 'abort']) {
    const controller = new AbortController()
    const failure = new Error(`fixture ${mode}`)
    const files = new Map<string, Uint8Array>()
    const directories: string[] = []
    const callbacks: number[] = []
    let active = 0, peak = 0, stopped = 0, initialized = false, checkedRequirements = false
    const sdk = {
      fs: {
        exists: async () => false,
        async mkdir(path: string) {
          directories.push(path)
          active++; peak = Math.max(peak, active)
          try {
            await new Promise(resolve => setImmediate(resolve))
            if (mode === 'directory-failure' && path.endsWith('/skills')) throw failure
          }
          finally { active-- }
        },
        async writeFile(path: string, content: Uint8Array) {
          active++; peak = Math.max(peak, active)
          try {
            if (path.endsWith('/file-0') && mode === 'abort') controller.abort(failure)
            await new Promise(resolve => setImmediate(resolve))
            if (path.endsWith('/file-0') && mode === 'write-failure') throw failure
            files.set(path, Uint8Array.from(content))
          }
          finally { active-- }
        },
      },
      async stop() { assert.equal(active, 0); stopped++ },
      async runCommand() {
        assert.equal(active, 0); assert.equal(files.size, 20); checkedRequirements = true
        return { wait: async () => ({ exitCode: 0 }), stdout: async () => '', stderr: async () => '' }
      },
    }
    const shared = new Uint8Array([0, 0, 255])
    const box = await resolveBox({
      runtime: { kind: 'vercel', create: async () => sdk },
      requires: ['node'],
      home: { files: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`${index % 2 ? 'config' : 'skills'}/file-${index}`, {
        contents: async () => {
          callbacks.push(index)
          if (mode === 'resolve-failure' && index === 3) throw failure
          shared[0] = index
          return shared
        },
      }])) },
    }, {})
    const opening = box.open({ signal: controller.signal, initialize: async () => {
      assert.equal(active, 0); assert.equal(files.size, 20); assert.equal(checkedRequirements, true); initialized = true
    } })
    if (mode === 'success') {
      const session = await opening
      assert.ok(peak > 1 && peak <= 8, `upload concurrency ${peak}`)
      assert.deepEqual(callbacks, Array.from({ length: 20 }, (_, i) => i))
      for (let i = 0; i < 20; i++) assert.deepEqual(files.get(`/home/vitehub/${i % 2 ? 'config' : 'skills'}/file-${i}`), new Uint8Array([i, 0, 255]))
      assert.equal(directories.filter(path => path === '/home/vitehub/skills').length, 1)
      assert.equal(initialized, true)
      await session.close()
    }
    else {
      await assert.rejects(opening, error => error === failure)
      assert.equal(initialized, false)
      assert.deepEqual(callbacks, Array.from({ length: mode === 'resolve-failure' ? 4 : 8 }, (_, i) => i))
    }
    assert.equal(active, 0)
    assert.equal(stopped, 1)
  }
})

test('public Agent capability lists use the index and preserve exact matches, invalidation, and pagination', async () => {
  const { createLibsqlAgentInvocationStore } = await import(pathToFileURL(require.resolve('@vite-hub/agent/invocations/sqlite')).href)
  const agentRequire = createRequire(join(packageRoot('@vite-hub/agent'), 'package.json'))
  const { createClient } = agentRequire('@libsql/client')
  const client = createClient({ url: 'file::memory:' })
  const plans: string[] = []
  const connection = new Proxy(client, {
    get(target, property) {
      if (property === 'execute') return async (statement: string | { sql: string, args: unknown[] }) => {
        const sql = typeof statement === 'string' ? statement : statement.sql
        if (sql.startsWith('SELECT sequence, COALESCE(summary,')) {
          const result = await target.execute(typeof statement === 'string' ? `EXPLAIN QUERY PLAN ${sql}` : { ...statement, sql: `EXPLAIN QUERY PLAN ${sql}` })
          plans.push(...result.rows.map((row: { detail: string }) => row.detail))
        }
        return target.execute(statement)
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const store = createLibsqlAgentInvocationStore({ client: connection, maxAge: false, maxRecords: false })
  const timestamp = '2026-11-01T00:00:00.000Z'
  const event = (capabilityId: string, sequence = 1) => ({ name: 'agent.tool.call', attributes: { 'capability.id': capabilityId }, sequence, timestamp, type: 'run' })
  const record = (id: string, capabilityId: string) => ({ id, agentName: 'fixture', createdAt: timestamp, updatedAt: timestamp, status: 'running', traceId: id, observations: [event(capabilityId)] })
  try {
    await client.execute('CREATE TABLE vitehub_agent_invocations (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, record TEXT NOT NULL)')
    await client.execute({ sql: 'INSERT INTO vitehub_agent_invocations (id, status, record) VALUES (?, ?, ?)', args: ['legacy', 'running', JSON.stringify(record('legacy', 'github'))] })
    await store.create(record('first', 'github'))
    await store.create(record('other', 'shell'))
    await store.create(record('second', 'github'))
    await store.create(record('spaced', ' github '))
    await store.listCapabilityIds('fixture')
    const first = await store.list({ capabilityId: 'github', limit: 1 })
    assert.deepEqual(first.invocations.map(({ id }: { id: string }) => id), ['second'])
    const second = await store.list({ capabilityId: 'github', cursor: first.cursor, limit: 1 })
    assert.deepEqual(second.invocations.map(({ id }: { id: string }) => id), ['first'])
    const third = await store.list({ capabilityId: 'github', cursor: second.cursor, limit: 1 })
    assert.deepEqual(third.invocations.map(({ id }: { id: string }) => id), ['legacy'])
    assert.equal(third.cursor, undefined)
    assert.ok(plans.some(plan => plan.includes('USING INDEX vitehub_agent_invocations_sequence_capability_ids')))
    await store.update('other', { observation: event('github', 2), timestamp })
    assert.deepEqual((await store.list({ capabilityId: 'github' })).invocations.map(({ id }: { id: string }) => id), ['second', 'other', 'first', 'legacy'])
    await client.execute("UPDATE vitehub_agent_invocations SET capability_ids = NULL WHERE id = 'first'")
    assert.deepEqual((await store.list({ capabilityId: 'github' })).invocations.map(({ id }: { id: string }) => id), ['second', 'other', 'first', 'legacy'])
    plans.length = 0
    assert.deepEqual((await store.list({ capabilityId: 'github', status: ['running'], updatedSince: timestamp })).invocations.map(({ id }: { id: string }) => id), ['second', 'other', 'first', 'legacy'])
    assert.ok(plans.some(plan => plan.includes('_status_updated_at')), plans.join('\n'))
  }
  finally { client.close() }
})
