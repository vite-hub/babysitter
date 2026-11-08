import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { createSshBoxRuntime, localTransport } from '../server/fleet/ssh-box.ts'

test('fleet Corepack cache survives failed and cancelled Boxes without sharing workspaces', async () => {
  await mkdir('.data/tests', { recursive: true })
  const root = await mkdtemp(resolve('.data/tests/fleet-corepack-'))
  const checkout = join(root, 'checkout')
  await mkdir(checkout)
  execFileSync('git', ['init', '-q', checkout])
  await writeFile(join(checkout, 'package.json'), '{"name":"fixture","packageManager":"pnpm@10.33.0"}\n')
  execFileSync('git', ['-C', checkout, 'add', '.'])
  execFileSync('git', ['-C', checkout, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'])
  const fleetRoot = join(root, 'fleet')
  const runtime = createSshBoxRuntime({ host: 'test', transport: localTransport(), root: fleetRoot, path: process.env.PATH! })
  const input = { cwd: checkout, identity: 'test', plan: { env: {}, files: {}, state: [] }, requirements: [] }
  const plan = await runtime.prepare(input)
  const cache = join(fleetRoot, 'pnpm-cache', 'corepack')
  try {
    const first = await runtime.open(input, { executionAuthority: plan.executionAuthority })
    const firstWork = first.cwd
    try {
      const env = await first.exec('sh', ['-c', 'printf %s "$COREPACK_HOME"'])
      assert.equal(env.stdout, cache)
      assert.equal(env.code, 0)
      assert.equal((await first.exec('sh', ['-c', 'printf %s "$COREPACK_HOME"'], { env: { COREPACK_HOME: '/coordinator-only' } })).stdout, cache)
      await first.files.mkdir(cache, { recursive: true })
      await first.files.write(join(cache, 'marker'), Buffer.from('manager cache'))
      await first.files.write(join(first.cwd, 'untracked'), Buffer.from('private workspace'))
    }
    finally { await first.close() }

    await assert.rejects(runtime.open({ ...input, requirements: [{ command: 'missing-fixture-command', name: 'missing', args: [] }] }, { executionAuthority: plan.executionAuthority }), /missing the Box requirement missing/)
    const controller = new AbortController()
    const cancelled = { ...input, plan: { ...input.plan, files: { cancelled: { resolve: async () => { controller.abort(); return Buffer.from('cancelled') } } } } }
    await assert.rejects(runtime.open(cancelled, { executionAuthority: plan.executionAuthority, signal: controller.signal }), /abort/i)
    assert.deepEqual(await readdir(join(fleetRoot, 'boxes')), [])

    const second = await runtime.open(input, { executionAuthority: plan.executionAuthority })
    try {
      assert.notEqual(second.cwd, firstWork)
      assert.equal(Buffer.from((await second.files.read(join(cache, 'marker')))!).toString(), 'manager cache')
      assert.equal(await second.files.exists(join(second.cwd, 'untracked')), false)
      assert.equal((await second.exec('git', ['status', '--porcelain'])).stdout, '')
    }
    finally { await second.close() }
    await writeFile(join(checkout, 'package.json'), '{"name":"fixture"}\n')
    const unpinned = await runtime.open(input, { executionAuthority: plan.executionAuthority })
    try {
      const env = await unpinned.exec('sh', ['-c', 'printf "%s\\n%s" "$COREPACK_HOME" "$HOME"'])
      const [corepack, home] = env.stdout.split('\n')
      assert.equal(corepack, `${home}/.cache/node/corepack`)
      assert.notEqual(corepack, cache)
    }
    finally { await unpinned.close() }
  }
  finally { await rm(root, { recursive: true, force: true }) }
})
