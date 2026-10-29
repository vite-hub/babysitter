// The heavy-command gate is preloaded into every worker Node process. These tests run it the same
// way, with fake tsc and package-manager scripts in place of the real ones.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const gate = join(import.meta.dirname, '../scripts/heavy-command-gate.cjs')
const { isHeavyCommand, slotFiles } = createRequire(import.meta.url)(gate) as {
  isHeavyCommand: (script: string, args: string[]) => boolean
  slotFiles: (lock: string, slots: number) => string[]
}
const skip = spawnSync('flock', ['--version']).status === 0 ? false : 'flock is not installed'

test('the gate covers typecheck, test and dependency installs, not other package-manager commands', () => {
  const corepack = '/usr/local/lib/node_modules/corepack/dist/corepack.js'
  const pnpm = '/opt/node24/lib/node_modules/corepack/dist/pnpm.js'
  const npm = '/opt/node24/lib/node_modules/npm/bin/npm-cli.js'
  const heavy: Array<[string, string[]]> = [
    ['/w/node_modules/typescript/bin/tsc', ['--noEmit']],
    ['/w/node_modules/vitest/vitest.mjs', ['run']],
    [corepack, ['pnpm@10.34.6', 'install', '--frozen-lockfile', '--ignore-scripts']],
    [corepack, ['pnpm', 'i']],
    [corepack, ['pnpm', '--dir', 'packages/a', 'add', 'left-pad']],
    [corepack, ['npm@11.6.3', 'ci', '--ignore-scripts']],
    [pnpm, ['install']],
    [pnpm, ['--filter', 'web', 'install']],
    [pnpm, ['-C=packages/a', 'add', 'x']],
    ['/home/agents/.cache/node/corepack/v1/pnpm/12.16.1/bin/pnpm.cjs', ['install']],
    [npm, ['install']],
    [npm, ['ci']],
    ['/opt/node24/lib/node_modules/corepack/dist/npm.js', ['i', 'x']],
  ]
  const light: Array<[string, string[]]> = [
    [corepack, ['pnpm', 'exec', 'vitest', 'run']],
    [corepack, ['pnpm', '--dir', 'install', 'run', 'build']],
    [corepack, ['pnpm', '--version']],
    [corepack, ['yarn@1.22.22', 'install']],
    [pnpm, ['run', 'install']],
    [pnpm, []],
    [npm, ['run', 'ci']],
    ['/w/scripts/install.js', ['install']],
  ]
  for (const [script, args] of heavy) assert.equal(isHeavyCommand(script, args), true, `${script} ${args.join(' ')}`)
  for (const [script, args] of light) assert.equal(isHeavyCommand(script, args), false, `${script} ${args.join(' ')}`)
  assert.deepEqual(slotFiles('/l/heavy-command.lock', 3), ['/l/heavy-command.lock', '/l/heavy-command.lock.1', '/l/heavy-command.lock.2'])
})

function fixture(slots: number) {
  const root = mkdtempSync(join(tmpdir(), 'heavy-gate-'))
  const lock = join(root, 'heavy-command.lock')
  for (const file of slotFiles(lock, slots)) writeFileSync(file, '')
  const log = join(root, 'events.log')
  // Each fake command logs its start and end, holds for `hold` ms, and can run a nested command.
  const body = `const { appendFileSync } = require('node:fs'); const { spawnSync } = require('node:child_process')
const [name, hold, nested] = process.argv.slice(process.argv.indexOf('--') + 1)
appendFileSync(${JSON.stringify(log)}, 'start ' + name + '\\n')
if (nested) { const r = spawnSync(process.execPath, ['--require', ${JSON.stringify(gate)}, ${JSON.stringify(join(root, 'node_modules/typescript/bin/tsc'))}, '--', nested, '0'], { stdio: 'inherit' }); if (r.status) process.exit(r.status) }
setTimeout(() => appendFileSync(${JSON.stringify(log)}, 'end ' + name + '\\n'), Number(hold))`
  const scripts = {
    tsc: join(root, 'node_modules/typescript/bin/tsc'),
    corepack: join(root, 'corepack/dist/corepack.js'),
  }
  for (const file of Object.values(scripts)) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, body)
  }
  const env: NodeJS.ProcessEnv = { ...process.env, BABYSITTER_HEAVY_LOCK: lock, BABYSITTER_HEAVY_SLOTS: String(slots) }
  delete env.BABYSITTER_HEAVY_SLOT
  delete env.FLEET_QUEUE_ACTIVE
  const run = (script: string, args: string[], extraEnv: Record<string, string> = {}) => new Promise<{ code: number | null; stderr: string }>(resolve => {
    const child = spawn(process.execPath, ['--require', gate, script, ...args], { env: { ...env, ...extraEnv }, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', code => resolve({ code, stderr }))
  })
  const events = () => readFileSync(log, 'utf8').trim().split('\n')
  const peak = () => {
    let running = 0
    let max = 0
    for (const event of events()) {
      running += event.startsWith('start') ? 1 : -1
      max = Math.max(max, running)
    }
    return max
  }
  return { root, lock, scripts, run, events, peak, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('BABYSITTER_HEAVY_SLOTS heavy commands run at once, and the rest wait', { skip }, async () => {
  const gated = fixture(2)
  try {
    const results = await Promise.all(['a', 'b', 'c'].map(name => gated.run(gated.scripts.tsc, ['--', name, '1500'])))
    assert.deepEqual(results.map(result => result.code), [0, 0, 0])
    assert.equal(gated.peak(), 2)
    assert.equal(results.filter(result => /Waiting for one of 2 shared/.test(result.stderr)).length, 1)
  } finally { gated.cleanup() }
})

test('pnpm and npm installs through Corepack share the slots with typecheck and tests', { skip }, async () => {
  const gated = fixture(1)
  try {
    const results = await Promise.all([
      gated.run(gated.scripts.corepack, ['pnpm@10.34.6', 'install', '--frozen-lockfile', '--', 'install', '800']),
      gated.run(gated.scripts.corepack, ['npm@11.6.3', 'ci', '--', 'ci', '800']),
      gated.run(gated.scripts.tsc, ['--', 'tsc', '800']),
    ])
    assert.deepEqual(results.map(result => result.code), [0, 0, 0])
    assert.equal(gated.peak(), 1)
    // `pnpm exec` itself is not heavy; only the command it runs is.
    const exec = gated.run(gated.scripts.corepack, ['pnpm', 'exec', '--', 'exec', '0'])
    assert.equal((await exec).code, 0)
  } finally { gated.cleanup() }
})

test('a command holding a slot runs nested heavy commands without waiting on itself', { skip }, async () => {
  const gated = fixture(1)
  try {
    const [outer, other] = await Promise.all([
      gated.run(gated.scripts.corepack, ['pnpm', 'install', '--', 'install', '300', 'postinstall-tsc']),
      new Promise<{ code: number | null; stderr: string }>(resolve => setTimeout(() => resolve(gated.run(gated.scripts.tsc, ['--', 'other', '0'])), 200)),
    ])
    assert.equal(outer.code, 0)
    assert.equal(other.code, 0)
    assert.doesNotMatch(outer.stderr, /Waiting/)
    const events = gated.events()
    assert.ok(events.indexOf('start postinstall-tsc') < events.indexOf('start other'), events.join(', '))
    assert.equal(gated.peak(), 2, 'only the nested command overlaps its parent')
  } finally { gated.cleanup() }
})

test('missing slot locks fail closed, and missing extra slots fall back to the ones present', { skip }, async () => {
  const gated = fixture(1)
  try {
    const partial = await gated.run(gated.scripts.tsc, ['--', 'partial', '0'], { BABYSITTER_HEAVY_SLOTS: '3' })
    assert.equal(partial.code, 0)
    assert.match(partial.stderr, /Only 1 of 3 heavy-command slot locks exist/)
    const missing = await gated.run(gated.scripts.tsc, ['--', 'missing', '0'], { BABYSITTER_HEAVY_LOCK: join(gated.root, 'absent.lock') })
    assert.equal(missing.code, 1)
    assert.match(missing.stderr, /Shared heavy-command lock is unavailable/)
  } finally { gated.cleanup() }
})
