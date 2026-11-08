import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { watch } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { createSshBoxRuntime, localTransport } from '../server/fleet/ssh-box.ts'

async function fixture() {
  await mkdir('.data/tests', { recursive: true })
  const root = await mkdtemp(resolve('.data/tests/corepack-bootstrap-'))
  const checkout = join(root, 'source')
  const bin = join(root, 'bin')
  await mkdir(checkout)
  await mkdir(bin)
  await writeFile(join(bin, 'package.json'), '{"type":"commonjs"}\n')
  await writeFile(join(checkout, 'package.json'), JSON.stringify({ name: 'fixture', packageManager: 'pnpm@10.33.0' }))
  await writeFile(join(checkout, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  execFileSync('git', ['init', '-q', checkout])
  execFileSync('git', ['-C', checkout, 'add', '.'])
  execFileSync('git', ['-C', checkout, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'])
  const runtime = createSshBoxRuntime({ host: 'test', transport: localTransport(), root: join(root, 'fleet'), path: `${bin}:${process.env.PATH}` })
  const input = { cwd: checkout, identity: 'test', plan: { env: {}, files: {}, state: [] }, requirements: [] }
  const plan = await runtime.prepare(input)
  const executable = async (name: string, source: string) => {
    await writeFile(join(bin, name), source)
    await chmod(join(bin, name), 0o755)
  }
  return { root, bin, runtime, input, plan, executable }
}

test('standalone pnpm installs without invoking an available Corepack', async () => {
  const f = await fixture()
  try {
    await f.executable('pnpm', '#!/bin/sh\nexit 0\n')
    await f.executable('corepack', '#!/bin/sh\nexit 91\n')
    const session = await f.runtime.open(f.input, { executionAuthority: f.plan.executionAuthority })
    try {
      const record = JSON.parse(Buffer.from((await session.files.read(`${session.cwd}/.git/vitehub-install.json`))!).toString())
      assert.equal(record.status, 'installed', record.reason)
    }
    finally { await session.close() }
  }
  finally { await rm(f.root, { recursive: true, force: true }) }
})

test('cancelled Corepack downloads release their pin lock and remove staging files', { timeout: 20_000 }, async () => {
  const f = await fixture()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  const watcher = watch(f.root, { persistent: false })
  const started = new Promise<void>(resolve => watcher.on('change', (_, name) => { if (name === 'seed-started') resolve() }))
  let opened: ReturnType<typeof f.runtime.open> | undefined
  try {
    await mkdir(join(f.bin, 'lib'))
    await writeFile(join(f.bin, 'lib/corepack.cjs'), 'exports.runMain = () => {}\n')
    await f.executable('pnpm', "#!/usr/bin/env node\nrequire('./lib/corepack.cjs').runMain(['pnpm', ...process.argv.slice(2)]);\n")
    await f.executable('corepack', `#!/usr/bin/env node\nconst fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(join(f.root, 'pid'))}, String(process.pid)); fs.writeFileSync(${JSON.stringify(join(f.root, 'seed-started'))}, 'ready'); setTimeout(() => {}, 30000);\n`)
    opened = f.runtime.open(f.input, { executionAuthority: f.plan.executionAuthority, signal: controller.signal })
    await Promise.race([started, opened.then(() => { throw new Error('download did not start') })])
    controller.abort()
    await assert.rejects(opened, /abort/i)
    const cacheRoot = join(f.root, 'fleet/pnpm-cache/corepack-seeds-v1')
    const key = createHash('sha256').update('pnpm@10.33.0').digest('hex')
    assert.equal(spawnSync('flock', ['-n', join(cacheRoot, `${key}.lock`), 'true']).status, 0, 'cancelled download retained its pin lock')
    assert.equal((await readdir(cacheRoot)).some(name => name.includes('.tmp.')), false)
  }
  finally {
    controller.abort()
    clearTimeout(timer)
    watcher.close()
    await opened?.catch(() => undefined)
    const pid = await readFile(join(f.root, 'pid'), 'utf8').catch(() => '')
    if (/^\d+$/.test(pid)) {
      const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')
      if (command.split('\0').includes(join(f.bin, 'corepack'))) process.kill(Number(pid), 'SIGKILL')
    }
    await rm(f.root, { recursive: true, force: true })
  }
})
