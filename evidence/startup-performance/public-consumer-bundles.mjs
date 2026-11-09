import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const require = createRequire(import.meta.resolve('vite-hub'))
const agentRequire = createRequire(require.resolve('@vite-hub/agent/package.json'))
const { build } = await import(pathToFileURL(agentRequire.resolve('esbuild')).href)
const output = resolve('.vitehub/provider-safety/public-bundles')
await mkdir(output, { recursive: true })
for (const [name, symbol] of Object.entries({ agent: 'hubAgent', database: 'hubDb', queue: 'hubQueue', schedule: 'hubSchedule', workflow: 'hubWorkflow' })) {
  const owner = `@vite-hub/${name}`
  const entry = require.resolve(`${owner}/vite`)
  const outfile = join(output, `${name}.mjs`)
  const result = await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', metafile: true, logLevel: 'silent' })
  const root = dirname(require.resolve(`${owner}/package.json`))
  const inputs = Object.keys(result.metafile.inputs).map(path => resolve(path)).filter(path => path.startsWith(root))
  assert.ok(inputs.length > 0, `${owner}: public Vite entry loads its compiled owner`)
  assert.ok(Object.values(result.metafile.outputs).some(file => file.exports.includes(symbol)), `${owner}: public plugin export survives bundling`)
  console.log(`${owner}/vite: bundled public entry and ${symbol} export, dependencies external`)
}
