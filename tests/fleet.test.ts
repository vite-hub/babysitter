// The fleet runtime runs real shell and git commands through a local transport, so
// these tests cover everything except the SSH hop itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, chmodSync, symlinkSync, readlinkSync, statSync, lstatSync, utimesSync, lutimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFleet, FleetCapacityError, parseFleetHosts, remoteCodexConfig } from '../server/fleet/fleet.ts'
import { createSshBoxRuntime, localTransport, loopbackPorts, q, remapLoopback, type FleetBoxSession } from '../server/fleet/ssh-box.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()

function staticTransport(lines: string[]) {
  const output = JSON.stringify(`${lines.join('\n')}\n`)
  return { start: () => spawn(process.execPath, ['-e', `process.stdout.write(${output})`], { stdio: 'pipe' }) }
}

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

test('provider processes use the host ports their tunnel was given', async () => {
  const { root, work } = checkout()
  let closedTunnels = 0
  const transport = { ...localTransport(), tunnel: async (ports: readonly number[]) => ({ ports: new Map(ports.map(port => [port, port + 10000])), close: () => { closedTunnels++ } }) }
  const runtime = createSshBoxRuntime({ host: 'test', transport, root: join(root, 'remote'), path: process.env.PATH!, forwardPorts: [8317], codexConfig: () => 'base_url = "http://127.0.0.1:8317/v1"\n' })
  const input = { cwd: work, identity: 'i', plan: { env: {}, files: {}, state: [] }, requirements: [] }
  const plan = await runtime.prepare(input)
  const session = await runtime.open(input, { executionAuthority: plan.executionAuthority }) as FleetBoxSession
  try {
    const child = await session.spawn!('sh', ['-c', 'printf "%s|%s|" "$1" "$OPENAI_BASE_URL"; cat "$HOME/.codex/config.toml"', 'sh', 'url="http://127.0.0.1:41234/mcp"'], { env: { OPENAI_BASE_URL: 'http://127.0.0.1:8317/v1' } })
    assert.equal(await new Response(child.stdout).text(), 'url="http://127.0.0.1:51234/mcp"|http://127.0.0.1:18317/v1|base_url = "http://127.0.0.1:18317/v1"\n')
    await child.wait()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(closedTunnels, 1)
  }
  finally {
    await session.close()
    rmSync(root, { recursive: true, force: true })
  }
  assert.equal(remapLoopback('localhost:9 127.0.0.1:8317', new Map([[8317, 1]])), 'localhost:9 127.0.0.1:1')
})

test('fills local slots first, then healthy hosts, without overflowing local capacity', async () => {
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
  await assert.rejects(() => fleet.place({ repository: 'o/r', number: 3 }), (error: unknown) => error instanceof FleetCapacityError)
  assert.equal(first.host, 'local')
  assert.equal(second.host, 'remote')
  assert.equal(second.box?.runtime.name, 'fleet')
  assert.equal(fleet.status().local.active, 1)
  assert.equal(fleet.status().local.overflow, 0)
  assert.equal(fleet.remoteActive(), 1)
  second.release()
  second.release()
  assert.equal(fleet.status().hosts[0]!.active, 0)
  assert.ok(events.includes('host.swept'))
  rmSync(root, { recursive: true, force: true })
})

test('keeps slot ceilings under concurrent placement requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-concurrent-'))
  const fleet = createFleet({
    localSlots: 1,
    hosts: [{ name: 'remote', target: 'unused', slots: 1 }],
    stateDirectory: join(root, 'state'),
    transport: () => staticTransport(['/home/fake', '10000000', String(8 * 1024 * 1024), '0', 'tools-ok']),
    minFreeBytes: 1,
    localResources: () => ({ availableMemoryBytes: 8 * 1024 ** 3, memoryPressure: 0 }),
  })
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, number) => fleet.place({ repository: 'o/r', number })))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2)
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason instanceof FleetCapacityError).length, 6)
  assert.equal(fleet.status().local.active, 1)
  assert.equal(fleet.status().hosts[0]!.active, 1)
  assert.equal(fleet.status().local.overflow, 0)
  for (const result of results) if (result.status === 'fulfilled') result.value.release()
  rmSync(root, { recursive: true, force: true })
})

test('moves work to a healthy remote host when local memory is constrained', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-memory-'))
  const fleet = createFleet({
    localSlots: 2,
    hosts: [{ name: 'remote', target: 'unused', slots: 2 }],
    stateDirectory: join(root, 'state'),
    transport: () => localTransport(),
    minFreeBytes: 1,
    minFreeMemoryBytes: 2 * 1024 ** 3,
    localResources: () => ({ availableMemoryBytes: 1 * 1024 ** 3, memoryPressure: 0 }),
  })
  const placement = await fleet.place({ repository: 'o/r', number: 1 })
  assert.equal(placement.host, 'remote')
  assert.equal(fleet.status().local.active, 0)
  placement.release()
  rmSync(root, { recursive: true, force: true })
})

test('limits remote admissions by memory and pressure without local overflow', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-remote-memory-'))
  const fleet = createFleet({
    localSlots: 1,
    hosts: [{ name: 'remote', target: 'unused', slots: 3 }],
    stateDirectory: join(root, 'state'),
    transport: () => staticTransport(['/home/fake', '10000000', String(3 * 1024 * 1024), '0', 'tools-ok']),
    minFreeBytes: 1,
    minFreeMemoryBytes: 2 * 1024 ** 3,
    memoryPerSlotBytes: 512 * 1024 ** 2,
    localResources: () => ({ availableMemoryBytes: 1 * 1024 ** 3, memoryPressure: 0 }),
  })
  const first = await fleet.place({ repository: 'o/r', number: 1 })
  const second = await fleet.place({ repository: 'o/r', number: 2 })
  assert.equal(first.host, 'remote')
  assert.equal(second.host, 'remote')
  await assert.rejects(() => fleet.place({ repository: 'o/r', number: 3 }), (error: unknown) => error instanceof FleetCapacityError)
  assert.equal(fleet.status().hosts[0]!.active, 2)
  first.release()
  second.release()
  rmSync(root, { recursive: true, force: true })
})

test('admission refreshes local resources before the scheduler claims work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-admission-'))
  let availableMemoryBytes = 3 * 1024 ** 3
  const fleet = createFleet({
    localSlots: 2,
    hosts: [{ name: 'remote', target: 'unused', slots: 2 }],
    stateDirectory: join(root, 'state'),
    transport: () => staticTransport(['/home/fake', '10000000', String(3 * 1024 * 1024), '0', 'tools-ok']),
    minFreeBytes: 1,
    minFreeMemoryBytes: 2 * 1024 ** 3,
    localResources: () => ({ availableMemoryBytes, memoryPressure: 0 }),
  })

  assert.equal((await fleet.admission()).local.admitted, 2)
  availableMemoryBytes = 2 * 1024 ** 3
  const reduced = await fleet.admission()
  assert.equal(reduced.local.admitted, 0)
  assert.equal(reduced.hosts[0]!.admitted, 2)
  assert.equal(fleet.status().local.admitted, 0)
  rmSync(root, { recursive: true, force: true })
})

test('rejects a remote host under memory pressure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-pressure-'))
  const fleet = createFleet({
    localSlots: 1,
    hosts: [{ name: 'remote', target: 'unused', slots: 1 }],
    stateDirectory: join(root, 'state'),
    transport: () => localTransport(),
    minFreeBytes: 1,
    localResources: () => ({ availableMemoryBytes: 1 * 1024 ** 3, memoryPressure: 0 }),
    hostResources: () => ({ availableMemoryBytes: 8 * 1024 ** 3, memoryPressure: 6 }),
  })
  await assert.rejects(() => fleet.place({ repository: 'o/r', number: 1 }), (error: unknown) => error instanceof FleetCapacityError)
  assert.equal(fleet.status().local.overflow, 0)
  rmSync(root, { recursive: true, force: true })
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
    // Temporary files stay in the Box directory, which close removes.
    assert.equal((await session.exec('sh', ['-c', 'test -d "$TMPDIR" && printf %s "$TMPDIR"'], { env: { TMPDIR: '/host/tmp' } })).stdout, join(session.cwd, '..', 'tmp'))
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

  // A Box for a HEAD the mirror already has gets a bundle without HEAD, or no bundle.
  for (const step of ['branch', 'same']) {
    if (step === 'branch') {
      // New objects on another ref, HEAD unchanged: the bundle carries the ref but not HEAD.
      const head = git(work, 'rev-parse', 'HEAD')
      git(work, 'checkout', '-q', '-b', 'side')
      git(work, 'commit', '-q', '--allow-empty', '-m', 'side')
      git(work, 'checkout', '-q', head)
    }
    const reopened = await open(root, work)
    assert.equal((await reopened.session.exec('git', ['rev-parse', 'HEAD'])).stdout.trim(), git(work, 'rev-parse', 'HEAD'))
    await reopened.session.close()
  }

  // A second Box sends only new objects and still resolves history.
  git(work, 'add', '-A')
  git(work, 'commit', '-qm', 'next')
  const again = await open(root, work)
  assert.equal((await again.session.exec('git', ['log', '--format=%s', '-2'])).stdout.trim(), 'next\nbase')
  await again.session.close()
  rmSync(root, { recursive: true, force: true })
})

test('fleet materialization reuses mirrored blobs and preserves the exact working tree and index', async () => {
  const { root, work } = checkout()
  writeFileSync(join(work, 'large.bin'), randomBytes(512 * 1024))
  writeFileSync(join(work, '.gitignore'), 'node_modules\ndist\n')
  mkdirSync(join(work, 'dist'))
  writeFileSync(join(work, 'dist', 'generated.js'), 'tracked generated output\n')
  writeFileSync(join(work, '.pnp.cjs'), 'tracked package input\n')
  writeFileSync(join(work, 'private.txt'), 'private input\n')
  writeFileSync(join(work, '.gitattributes'), 'dist/** export-ignore\nsubstitute.txt export-subst\ncrlf.txt text eol=crlf\n')
  writeFileSync(join(work, 'crlf.txt'), 'line\n')
  symlinkSync('large.bin', join(work, 'link-to-large'))
  writeFileSync(join(work, 'substitute.txt'), '$Format:%H$\n')
  writeFileSync(join(work, 'becomes-directory'), 'file\n')
  mkdirSync(join(work, 'becomes-file'))
  writeFileSync(join(work, 'becomes-file', 'child'), 'child\n')
  mkdirSync(join(work, 'becomes-symlink'))
  writeFileSync(join(work, 'becomes-symlink', 'secret'), 'tracked content\n')
  git(work, 'add', '-f', '.gitignore', 'large.bin', 'dist/generated.js', '.pnp.cjs', 'private.txt', '.gitattributes', 'crlf.txt', 'link-to-large', 'substitute.txt', 'becomes-directory', 'becomes-file', 'becomes-symlink')
  git(work, 'commit', '-qm', 'inputs')
  utimesSync(join(work, 'large.bin'), 1_600_000_000, 1_600_000_000)
  lutimesSync(join(work, 'link-to-large'), 1_500_000_000, 1_500_000_000)
  writeFileSync(join(work, 'crlf.txt'), 'line\r\n')
  chmodSync(join(work, 'private.txt'), 0o600)
  writeFileSync(join(work, 'a.txt'), 'staged\n')
  git(work, 'add', 'a.txt')
  writeFileSync(join(work, 'a.txt'), 'unstaged\n')
  rmSync(join(work, 'gone.txt'))
  rmSync(join(work, 'becomes-directory'))
  mkdirSync(join(work, 'becomes-directory'))
  writeFileSync(join(work, 'becomes-directory', 'new'), 'new child\n')
  rmSync(join(work, 'becomes-file'), { recursive: true })
  writeFileSync(join(work, 'becomes-file'), 'replacement\n')
  rmSync(join(work, 'becomes-symlink'), { recursive: true })
  mkdirSync(join(root, 'outside'))
  writeFileSync(join(root, 'outside', 'secret'), 'coordinator secret\n')
  symlinkSync('../outside', join(work, 'becomes-symlink'))
  writeFileSync(join(work, 'dist', 'required-untracked.json'), '{"required":true}\n')
  writeFileSync(join(work, 'name\nwith newline'), 'required input\n')
  chmodSync(join(work, 'a.txt'), 0o755)
  const stages = ['base stage\n', 'our stage\n', 'their stage\n'].map(contents => {
    writeFileSync(join(root, 'stage'), contents)
    return git(work, 'hash-object', '-w', join(root, 'stage'))
  })
  execFileSync('git', ['-C', work, 'update-index', '--index-info'], { input: stages.map((oid, stage) => `100644 ${oid} ${stage + 1}\tconflict.txt\n`).join('') })
  writeFileSync(join(work, 'conflict.txt'), '<<<<<<< ours\nour stage\n=======\ntheir stage\n>>>>>>> theirs\n')
  writeFileSync(join(work, '.git', 'MERGE_HEAD'), `${git(work, 'rev-parse', 'HEAD')}\n`)
  const archives: Buffer[] = []
  const transport = { start(script: string) {
    const child = localTransport().start(script)
    if (script.includes('-xzf -')) {
      const chunks: Buffer[] = []
      child.stdin.on('pipe', source => source.on('data', (chunk: Buffer) => chunks.push(chunk)))
      child.once('close', () => archives.push(Buffer.concat(chunks)))
    }
    return child
  } }
  const runtime = createSshBoxRuntime({ host: 'test', transport, root: join(root, 'remote'), path: process.env.PATH! })
  const input = { cwd: work, identity: 'i', plan: { env: {}, files: {}, state: [] }, requirements: [] }
  const plan = await runtime.prepare(input)
  const session = await runtime.open(input, { executionAuthority: plan.executionAuthority })
  try {
    const [archive] = archives
    assert.ok(archive)
    const names = execFileSync('tar', ['-tzf', '-'], { input: archive, encoding: 'utf8' })
    assert.doesNotMatch(names, /\.\/large\.bin\n/)
    assert.ok(archive.length < 32 * 1024, 'unchanged source blobs must not cross the transport twice')
    assert.deepEqual(readFileSync(join(session.cwd, 'large.bin')), readFileSync(join(work, 'large.bin')))
    assert.equal(statSync(join(session.cwd, 'large.bin')).mtimeMs, statSync(join(work, 'large.bin')).mtimeMs)
    assert.equal(lstatSync(join(session.cwd, 'link-to-large')).mtimeMs, lstatSync(join(work, 'link-to-large')).mtimeMs)
    assert.equal(readFileSync(join(session.cwd, 'crlf.txt'), 'utf8'), 'line\r\n')
    assert.equal(statSync(join(session.cwd, 'private.txt')).mode & 0o777, 0o600)
    assert.equal(readFileSync(join(session.cwd, 'dist', 'generated.js'), 'utf8'), 'tracked generated output\n')
    assert.equal(readFileSync(join(session.cwd, '.pnp.cjs'), 'utf8'), 'tracked package input\n')
    assert.equal(readFileSync(join(session.cwd, 'substitute.txt'), 'utf8'), '$Format:%H$\n')
    assert.equal(readFileSync(join(session.cwd, 'a.txt'), 'utf8'), 'unstaged\n')
    assert.equal(git(session.cwd, 'show', ':a.txt'), 'staged')
    assert.equal(git(session.cwd, 'show', ':1:conflict.txt'), 'base stage')
    assert.equal(git(session.cwd, 'show', ':2:conflict.txt'), 'our stage')
    assert.equal(git(session.cwd, 'show', ':3:conflict.txt'), 'their stage')
    assert.deepEqual(readFileSync(join(session.cwd, 'conflict.txt')), readFileSync(join(work, 'conflict.txt')))
    assert.deepEqual(readFileSync(join(session.cwd, '.git', 'MERGE_HEAD')), readFileSync(join(work, '.git', 'MERGE_HEAD')))
    assert.equal(existsSync(join(session.cwd, 'gone.txt')), false)
    assert.equal(readFileSync(join(session.cwd, 'becomes-directory', 'new'), 'utf8'), 'new child\n')
    assert.equal(readFileSync(join(session.cwd, 'becomes-file'), 'utf8'), 'replacement\n')
    assert.equal(readlinkSync(join(session.cwd, 'becomes-symlink')), '../outside')
    assert.doesNotMatch(names, /becomes-symlink\/secret/)
    assert.equal(readFileSync(join(session.cwd, 'dist', 'required-untracked.json'), 'utf8'), '{"required":true}\n')
    assert.equal(readFileSync(join(session.cwd, 'name\nwith newline'), 'utf8'), 'required input\n')
    assert.equal(existsSync(join(session.cwd, 'node_modules')), false)
    assert.equal(git(session.cwd, 'status', '--porcelain'), git(work, 'status', '--porcelain'))
    assert.equal(git(session.cwd, 'ls-files', '--stage'), git(work, 'ls-files', '--stage'))
    assert.equal(git(session.cwd, 'log', '--format=%s'), git(work, 'log', '--format=%s'))
    writeFileSync(join(work, 'a.txt'), 'next sessions\n')
    const concurrent = await Promise.all([open(root, work), open(root, work)])
    try {
      for (const { session: other } of concurrent) {
        assert.equal(readFileSync(join(other.cwd, 'a.txt'), 'utf8'), 'next sessions\n')
        assert.equal(git(other.cwd, 'show', ':2:conflict.txt'), 'our stage')
      }
      assert.equal(readFileSync(join(session.cwd, 'a.txt'), 'utf8'), 'unstaged\n')
    }
    finally { await Promise.all(concurrent.map(({ session: other }) => other.close())) }
  }
  finally {
    await session.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('fleet materialization rejects a failed local archiver even when the receiver extracts its output', async () => {
  const { root, work } = checkout()
  const bin = join(root, 'bin')
  const realTar = execFileSync('which', ['tar'], { encoding: 'utf8' }).trim()
  mkdirSync(bin)
  writeFileSync(join(bin, 'tar'), `#!/bin/sh\ncase "$*" in *-czf*) ${q(realTar)} "$@"; exit 17;; *) exec ${q(realTar)} "$@";; esac\n`, { mode: 0o755 })
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}:${previousPath}`
  let opened: Awaited<ReturnType<typeof open>> | undefined
  try {
    await assert.rejects(async () => { opened = await open(root, work) }, /Workspace archive failed \(17\)/)
    assert.deepEqual(execFileSync('find', [join(root, 'remote', 'boxes'), '-mindepth', '1', '-maxdepth', '1'], { encoding: 'utf8' }).trim(), '')
    process.env.PATH = previousPath
    opened = await open(root, work)
    assert.equal(git(opened.session.cwd, 'rev-parse', 'HEAD'), git(work, 'rev-parse', 'HEAD'))
  }
  finally {
    process.env.PATH = previousPath
    await opened?.session.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('aborting a fleet upload stops its local archiver and removes the partial Box', { timeout: 15_000 }, async () => {
  const { root, work } = checkout()
  const bin = join(root, 'bin')
  const pidFile = join(root, 'archive.pid')
  const realTar = execFileSync('which', ['tar'], { encoding: 'utf8' }).trim()
  mkdirSync(bin)
  writeFileSync(join(bin, 'tar'), `#!/bin/sh\ncase "$*" in *-czf*) echo $$ > ${q(pidFile)}; exec sleep 30;; *) exec ${q(realTar)} "$@";; esac\n`, { mode: 0o755 })
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}:${previousPath}`
  const controller = new AbortController()
  const { runtime } = runtimeFor(root)
  const input = { cwd: work, identity: 'i', plan: { env: {}, files: {}, state: [] }, requirements: [] }
  const plan = await runtime.prepare(input)
  const opening = runtime.open(input, { executionAuthority: plan.executionAuthority, signal: controller.signal })
  const rejected = assert.rejects(opening, { name: 'AbortError' })
  let pid: number | undefined
  try {
    const deadline = Date.now() + 5000
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(existsSync(pidFile), 'the local archiver must start before cancellation')
    const archivePid = Number(readFileSync(pidFile, 'utf8').trim())
    pid = archivePid
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.throws(() => process.kill(archivePid, 0), { code: 'ESRCH' })
    await rejected
    assert.equal(execFileSync('find', [join(root, 'remote', 'boxes'), '-mindepth', '1', '-maxdepth', '1'], { encoding: 'utf8' }).trim(), '')
  }
  finally {
    controller.abort()
    if (pid) { try { process.kill(pid, 'SIGKILL') } catch {} }
    await rejected
    process.env.PATH = previousPath
    rmSync(root, { recursive: true, force: true })
  }
})

test('a fleet refresh reinstalls only when manifests, lockfile or patches changed since the last good install', async () => {
  // 2026-10-19: every fleet refresh uploaded manifests and reinstalled, p50 30 s.
  const { root, work } = checkout()
  const bin = join(root, 'bin')
  const installs = join(root, 'installs.log')
  mkdirSync(bin)
  writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(installs)}\ntest ! -e ${JSON.stringify(join(root, 'fail'))}\n`, { mode: 0o755 })
  writeFileSync(join(work, 'package.json'), '{"name":"x"}\n')
  writeFileSync(join(work, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  mkdirSync(join(work, 'patches'))
  writeFileSync(join(work, 'patches', 'a.patch'), 'one\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-qm', 'deps')
  const runtime = createSshBoxRuntime({ host: 'test', transport: localTransport(), root: join(root, 'remote'), path: `${bin}:${process.env.PATH}` })
  const input = { cwd: work, identity: 'i', plan: { env: {}, files: {}, state: [] }, requirements: [] }
  const plan = await runtime.prepare(input)
  const session = await runtime.open(input, { executionAuthority: plan.executionAuthority }) as FleetBoxSession
  const count = () => existsSync(installs) ? readFileSync(installs, 'utf8').trim().split('\n').length : 0
  try {
    assert.equal(count(), 1)
    await session.refreshDependencies(work)
    assert.equal(count(), 1)
    writeFileSync(join(work, 'patches', 'a.patch'), 'two\n')
    await session.refreshDependencies(work)
    assert.equal(count(), 2)
    assert.equal(readFileSync(join(session.cwd, 'patches', 'a.patch'), 'utf8'), 'two\n')
    await session.refreshDependencies(work)
    assert.equal(count(), 2)
    // A failed install is not reused: the same inputs install again on the next refresh.
    writeFileSync(join(root, 'fail'), '')
    writeFileSync(join(work, 'package.json'), '{"name":"y"}\n')
    await assert.rejects(session.refreshDependencies(work), /\[fleet\] Dependency install failed on test/)
    rmSync(join(root, 'fail'))
    const failed = count()
    await session.refreshDependencies(work)
    assert.equal(count(), failed + 1)
    await session.refreshDependencies(work)
    assert.equal(count(), failed + 1)
  }
  finally {
    await session.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('the patched framework caps dependency refreshes per pass', () => {
  let modules = join(process.cwd(), 'node_modules', 'vite-hub')
  modules = execFileSync('node', ['-e', 'console.log(require("fs").realpathSync(process.argv[1]))', modules], { encoding: 'utf8' }).trim()
  const dist = join(modules, '..', '@vite-hub', 'agent', 'dist')
  const source = execFileSync('ls', [dist], { encoding: 'utf8' }).split('\n').filter(name => name.endsWith('.js')).map(name => readFileSync(join(dist, name), 'utf8')).join('\n')
  // 2026-10-19: one pass called refreshDependencies 16 times.
  assert.match(source, /if \(refreshTask\) return refreshTask;/)
  assert.match(source, /const release = workspace\?\.admitRefresh\?\.\(\);\n\t+try \{\n\t+await workspace\?\.beforeRepair\(context\.context\);/)
  assert.match(source, /const dependencyRefreshCap = 2;/)
  assert.match(source, /if \(dependencyRefreshes >= dependencyRefreshCap\) throw new Error\(`refreshDependencies already ran \$\{dependencyRefreshCap\} times in this pass, the limit\. Do not call it again\./)
  // With the cap spent, a commit of changed inputs is left to CI instead of demanding another refresh.
  assert.match(source, /&& \(dependencyRefreshes < dependencyRefreshCap \|\| await hasCurrentGitHubDependencies\(providerDirectory\)\);/)
})

test('the patched framework accepts tunnelled Box runtimes and places passes before installing', () => {
  let modules = join(process.cwd(), 'node_modules', 'vite-hub')
  modules = execFileSync('node', ['-e', 'console.log(require("fs").realpathSync(process.argv[1]))', modules], { encoding: 'utf8' }).trim()
  const dist = join(modules, '..', '@vite-hub', 'agent', 'dist')
  const files = execFileSync('ls', [dist], { encoding: 'utf8' }).split('\n').filter(name => name.endsWith('.js'))
  const source = files.map(name => readFileSync(join(dist, name), 'utf8')).join('\n')
  assert.match(source, /!\("kind" in runtime\) && runtime\.network === "direct"/)
  assert.match(source, /fleetPlacement \?\?= await fleet\.place\(\{ repository, number \}\)/)
  assert.match(source, /presetOptions\.install !== false && !fleetPlacement\?\.box\) try \{/)
  assert.match(source, /fleetPlacement\?\.release\(\);/)
  assert.match(source, /remoteActive\?\.\(\) \?\? 0/)
  assert.match(source, /box\.session\.importWorkspace\(checkout, abortSignal\)/)
})
