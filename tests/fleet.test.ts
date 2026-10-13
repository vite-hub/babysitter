// The fleet runtime runs real shell and git commands through a local transport, so
// these tests cover everything except the SSH hop itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFleet, parseFleetHosts, remoteCodexConfig } from '../server/fleet/fleet.ts'
import { createSshBoxRuntime, localTransport, loopbackPorts, type FleetBoxSession } from '../server/fleet/ssh-box.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()

function checkout() {
  const root = mkdtempSync(join(tmpdir(), 'fleet-test-'))
  const origin = join(root, 'origin.git')
  const work = join(root, 'checkout')
  execFileSync('git', ['init', '-q', '--bare', origin])
  mkdirSync(work)
  git(work, 'init', '-q')
  git(work, 'remote', 'add', 'origin', origin)
  writeFileSync(join(work, 'a.txt'), 'one\n')
  writeFileSync(join(work, 'gone.txt'), 'remove me\n')
  mkdirSync(join(work, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(work, 'node_modules', 'dep', 'index.js'), 'huge')
  writeFileSync(join(work, '.gitignore'), 'node_modules\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-qm', 'base')
  return { root, work }
}

function runtimeFor(root: string) {
  let closed = 0
  const runtime = createSshBoxRuntime({
    host: 'test',
    transport: localTransport(),
    root: join(root, 'remote'),
    path: process.env.PATH!,
    forwardPorts: [8317],
    codexConfig: work => `model_provider = "x"\n[projects.${JSON.stringify(work)}]\n`,
    onClose: () => { closed++ },
  })
  return { runtime, closed: () => closed }
}

async function open(root: string, work: string) {
  const { runtime, closed } = runtimeFor(root)
  const input = { cwd: work, identity: 'i', plan: { env: { EXTRA: async () => 'yes' }, files: { '.codex/AGENTS.md': { resolve: async () => Buffer.from('rules') } }, state: [] }, requirements: [{ args: [], command: 'git', name: 'git' }] }
  const plan = await runtime.prepare(input)
  assert.equal(plan.runtime, 'fleet')
  const session = await runtime.open(input, { executionAuthority: plan.executionAuthority }) as FleetBoxSession
  return { session, closed }
}

test('parses host lists and drops empty slots', () => {
  assert.deepEqual(parseFleetHosts('servarica=svc-fleet@servarica:10, idle=idle:0'), [{ name: 'servarica', target: 'svc-fleet@servarica', slots: 10 }])
  assert.throws(() => parseFleetHosts('servarica'), /name=user@host:slots/)
})

test('remote Codex config keeps providers and reads the bearer from the environment', () => {
  const config = remoteCodexConfig('model = "m"\n[projects."/tmp/a"]\ntrust_level = "trusted"\n[model_providers.cliproxy]\nbase_url = "http://127.0.0.1:8317/v1"\nexperimental_bearer_token = "secret"\n')('/w')
  assert.doesNotMatch(config, /secret|\/tmp\/a/)
  assert.match(config, /model = "m"/)
  assert.match(config, /\[model_providers\.cliproxy\]\nbase_url = "http:\/\/127\.0\.0\.1:8317\/v1"\nenv_key = "CLIPROXY_API_KEY"/)
  assert.match(config, /\[projects\."\/w"\]\ntrust_level = "trusted"/)
})

test('forwards loopback ports named by the provider launch', () => {
  assert.deepEqual(loopbackPorts(['-c', 'mcp_servers.t3-code.url="http://127.0.0.1:41234/mcp"', 'http://localhost:9'], [8317]), [8317, 41234])
})

test('fills local slots first, then healthy hosts, then overflows locally', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-place-'))
  const events: string[] = []
  const fleet = createFleet({
    localSlots: 1,
    hosts: [{ name: 'remote', target: 'unused', slots: 1 }],
    stateDirectory: join(root, 'state'),
    transport: () => localTransport(),
    minFreeBytes: 1,
    log: event => events.push(event),
  })
  const first = await fleet.place({ repository: 'o/r', number: 1 })
  const second = await fleet.place({ repository: 'o/r', number: 2 })
  const third = await fleet.place({ repository: 'o/r', number: 3 })
  assert.equal(first.host, 'local')
  assert.equal(second.host, 'remote')
  assert.equal(second.box?.runtime.name, 'fleet')
  assert.equal(third.host, 'local')
  assert.deepEqual(fleet.status().local, { active: 2, slots: 1, overflow: 1 })
  assert.equal(fleet.remoteActive(), 1)
  second.release()
  second.release()
  assert.equal(fleet.status().hosts[0]!.active, 0)
  assert.ok(events.includes('host.swept'))
  rmSync(root, { recursive: true, force: true })
})

test('a host missing pnpm is not eligible for fleet placement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-tools-test-'))
  const tools = join(root, 'tools')
  mkdirSync(tools)
  for (const name of ['git', 'codex', 'setsid', 'flock', 'tar']) symlinkSync('/usr/bin/true', join(tools, name))
  symlinkSync('/usr/bin/df', join(tools, 'df'))
  symlinkSync('/usr/bin/awk', join(tools, 'awk'))
  try {
    const fleet = createFleet({
      localSlots: 0,
      hosts: [{ name: 'missing-pnpm', target: 'unused', slots: 1 }],
      stateDirectory: join(root, 'state'),
      minFreeBytes: 1,
      transport: () => ({ start: script => spawn('/bin/sh', ['-c', script], { env: { ...process.env, HOME: root, PATH: tools }, stdio: 'pipe' }) }),
      log: () => {},
    })
    const placement = await fleet.place({ repository: 'o/r', number: 1 })
    assert.equal(placement.host, 'local')
    assert.equal(fleet.remoteActive(), 0)
    placement.release()
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a fleet Box mirrors the checkout without dependency trees and round-trips edits', async () => {
  const { root, work } = checkout()
  writeFileSync(join(work, 'untracked.txt'), 'host only\n')
  const { session, closed } = await open(root, work)
  try {
    assert.ok(session.cwd.startsWith(join(root, 'remote', 'boxes')))
    assert.equal((await session.exec('git', ['rev-parse', 'HEAD'])).stdout.trim(), git(work, 'rev-parse', 'HEAD'))
    assert.equal(existsSync(join(session.cwd, 'node_modules')), false)
    assert.equal(readFileSync(join(session.cwd, 'untracked.txt'), 'utf8'), 'host only\n')
    assert.equal((await session.exec('sh', ['-c', 'printf %s "$EXTRA:$HOME"'])).stdout, `yes:${join(session.cwd, '..', 'home')}`)
    assert.equal(readFileSync(join(session.cwd, '..', 'home', '.codex', 'AGENTS.md'), 'utf8'), 'rules')
    assert.match(readFileSync(join(session.cwd, '..', 'home', '.codex', 'config.toml'), 'utf8'), /model_provider = "x"/)

    // A commit in the Box reaches the mirror's objects through git, not the host.
    writeFileSync(join(session.cwd, 'a.txt'), 'two\n')
    rmSync(join(session.cwd, 'gone.txt'))
    writeFileSync(join(session.cwd, 'new.txt'), 'new\n')
    await session.importWorkspace(work)
    assert.equal(readFileSync(join(work, 'a.txt'), 'utf8'), 'two\n')
    assert.equal(existsSync(join(work, 'gone.txt')), false)
    assert.equal(readFileSync(join(work, 'new.txt'), 'utf8'), 'new\n')
    assert.equal(readFileSync(join(work, 'node_modules', 'dep', 'index.js'), 'utf8'), 'huge')

    assert.deepEqual((await session.files.read(join(session.cwd, 'missing'))), null)
    await session.files.write(join(session.cwd, 'dir', 'b.bin'), new Uint8Array([0, 1, 2]))
    assert.deepEqual([...(await session.files.read(join(session.cwd, 'dir', 'b.bin')))!], [0, 1, 2])
    assert.deepEqual((await session.files.list(join(session.cwd, 'dir'))).map(entry => [entry.path.split('/').at(-1), entry.type]), [['b.bin', 'file']])

    const child = await session.spawn!('sh', ['-c', 'read line; printf "%s:%s" "$line" "$SECRET"'], { env: { SECRET: 's3', PATH: '/nowhere' } })
    const writer = child.stdin!.getWriter()
    await writer.write(new TextEncoder().encode('hello\n'))
    await writer.close()
    assert.equal(await new Response(child.stdout).text(), 'hello:s3')
    assert.equal((await child.wait()).code, 0)

    const sleeper = await session.spawn!('sleep', ['30'])
    await sleeper.kill()
    assert.notEqual((await sleeper.wait()).code, 0)
  }
  finally {
    await session.close()
    await session.close()
  }
  assert.equal(closed(), 1)
  assert.equal(existsSync(session.cwd), false)

  // A second Box sends only new objects and still resolves history.
  git(work, 'add', '-A')
  git(work, 'commit', '-qm', 'next')
  const again = await open(root, work)
  assert.equal((await again.session.exec('git', ['log', '--format=%s', '-2'])).stdout.trim(), 'next\nbase')
  await again.session.close()
  rmSync(root, { recursive: true, force: true })
})

test('an incremental fleet bundle can omit an already mirrored HEAD', async () => {
  const { root, work } = checkout()
  let session: FleetBoxSession | undefined
  try {
    const initial = await open(root, work)
    await initial.session.close()
    const head = git(work, 'rev-parse', 'HEAD')
    const branch = git(work, 'branch', '--show-current')
    git(work, 'checkout', '-qb', 'other')
    writeFileSync(join(work, 'a.txt'), 'other branch\n')
    git(work, 'commit', '-qam', 'other')
    const other = git(work, 'rev-parse', 'HEAD')
    git(work, 'checkout', '-q', branch)

    session = (await open(root, work)).session
    assert.equal((await session.exec('git', ['rev-parse', 'HEAD'])).stdout.trim(), head)
    assert.equal((await session.exec('git', ['cat-file', '-t', other])).stdout.trim(), 'commit')
  }
  finally {
    await session?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('an incremental fleet bundle transfers a new detached HEAD', async () => {
  const { root, work } = checkout()
  let session: FleetBoxSession | undefined
  try {
    const initial = await open(root, work)
    await initial.session.close()
    git(work, 'checkout', '-q', '--detach')
    writeFileSync(join(work, 'a.txt'), 'detached\n')
    git(work, 'commit', '-qam', 'detached')
    const head = git(work, 'rev-parse', 'HEAD')

    session = (await open(root, work)).session
    assert.equal((await session.exec('git', ['rev-parse', 'HEAD'])).stdout.trim(), head)
    assert.equal((await session.exec('git', ['log', '--format=%s', '-2'])).stdout.trim(), 'detached\nbase')
  }
  finally {
    await session?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('the patched framework accepts tunnelled Box runtimes and places passes before installing', () => {
  let modules = join(process.cwd(), 'node_modules', 'vite-hub')
  modules = execFileSync('node', ['-e', 'console.log(require("fs").realpathSync(process.argv[1]))', modules], { encoding: 'utf8' }).trim()
  const dist = join(modules, '..', '@vite-hub', 'agent', 'dist')
  const files = execFileSync('ls', [dist], { encoding: 'utf8' }).split('\n').filter(name => name.endsWith('.js'))
  const source = files.map(name => readFileSync(join(dist, name), 'utf8')).join('\n')
  assert.match(source, /runtime\.network === "direct" && typeof runtime\.open === "function"/)
  assert.match(source, /fleetPlacement \?\?= await fleet\.place\(\{ repository, number \}\)/)
  assert.match(source, /presetOptions\.install !== false && !fleetPlacement\?\.box\) try \{/)
  assert.match(source, /fleetPlacement\?\.release\(\);/)
  assert.match(source, /remoteActive\?\.\(\) \?\? 0/)
  assert.match(source, /box\.session\.importWorkspace\(checkout, abortSignal\)/)
})
