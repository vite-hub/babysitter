import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const gate = resolve(import.meta.dirname, '../scripts/heavy-command-gate.cjs')

async function fakeTsc(root: string) {
  const script = join(root, 'node_modules/typescript/bin/tsc')
  await mkdir(join(root, 'node_modules/typescript/bin'), { recursive: true })
  await writeFile(script, `const started = Date.now(); setTimeout(() => { console.log(JSON.stringify({ started, ended: Date.now() })) }, 400)\n`)
  return script
}

function run(script: string, env: Record<string, string>) {
  return new Promise<{ started: number, ended: number }>((done, fail) => {
    const child = spawn(process.execPath, ['--require', gate, script], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.on('error', fail)
    child.on('exit', code => code === 0 ? done(JSON.parse(output)) : fail(new Error(`exit ${code}`)))
  })
}

test('heavy command gate serializes typecheck processes beyond the slot count', async t => {
  const root = await mkdtemp(join(tmpdir(), 'babysitter-heavy-gate-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const script = await fakeTsc(root)
  const env = { BABYSITTER_HEAVY_DIR: join(root, 'slots'), BABYSITTER_HEAVY_SLOTS: '1' }
  const runs = (await Promise.all([run(script, env), run(script, env), run(script, env)])).sort((a, b) => a.started - b.started)
  for (let index = 1; index < runs.length; index++) assert.ok(runs[index].started >= runs[index - 1].ended, 'runs must not overlap with one slot')
})

test('heavy command gate lets children of a slot holder run and reclaims dead holders', async t => {
  const root = await mkdtemp(join(tmpdir(), 'babysitter-heavy-gate-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const script = await fakeTsc(root)
  const slots = join(root, 'slots')
  await mkdir(slots, { recursive: true })
  await writeFile(join(slots, 'slot-0'), '999999999')
  const started = Date.now()
  await run(script, { BABYSITTER_HEAVY_DIR: slots, BABYSITTER_HEAVY_SLOTS: '1' })
  await run(script, { BABYSITTER_HEAVY_DIR: slots, BABYSITTER_HEAVY_SLOTS: '1', BABYSITTER_HEAVY_SLOT: join(slots, 'slot-0') })
  assert.ok(Date.now() - started < 5_000)
})

test('worker node wrapper loads the gate even when NODE_OPTIONS is replaced', async t => {
  const root = await mkdtemp(join(tmpdir(), 'babysitter-heavy-gate-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const script = await fakeTsc(root)
  const slots = join(root, 'slots')
  const wrapper = resolve(import.meta.dirname, '../scripts/worker-bin/node')
  const runOnce = () => new Promise<{ started: number, ended: number }>((done, fail) => {
    const child = spawn(wrapper, [script], { env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192', BABYSITTER_HEAVY_DIR: slots, BABYSITTER_HEAVY_SLOTS: '1' }, stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.on('error', fail)
    child.on('exit', code => code === 0 ? done(JSON.parse(output)) : fail(new Error(`exit ${code}`)))
  })
  const runs = (await Promise.all([runOnce(), runOnce()])).sort((a, b) => a.started - b.started)
  assert.ok(runs[1].started >= runs[0].ended, 'wrapped runs must not overlap with one slot')
})
