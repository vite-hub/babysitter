import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.resolve('vite-hub'))
const packageRoot = (name: string) => dirname(require.resolve(`${name}/package.json`))

// Private helpers are exposed in memory; the installed files stay untouched.
async function helpers(directory: string, symbol: string, trace = false) {
  const owners = await Promise.all((await readdir(directory)).filter(file => file.endsWith('.js')).map(async file => ({
    file, source: await readFile(join(directory, file), 'utf8'),
  })))
  const owner = owners.find(({ source }) => source.includes(`function ${symbol}(`))
  assert.ok(owner, `${directory} contains ${symbol}`)
  const url = `${pathToFileURL(join(directory, owner.file)).href}?startup-probe=${symbol}`
  const hooks = registerHooks({
    load(specifier, context, next) {
      const loaded = next(specifier, context)
      if (specifier !== url) return loaded
      let source = String(loaded.source)
      if (trace) {
        source = source.replace(/import \{ build([, }])/, 'import { build as probeBuild$1')
        source += '\nexport const probeCalls = []; const build = options => { probeCalls.push(options); return probeBuild(options); };'
      }
      return { ...loaded, source: `${source}\nexport { ${symbol} as probe };` }
    },
  })
  try { return await import(url) }
  finally { hooks.deregister() }
}

const workspaceRoots = [...new Set(['agent', 'source'].map(name => {
  const consumer = createRequire(require.resolve(`@vite-hub/${name}/package.json`))
  return dirname(consumer.resolve('@vite-hub/workspace/package.json'))
}))]
assert.equal(workspaceRoots.length, 2, 'exercise both installed Workspace peer instances')

for (const [index, root] of workspaceRoots.entries()) {
  for (const reuseStartupSnapshots of [false, true]) {
    test(`Workspace instance ${index + 1} reads mounted paths without inspecting siblings, reuse=${reuseStartupSnapshots}`, async () => {
      const directory = join(root, 'dist')
      const { custom } = await import(pathToFileURL(join(directory, 'index.js')).href)
      const { probe: createView } = await helpers(directory, 'createWorkspaceSourceView')
      const { probe: createStore } = await helpers(directory, 'createMemoryWorkspaceStore')
      const store = createStore()
      const definition = {
        name: 'docs',
        sources: { docs: custom({ materialize: 'startup', mount: 'docs', files: [
          { path: 'first.md', content: 'first' }, { path: 'second.md', content: 'second' },
        ] }) },
      }
      const view = createView(definition, store, { reuseStartupSnapshots })
      assert.equal(await view.readFile('docs/first.md'), 'first')
      const calls: string[] = []
      for (const method of ['readFile', 'stat', 'list']) {
        const original = store[method].bind(store)
        store[method] = async (path: string, ...args: unknown[]) => {
          calls.push(`${method}:${path}`)
          return original(path, ...args)
        }
      }
      const pointRead = async (path: string, expected: string) => {
        calls.length = 0
        assert.equal(await view.readFile(path), expected)
        assert.ok(!calls.some(call => call.endsWith(':docs/second.md') || call.startsWith('list:')), calls.join(', '))
      }
      await pointRead('docs/first.md', 'first')
      calls.length = 0
      await assert.rejects(view.readFile('docs/missing.md'), /does not exist|not found/i)
      assert.ok(!calls.some(call => /:(docs\/(first|second)\.md)$/.test(call) || call.startsWith('list:')), calls.join(', '))
      if (reuseStartupSnapshots) {
        const reused = createView(definition, store, { reuseStartupSnapshots })
        calls.length = 0
        assert.equal(await reused.readFile('docs/first.md'), 'first')
        assert.ok(!calls.some(call => call.endsWith(':docs/second.md') || call.startsWith('list:')), calls.join(', '))
      }

      const other = createView({ name: 'other', sources: { docs: custom({
        materialize: 'startup', mount: 'docs', files: [{ path: 'second.md', content: 'other' }],
      }) } }, store)
      assert.equal(await other.readFile('docs/second.md'), 'other')
      await pointRead('docs/first.md', 'first')
      assert.equal((await store.readFile('docs/second.md')).content, 'other')
      assert.equal(await view.readFile('docs/second.md'), 'second')
      await other.materializeSources()
      await view.list('docs')
      assert.equal((await store.readFile('docs/second.md')).content, 'second', 'list validates the complete snapshot')
      await store.rm('docs/first.md')
      assert.equal(await view.readFile('docs/first.md'), 'first', 'a missing owned file is recovered')
    })
  }
}

test('Agent skips schema-free snapshots and retains schema and direct-runtime mutation validation', async () => {
  const { defineAgent, defineCapability, runAgent } = await import('vite-hub/agent')
  let traversals = 0
  const data = { records: new Proxy([{ id: 1 }], { ownKeys(target) { traversals++; return Reflect.ownKeys(target) } }) }
  let runs = 0
  const agent = defineAgent({ runtime: false, driver: { run: ({ input }) => {
    runs++
    assert.equal(input.data, data)
    return 'ok'
  } } })
  const [error, result] = await runAgent(agent, { data })
  assert.equal(error, null)
  assert.equal(result, 'ok')
  assert.equal(runs, 1)
  assert.equal(traversals, 0)

  const v = await import(pathToFileURL(require.resolve('valibot', { paths: [packageRoot('@vite-hub/agent')] })).href)
  for (const deferred of [false, true]) {
    const schemaAgent = defineAgent({
      runtime: false,
      data: v.object({ count: v.number() }),
      capabilities: [defineCapability({ id: 'mutator', ...(deferred ? { prepare() {} } : {}), input(context) {
        Reflect.set(context.input.get().data, 'count', 'invalid')
      } })],
      driver: { run() { assert.fail('invalid mutated data must not reach the Driver') } },
    })
    const [validationError, invalidResult] = await runAgent(schemaAgent, { data: { count: 1 } })
    assert.equal(invalidResult, null)
    assert.match(String(validationError), /Invalid Agent input data/)
  }
  const { probe: resolveCapabilities } = await helpers(join(packageRoot('@vite-hub/agent'), 'dist'), 'resolveAgentCapabilities')
  const runtime = { capabilities: {}, memo() {}, runtime: 'unknown', runtimeConfig: {}, waitUntil() {} }
  const mutable = { nested: { count: 1 } }
  const capabilities = await resolveCapabilities(undefined, runtime, { data: mutable })
  assert.equal(capabilities.inputDataChanged(), false)
  mutable.nested.count++
  assert.equal(capabilities.inputDataChanged(), true)
  capabilities.setInputDataBaseline({ data: mutable })
  assert.equal(capabilities.inputDataChanged(), false)
  mutable.nested.count++
  assert.equal(capabilities.inputDataChanged(), true)
})

for (const name of ['agent', 'database', 'queue', 'schedule', 'workflow']) {
  test(`${name} traces static dependencies once per host variant and retains their current bytes`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'babysitter-trace-'))
    try {
      const { probe: retain, probeCalls } = await helpers(join(packageRoot(`@vite-hub/${name}`), 'dist'), 'retainProviderOutputSources', true)
      await mkdir(join(root, 'server'))
      await writeFile(join(root, 'package.json'), '{"type":"module"}')
      const entry = join(root, 'server/entry.ts')
      const dependency = join(root, 'server/dependency.ts')
      const leaf = join(root, 'server/leaf.ts')
      await writeFile(entry, 'export { value } from "./dependency.ts"\n')
      await writeFile(dependency, 'export { value } from "./leaf.ts"\n')
      for (const value of ['first', 'updated']) {
        await writeFile(leaf, `export const value = ${JSON.stringify(value)}\n`)
        probeCalls.length = 0
        const retained = await retain({ artifactDir: join(root, `.vitehub/${value}`), paths: [entry], roots: [root] })
        for (const path of [entry, dependency, leaf]) {
          assert.equal(await readFile(retained.resolve(path), 'utf8'), await readFile(path, 'utf8'))
        }
        assert.equal(probeCalls.length, 5, 'only the five host variants need a build')
        for (const call of probeCalls) assert.deepEqual(call.entryPoints, [entry])
      }

      await mkdir(join(root, 'server/platform'))
      await mkdir(join(root, 'server/lib'))
      await mkdir(join(root, 'dist'))
      await writeFile(join(root, '.git'), 'fixture boundary\n')
      await writeFile(entry, 'export { value } from "./shared.ts"; export { host } from "./platform"\n')
      await writeFile(join(root, 'server/shared.ts'), 'export { value } from "./lib"\n')
      await writeFile(join(root, 'server/platform/package.json'), '{"main":"./node.ts","module":"./node.ts","type":"module"}')
      await writeFile(join(root, 'server/platform/node.ts'), 'export const host = "node"\n')
      await writeFile(join(root, 'server/lib/package.json'), '{"main":"./node.ts","module":"./index.ts","type":"module"}')
      await writeFile(join(root, 'server/lib/node.ts'), 'export const value = "node"\n')
      await writeFile(join(root, 'server/lib/index.ts'), 'export { value } from "../../dist/worker-value"\n')
      const workerValue = join(root, 'dist/worker-value.ts')
      await writeFile(workerValue, 'export const value = "worker"\n')
      const recovered = await retain({ artifactDir: join(root, '.vitehub/retry'), paths: [entry], roots: [root] })
      assert.equal(await readFile(recovered.resolve(workerValue), 'utf8'), await readFile(workerValue, 'utf8'))
      const { probe: bundle } = await helpers(join(packageRoot(`@vite-hub/${name}`), 'dist'), 'bundleEsmEntry')
      const output = join(root, '.vitehub/worker.mjs')
      await bundle(recovered.resolve(entry), output, {
        conditions: ['workerd', 'worker', 'browser', 'default'], platform: 'neutral', rootDir: recovered.resolve(root),
      })
      const built = await import(pathToFileURL(output).href)
      assert.equal(built.host, 'node')
      assert.equal(built.value, 'worker')
    }
    finally { await rm(root, { recursive: true, force: true }) }
  })
}
