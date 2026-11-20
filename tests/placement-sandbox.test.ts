import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import type { SandboxRuntimeInput } from 'vite-hub/sandbox'
import { probeScript } from '../server/agents/babysitter/placement/index.ts'
import { parse } from 'smol-toml'
import { createSshSandboxRuntime, loopbackPorts, readHostModelProvider, remapLoopback, remoteCodexConfig } from '../server/agents/babysitter/placement/sandbox.ts'
import { localTransport, runScript } from '../server/agents/babysitter/placement/ssh.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()

/** A checkout in the state the host leaves a conflicting PR: a merge in progress whose resolution is staged but not committed. */
function preparedMerge(root: string) {
  const checkout = join(root, 'checkout')
  mkdirSync(checkout)
  git(checkout, 'init', '-q', '-b', 'main')
  git(checkout, 'remote', 'add', 'origin', `https://example.invalid/${root.split('/').pop()}.git`)
  writeFileSync(join(checkout, 'file.txt'), 'base\n')
  writeFileSync(join(checkout, 'keep.txt'), 'base\n')
  writeFileSync(join(checkout, 'gone.txt'), 'base\n')
  writeFileSync(join(checkout, '.gitignore'), 'ignored.txt\n')
  git(checkout, 'add', '.')
  git(checkout, 'commit', '-qm', 'base')
  git(checkout, 'checkout', '-q', '-b', 'side')
  writeFileSync(join(checkout, 'file.txt'), 'side\n')
  git(checkout, 'commit', '-qam', 'side')
  const side = git(checkout, 'rev-parse', 'HEAD')
  git(checkout, 'checkout', '-q', 'main')
  writeFileSync(join(checkout, 'file.txt'), 'main\n')
  git(checkout, 'commit', '-qam', 'main')
  // Drop the branch so only MERGE_HEAD reaches the merged commit, as with a base fetched by SHA.
  git(checkout, 'branch', '-qD', 'side')
  try { git(checkout, 'merge', '--no-commit', '-q', side) } catch {}
  writeFileSync(join(checkout, 'file.txt'), 'resolved\n')
  git(checkout, 'add', 'file.txt')
  // Work the host left unstaged: an edit, a deletion, a new file and an ignored file.
  writeFileSync(join(checkout, 'keep.txt'), 'edited\n')
  rmSync(join(checkout, 'gone.txt'))
  writeFileSync(join(checkout, 'new.txt'), 'new\n')
  writeFileSync(join(checkout, 'ignored.txt'), 'ignored\n')
  return { checkout, side, head: git(checkout, 'rev-parse', 'HEAD') }
}

function input(cwd: string): SandboxRuntimeInput {
  return {
    cwd,
    identity: 'test',
    plan: { env: { PLAN_VALUE: async () => 'from-plan' }, files: { 'notes.txt': { resolve: async () => new TextEncoder().encode('home file') } }, state: [] },
    requirements: [{ args: [], command: 'git', name: 'git' }],
  }
}

test('a placed Box reproduces the prepared merge, runs commands in its own Home and leaves nothing behind', async () => {
  const root = mkdtempSync(join(tmpdir(), 'placement-sandbox-'))
  try {
    const { checkout, side, head } = preparedMerge(root)
    const remote = join(root, 'remote')
    const opened: string[] = []
    const closed: string[] = []
    const runtime = createSshSandboxRuntime({
      host: 'local',
      transport: localTransport(),
      root: remote,
      path: process.env.PATH!,
      codexConfig: work => `model_provider = "cliproxy"\nbase_url = "http://127.0.0.1:8317/v1"\n# ${work}\n`,
      onOpen: id => opened.push(id),
      onClose: id => closed.push(id),
    })
    const plan = await runtime.prepare(input(checkout))
    assert.equal(plan.workspace.state, 'disposable')
    const session = await runtime.open(input(checkout), { executionAuthority: plan.executionAuthority })
    assert.equal(opened.length, 1)
    assert.equal(session.cwd, join(remote, 'boxes', opened[0]!, 'work'))

    // The merge state and the staged resolution travel; the staged blob is reachable from no commit.
    const status = await session.exec('git', ['status', '--porcelain'])
    assert.equal(status.stdout.trimEnd(), 'M  file.txt\n D gone.txt\n M keep.txt\n?? new.txt')
    assert.equal((await session.exec('cat', ['file.txt', 'keep.txt'])).stdout, 'resolved\nedited\n')
    assert.equal((await session.exec('git', ['rev-parse', 'MERGE_HEAD'])).stdout.trim(), side)
    const committed = await session.exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'merge'])
    assert.equal(committed.ok, true, committed.stderr)
    assert.equal((await session.exec('git', ['rev-parse', 'HEAD^1'])).stdout.trim(), head)
    assert.equal((await session.exec('git', ['rev-parse', 'HEAD^2'])).stdout.trim(), side)
    // The host imports the commit as a bundle, so every object must be readable in the Box.
    const bundle = await session.exec('sh', ['-c', 'git bundle create -q "$TMPDIR/repair.bundle" HEAD "^$1"', 'sh', head])
    assert.equal(bundle.ok, true, bundle.stderr)

    // Commands run with the Box Home, the plan environment and the runtime's PATH, never the host's HOME.
    const environment = await session.exec('sh', ['-c', 'printf "%s|%s|%s" "$HOME" "$PLAN_VALUE" "$HOST_ONLY"'], { env: { HOME: '/host/home', HOST_ONLY: 'x' } })
    assert.equal(environment.stdout, `${join(remote, 'boxes', opened[0]!, 'home')}|from-plan|x`)
    assert.equal(new TextDecoder().decode((await session.files.read(join(remote, 'boxes', opened[0]!, 'home', 'notes.txt')))!), 'home file')
    assert.match(readFileSync(join(remote, 'boxes', opened[0]!, 'home', '.codex', 'config.toml'), 'utf8'), /cliproxy/)

    // A spawned provider gets input and its environment from a private file.
    const child = await session.spawn!('sh', ['-c', 'read line; printf "%s:%s" "$line" "$SECRET"'], { env: { SECRET: 's3' }, stdin: true })
    const writer = child.stdin!.getWriter()
    await writer.write(new TextEncoder().encode('hello\n'))
    await writer.close()
    assert.equal(await new Response(child.stdout).text(), 'hello:s3')
    assert.equal((await child.wait()).code, 0)

    // A tool command that left its session keeps running until the Box closes.
    await session.exec('sh', ['-c', 'setsid sleep 300 >/dev/null 2>&1 < /dev/null &'])
    const sleeper = () => execFileSync('sh', ['-c', `for e in /proc/[0-9]*/environ; do tr '\\0' '\\n' 2>/dev/null < "$e" | grep -qxF 'HOME=${join(remote, 'boxes', opened[0]!, 'home')}' && echo "\${e#/proc/}"; done; true`], { encoding: 'utf8' }).trim()
    assert.notEqual(sleeper(), '')
    await session.close()
    assert.deepEqual(closed, opened)
    assert.equal(sleeper(), '')
    assert.equal(existsSync(join(remote, 'boxes', opened[0]!)), false)
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a placed Box gets the index blobs of a prepared merge that only a pack on the host holds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'placement-packed-merge-'))
  try {
    const checkout = join(root, 'checkout')
    mkdirSync(checkout)
    git(checkout, 'init', '-q', '-b', 'main')
    git(checkout, 'remote', 'add', 'origin', 'https://example.invalid/base.git')
    const lines = (first: string, last: string) => `${first}\n${'same\n'.repeat(20)}${last}\n`
    writeFileSync(join(checkout, 'merged.txt'), lines('a', 'z'))
    writeFileSync(join(checkout, 'conflict.txt'), 'base\n')
    git(checkout, 'add', '.')
    git(checkout, 'commit', '-qm', 'base')
    git(checkout, 'checkout', '-q', '-b', 'pr')
    writeFileSync(join(checkout, 'merged.txt'), lines('pr', 'z'))
    writeFileSync(join(checkout, 'conflict.txt'), 'pr\n')
    git(checkout, 'commit', '-qam', 'pr')
    git(checkout, 'checkout', '-q', 'main')
    writeFileSync(join(checkout, 'merged.txt'), lines('a', 'main'))
    writeFileSync(join(checkout, 'conflict.txt'), 'main\n')
    git(checkout, 'commit', '-qam', 'main')
    const base = git(checkout, 'rev-parse', 'HEAD')
    // A fork PR: the head is a local branch, the base is reached only through MERGE_HEAD.
    git(checkout, 'checkout', '-q', 'pr')
    git(checkout, 'update-ref', '-d', 'refs/heads/main')
    try { git(checkout, 'merge', '--no-commit', '-q', base) } catch {}
    // Git writes no loose copy of an object that a pack already has, such as the same merge from an
    // earlier pass that gc moved into a cruft pack. The merged blob then lives only in a pack.
    git(checkout, 'repack', '-adq')
    const merged = git(checkout, 'rev-parse', ':0:merged.txt')
    assert.equal(existsSync(join(checkout, '.git', 'objects', merged.slice(0, 2), merged.slice(2))), false)

    const runtime = createSshSandboxRuntime({ host: 'local', transport: localTransport(), root: join(root, 'remote'), path: process.env.PATH! })
    const session = await runtime.open(input(checkout), { executionAuthority: (await runtime.prepare(input(checkout))).executionAuthority })
    try {
      assert.equal((await session.exec('cat', ['merged.txt'])).stdout, lines('pr', 'main'))
      assert.equal((await session.exec('git', ['rev-parse', 'MERGE_HEAD'])).stdout.trim(), base)
      const stages = await session.exec('git', ['cat-file', '-p', ':3:conflict.txt'])
      assert.equal(stages.stdout, 'main\n', stages.stderr)
      assert.equal((await session.exec('git', ['fsck', '--no-dangling', '--connectivity-only', '--cache'])).ok, true)
    }
    finally {
      await session.close()
    }
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a host probe removes Boxes that no live pass owns and spares young and live ones', async () => {
  const root = mkdtempSync(join(tmpdir(), 'placement-probe-'))
  const home = join(root, 'home')
  const boxes = join(home, '.vitehub-fleet', 'boxes')
  try {
    for (const box of ['orphan', 'live', 'young']) mkdirSync(join(boxes, box, 'home'), { recursive: true })
    // A test in the pass left a read-only directory in the Box.
    mkdirSync(join(boxes, 'orphan', 'tmp', 'readonly'), { recursive: true })
    writeFileSync(join(boxes, 'orphan', 'tmp', 'readonly', 'file'), 'x')
    chmodSync(join(boxes, 'orphan', 'tmp', 'readonly'), 0o555)
    const old = new Date(Date.now() - 3_600_000)
    utimesSync(join(boxes, 'orphan'), old, old)
    utimesSync(join(boxes, 'live'), old, old)
    const transport = localTransport()
    // An orphaned tool command, as from a pass cut off by a restart.
    await runScript(transport, `HOME=${join(boxes, 'orphan', 'home')} setsid sleep 300 >/dev/null 2>&1 < /dev/null &`)
    const result = await runScript({ start: script => transport.start(`HOME=${home}; export HOME; ${script}`) }, probeScript('.vitehub-fleet', ['live']), { timeout: 30_000 })
    const [reportedHome] = result.stdout.toString('utf8').split('\n')
    assert.equal(reportedHome, home)
    await sleep(200)
    assert.equal(existsSync(join(boxes, 'orphan')), false)
    assert.equal(existsSync(join(boxes, 'live')), true)
    assert.equal(existsSync(join(boxes, 'young')), true)
    const survivors = execFileSync('sh', ['-c', `for e in /proc/[0-9]*/environ; do tr '\\0' '\\n' 2>/dev/null < "$e" | grep -qxF 'HOME=${join(boxes, 'orphan', 'home')}' && echo x; done; true`], { encoding: 'utf8' }).trim()
    assert.equal(survivors, '')
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loopback URLs map to the ports their tunnel was given', () => {
  assert.deepEqual(loopbackPorts(['mcp_servers.t3-code.url="http://127.0.0.1:41234/mcp"', 'x'], [8317]), [8317, 41234])
  assert.equal(remapLoopback('http://127.0.0.1:8317/v1 http://localhost:41234/mcp http://127.0.0.1:9/x', new Map([[8317, 33001], [41234, 33002]])), 'http://127.0.0.1:33001/v1 http://127.0.0.1:33002/mcp http://127.0.0.1:9/x')
})

test('the remote Codex config keeps only the selected provider, without any credential', () => {
  const host = [
    'model = "m"',
    'model_provider = "cliproxy"',
    'notify = ["/usr/bin/secret-notifier"]',
    '[model_providers.cliproxy]',
    'name = "CLIProxy pool"',
    'base_url = "http://127.0.0.1:8317/v1"',
    'wire_api = "responses"',
    'experimental_bearer_token = "bearer-secret"',
    'http_headers = { Authorization = "Bearer header-secret" }',
    'query_params = { key = "query-secret" }',
    '[model_providers.cliproxy.env_http_headers]',
    '"CF-Access-Client-Secret" = "cf-secret"',
    '[model_providers.other]',
    'base_url = "https://other.example"',
    'experimental_bearer_token = "other-secret"',
    '[mcp_servers.x]',
    'command = "y"',
  ].join('\n')
  const provider = readHostModelProvider(host, {})!
  assert.equal(provider.apiKey, 'bearer-secret')
  assert.equal(provider.baseUrl, 'http://127.0.0.1:8317/v1')
  const config = remoteCodexConfig(provider, { baseUrl: 'http://127.0.0.1:4000/v1', envKey: 'LEASE_TOKEN' })('/w')
  assert.doesNotMatch(config, /secret|other|mcp_servers|notify|8317/)
  assert.deepEqual(JSON.parse(JSON.stringify(parse(config))), {
    model: 'm',
    model_provider: 'cliproxy',
    model_providers: { cliproxy: { name: 'CLIProxy pool', wire_api: 'responses', base_url: 'http://127.0.0.1:4000/v1', env_key: 'LEASE_TOKEN' } },
    shell_environment_policy: { set: { LEASE_TOKEN: '' } },
    projects: { '/w': { trust_level: 'trusted' } },
  })
  // Comments and quoted keys are valid TOML that Codex reads.
  const commented = readHostModelProvider('model_provider = "p" # selected provider\n[model_providers."p"] # pool\nbase_url = "http://x" # proxy\nenv_key = "P_KEY"\n', { P_KEY: 'k' })
  assert.equal(commented?.baseUrl, 'http://x')
  assert.equal(commented?.apiKey, 'k')
  // A provider keyed by a variable reads the key from the environment.
  assert.equal(readHostModelProvider('model_provider = "p"\n[model_providers.p]\nbase_url = "http://x"\nenv_key = "P_KEY"\n', { P_KEY: 'from-env' })?.apiKey, 'from-env')
  assert.equal(readHostModelProvider('model = "m"\n', {}), undefined)
})
