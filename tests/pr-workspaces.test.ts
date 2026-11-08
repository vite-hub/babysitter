// One warm workspace per PR: the host checkout and the provider workspace stay in
// <dataDir>/pr-workspaces between passes. These tests run the patched pool, checkout and
// workspace preparation against local bare repositories that stand in for GitHub.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dist } from './agent-dist.ts'

const load = async (file: string) => await import(pathToFileURL(join(dist, file)).href)
const pool = await load('pr-workspaces.js')
const github = await load('github-C5fJH50u.js')
const host = await load('host-DBW8wmoH.js')

type Entry = { checkout: string, work: string, existed: boolean, previous?: { head: string, ok: boolean }, record: (result: object) => Promise<void>, release: () => Promise<void> }

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** A base repository and a fork with one PR branch, reached through https://github.com URLs. */
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'babysitter-pr-workspaces-'))
  const keys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_ALLOW_PROTOCOL'] as const
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  t.after(async () => {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key] }
    await rm(root, { recursive: true, force: true })
  })
  const base = join(root, 'base.git'), fork = join(root, 'fork.git'), source = join(root, 'source')
  await mkdir(source)
  git(root, 'init', '--bare', base); git(root, 'init', '--bare', fork)
  git(source, 'init', '-b', 'main')
  await writeFile(join(source, '.gitignore'), 'node_modules\ndist\n')
  await writeFile(join(source, 'file'), 'base')
  git(source, 'add', '.'); git(source, 'commit', '-m', 'base')
  git(source, 'push', base, 'HEAD:refs/heads/main')
  git(root, '--git-dir', base, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  git(source, 'checkout', '-b', 'fix'); await writeFile(join(source, 'file'), 'pr'); git(source, 'commit', '-am', 'pr')
  git(source, 'push', fork, 'HEAD:refs/heads/fix')
  const config = join(root, 'gitconfig')
  await writeFile(config, '')
  git(root, 'config', '--file', config, `url.file://${base}.insteadOf`, 'https://github.com/base/repo.git')
  git(root, 'config', '--file', config, `url.file://${fork}.insteadOf`, 'https://github.com/source/repo.git')
  process.env.GIT_CONFIG_GLOBAL = config; process.env.GIT_CONFIG_NOSYSTEM = '1'; process.env.GIT_ALLOW_PROTOCOL = 'file'
  const gh = github.f({ credentials: () => ({ token: 'test-token', rateLimitKey: 'offline-test' }), identity: { login: 'Test', email: 'test@example.invalid' } })
  const workspaces = pool.createPullRequestWorkspaces({ root: join(root, 'data', 'pr-workspaces') })
  /** Pushes a commit to the fork from outside the Babysitter, like a person or a bot merge. */
  const foreignPush = async (content: string) => {
    await writeFile(join(source, 'file'), content); git(source, 'commit', '-am', content)
    git(source, 'push', '--force', fork, 'HEAD:refs/heads/fix')
    return git(source, 'rev-parse', 'HEAD')
  }
  /** One pass as the Babysitter runs it: lock, decide, check out, prepare, then record. */
  const pass = async (head: string, work: (entry: Entry, prepared: any, result: { reused: boolean, reason: string }) => Promise<{ head?: string, ok?: boolean } | void>) => {
    const entry: Entry = await workspaces.acquire('base/repo', 7)
    try {
      const plan = pool.workspaceDecision(entry.previous, head, entry.existed)
      let left: { head?: string, ok?: boolean } | void = undefined
      let result = { reused: false, reason: '' }
      await gh.withPullRequestCheckout({ repository: 'base/repo', number: 7, headSha: head, headRepository: 'source/repo', headRef: 'fix' }, async (prepared: any) => {
        result = await prepared.prepareWorkspace(entry.work, { restoreInstructions: true, reuse: plan.reuse, reason: plan.reason })
        assert.equal(git(entry.work, 'rev-parse', 'HEAD'), head)
        left = await work(entry, prepared, result)
      }, { persistent: { checkout: entry.checkout, work: entry.work } })
      await entry.record({ head: left?.head ?? head, ok: left?.ok ?? true })
      return { ...result, entry }
    } finally { await entry.release() }
  }
  const install = async (work: string) => {
    await mkdir(join(work, 'node_modules', 'dep'), { recursive: true })
    await writeFile(join(work, 'node_modules', 'dep', 'index.js'), 'kept')
    await writeFile(join(work, '.git', 'vitehub-install.json'), JSON.stringify({ status: 'installed' }))
    await mkdir(join(work, '.git', 'vitehub-install-home', 'store'), { recursive: true })
    await writeFile(join(work, '.git', 'vitehub-install-home', 'store', 'package'), 'cached')
  }
  return { root, fork, source, workspaces, pass, install, foreignPush, head: git(source, 'rev-parse', 'HEAD') }
}

test('a pass on the head the previous pass pushed keeps the workspace and its dependencies', async t => {
  const f = await fixture(t)
  const first = await f.pass(f.head, async (entry, prepared, result) => {
    assert.deepEqual(result, { reused: false, reason: 'cold' })
    await f.install(entry.work)
    await writeFile(join(entry.work, 'file'), 'repaired')
    git(entry.work, 'commit', '-am', 'repair')
    return { head: await prepared.push(entry.work) }
  })
  const pushed = execFileSync('git', ['--git-dir', f.fork, 'rev-parse', 'refs/heads/fix'], { encoding: 'utf8' }).trim()
  assert.notEqual(pushed, f.head)
  await writeFile(join(first.entry.checkout, '.git', 'clone-marker'), '')
  const second = await f.pass(pushed, async entry => {
    assert.equal(await readFile(join(entry.work, 'node_modules', 'dep', 'index.js'), 'utf8'), 'kept')
    assert.equal(JSON.parse(await readFile(join(entry.work, '.git', 'vitehub-install.json'), 'utf8')).status, 'installed')
    assert.equal(await readFile(join(entry.work, 'file'), 'utf8'), 'repaired')
  })
  assert.deepEqual([second.reused, second.reason], [true, 'warm'])
  // The host checkout was fetched, not cloned again.
  assert.ok(existsSync(join(second.entry.checkout, '.git', 'clone-marker')))
  // An unchanged head is warm as well.
  const third = await f.pass(pushed, async () => {})
  assert.deepEqual([third.reused, third.reason], [true, 'warm'])
})

test('a head pushed by someone else resets the workspace', async t => {
  const f = await fixture(t)
  await f.pass(f.head, async entry => { await f.install(entry.work) })
  const foreign = await f.foreignPush('bot merge')
  const next = await f.pass(foreign, async entry => {
    assert.equal(existsSync(join(entry.work, 'node_modules')), false)
    assert.equal(existsSync(join(entry.work, '.git', 'vitehub-install.json')), false)
    assert.equal(await readFile(join(entry.work, 'file'), 'utf8'), 'bot merge')
    // pnpm's store in the install HOME stays, so the next install links instead of downloading.
    assert.equal(await readFile(join(entry.work, '.git', 'vitehub-install-home', 'store', 'package'), 'utf8'), 'cached')
  })
  assert.deepEqual([next.reused, next.reason], [false, 'foreign-head'])
})

test('a failed pass resets the workspace for the next pass on the same head', async t => {
  const f = await fixture(t)
  await f.pass(f.head, async entry => { await f.install(entry.work); return { ok: false } })
  const next = await f.pass(f.head, async entry => { assert.equal(existsSync(join(entry.work, 'node_modules')), false) })
  assert.deepEqual([next.reused, next.reason], [false, 'failed-pass'])
})

test('a process exit during a warm pass invalidates the previous successful record', async t => {
  const f = await fixture(t)
  await f.pass(f.head, async entry => { await f.install(entry.work) })
  // Exit without recording or releasing, as with a host crash or an OOM kill. The
  // tracked tree stays clean, but dependencies may have been left half-written.
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { createPullRequestWorkspaces, workspaceDecision } from ${JSON.stringify(pathToFileURL(join(dist, 'pr-workspaces.js')).href)};
    import { writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const workspaces = createPullRequestWorkspaces({ root: ${JSON.stringify(join(f.root, 'data', 'pr-workspaces'))} });
    const entry = await workspaces.acquire('base/repo', 7);
    if (!workspaceDecision(entry.previous, ${JSON.stringify(f.head)}, entry.existed).reuse) throw new Error('expected warm pass');
    await writeFile(join(entry.work, 'node_modules', 'dep', 'index.js'), 'incomplete');
    process.exit(0);
  `], { stdio: 'pipe' })
  const next = await f.pass(f.head, async entry => {
    assert.equal(existsSync(join(entry.work, 'node_modules')), false)
    assert.equal(existsSync(join(entry.work, '.git', 'vitehub-install.json')), false)
  })
  assert.deepEqual([next.reused, next.reason], [false, 'failed-pass'])
})

test('a dirty tree resets the workspace, and nothing a pass left in .git survives', async t => {
  const f = await fixture(t)
  await f.pass(f.head, async entry => {
    await f.install(entry.work)
    await writeFile(join(entry.work, 'file'), 'uncommitted edit')
    await writeFile(join(entry.work, 'stray.txt'), 'untracked')
    await mkdir(join(entry.work, '.git', 'hooks'), { recursive: true })
    await writeFile(join(entry.work, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    git(entry.work, 'config', 'credential.helper', 'store')
    git(entry.work, 'config', 'core.fsmonitor', 'false')
  })
  const next = await f.pass(f.head, async entry => {
    assert.equal(await readFile(join(entry.work, 'file'), 'utf8'), 'pr')
    assert.equal(existsSync(join(entry.work, 'stray.txt')), false)
    assert.equal(existsSync(join(entry.work, 'node_modules')), false)
    assert.equal(existsSync(join(entry.work, '.git', 'hooks')), false)
    const config = await readFile(join(entry.work, '.git', 'config'), 'utf8')
    assert.doesNotMatch(config, /credential|fsmonitor|token/i)
  })
  assert.deepEqual([next.reused, next.reason], [false, 'dirty'])
  // Ignored build output alone keeps the workspace warm.
  await f.pass(f.head, async entry => {
    await f.install(entry.work)
    await mkdir(join(entry.work, 'dist'), { recursive: true }); await writeFile(join(entry.work, 'dist', 'out.js'), 'build')
  })
  const warm = await f.pass(f.head, async entry => { assert.ok(existsSync(join(entry.work, 'dist', 'out.js'))) })
  assert.deepEqual([warm.reused, warm.reason], [true, 'warm'])
})

test('a workspace without a record or Git metadata starts over', async t => {
  const f = await fixture(t)
  const first = await f.pass(f.head, async entry => { await f.install(entry.work) })
  await rm(join(first.entry.checkout, '..', 'state.json'))
  const missing = await f.pass(f.head, async entry => { assert.equal(existsSync(join(entry.work, 'node_modules')), false) })
  assert.deepEqual([missing.reused, missing.reason], [false, 'missing-metadata'])
  await rm(join(missing.entry.work, '.git'), { recursive: true })
  const noGit = await f.pass(f.head, async () => {})
  assert.deepEqual([noGit.reused, noGit.reason], [false, 'missing-metadata'])
})

test('a broken persistent clone is cloned again', async t => {
  const f = await fixture(t)
  const first = await f.pass(f.head, async () => {})
  await writeFile(join(first.entry.checkout, '.git', 'index.lock'), '')
  const next = await f.pass(f.head, async () => {})
  assert.equal(next.reason, 'warm')
  assert.equal(existsSync(join(next.entry.checkout, '.git', 'index.lock')), false)
})

test('the entry lock serializes passes on one PR', async t => {
  const root = await mkdtemp(join(tmpdir(), 'babysitter-pr-lock-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  // A relative data directory still gives absolute entry paths, which must equal the provider cwd.
  const workspaces = pool.createPullRequestWorkspaces({ root: relative(process.cwd(), root) })
  const first = await workspaces.acquire('o/r', 1)
  assert.equal(first.work, join(root, 'o+r+1', 'work'))
  let second: Entry | undefined
  const waiting = workspaces.acquire('o/r', 1).then((entry: Entry) => { second = entry })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(second, undefined)
  await first.release()
  await waiting
  assert.ok(second)
  await second!.release()
  // A lock file whose process is gone is stale.
  await writeFile(join(root, 'o+r+1', 'lock'), '999999999')
  const third = await workspaces.acquire('o/r', 1, AbortSignal.timeout(2_000))
  await third.release()
})

test('a terminal PR loses its workspace, and the inbox reports the transition', async t => {
  const root = await mkdtemp(join(tmpdir(), 'babysitter-pr-terminal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspaces = pool.createPullRequestWorkspaces({ root })
  const entry = await workspaces.acquire('vite-hub/vitehub', 42)
  await writeFile(join(entry.work, 'file'), 'x')
  await entry.record({ head: 'a'.repeat(40), ok: true })
  await entry.release()
  const { p: PullRequestInbox } = await load('github-inbox-emRhJnWe.js')
  const inbox = new PullRequestInbox({ path: ':memory:', repositories: ['vite-hub/vitehub'] })
  const removed: string[] = []
  inbox.onTerminal = (repository: string, number: number) => {
    removed.push(`${repository}#${number}`)
    void workspaces.remove(repository, number)
  }
  const pr = (state: string) => ({ number: 42, state, draft: false, title: 't', body: '', user: { login: 'onmax' }, head: { sha: 'a'.repeat(40), ref: 'feature', repo: { full_name: 'vite-hub/vitehub' } }, base: { sha: '1'.repeat(40), ref: 'main', repo: { full_name: 'vite-hub/vitehub' } } })
  try {
    await inbox.ingest('opened', 'pull_request', { repository: { full_name: 'vite-hub/vitehub' }, action: 'opened', pull_request: pr('open') })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(removed, [])
    await inbox.ingest('closed', 'pull_request', { repository: { full_name: 'vite-hub/vitehub' }, action: 'closed', pull_request: pr('closed') })
    for (let index = 0; index < 50 && existsSync(join(root, 'vite-hub+vitehub+42')); index++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(removed.slice(0, 1), ['vite-hub/vitehub#42'])
    assert.equal(existsSync(join(root, 'vite-hub+vitehub+42')), false)
    assert.equal(await workspaces.remove('vite-hub/vitehub', 42), false)
  } finally { await inbox.close() }
})

test('the sweep removes terminal, unknown and idle entries, then least recently used ones over budget', async t => {
  const root = await mkdtemp(join(tmpdir(), 'babysitter-pr-sweep-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const day = 864e5
  let now = 100 * day
  const GB = 1024 ** 3
  const workspaces = pool.createPullRequestWorkspaces({ root, now: () => now, budgetBytes: 25 * GB, idleMs: 7 * day, minFreeRatio: 0 })
  const make = async (number: number, ageDays: number, bytes: number) => {
    now = 100 * day - ageDays * day
    const entry = await workspaces.acquire('o/r', number)
    await entry.record({ head: 'a'.repeat(40), ok: true })
    await entry.release()
    const state = join(root, `o+r+${number}`, 'state.json')
    await writeFile(state, JSON.stringify({ ...JSON.parse(await readFile(state, 'utf8')), bytes, bytesAt: now }))
  }
  await make(1, 0, 10 * GB) // open, newest
  await make(2, 1, 10 * GB) // open
  await make(3, 2, 10 * GB) // open, least recently used: over the 25 GB budget
  await make(4, 0, 1) // terminal
  await make(5, 0, 1) // unknown to the inbox
  await make(6, 8, 1) // idle past seven days
  await make(7, 3, 10 * GB) // open and oldest, but a pass holds it
  await mkdir(join(root, '.trash-o+r+9-x'), { recursive: true })
  await mkdir(join(root, 'o+r+8', 'work'), { recursive: true }) // no record
  now = 100 * day
  const held = await workspaces.acquire('o/r', 7)
  const status = async (_repository: string, number: number) => number === 4 ? 'terminal' : number === 5 ? 'unknown' : 'open'
  const result = await workspaces.sweep({ status })
  await held.release()
  const reasons = Object.fromEntries(result.removed.map((entry: { name: string, reason: string }) => [entry.name, entry.reason]))
  assert.deepEqual(reasons, { 'o+r+3': 'budget', 'o+r+4': 'terminal', 'o+r+5': 'unknown', 'o+r+6': 'idle', 'o+r+8': 'unknown' })
  assert.deepEqual((await readdir(root)).sort(), ['o+r+1', 'o+r+2', 'o+r+7'])
  // Low free disk evicts least recently used entries even under budget.
  const lowDisk = pool.createPullRequestWorkspaces({ root, now: () => now, budgetBytes: 1000 * GB, idleMs: 7 * day, minFreeRatio: 1.01 })
  const evicted = await lowDisk.sweep({ status })
  assert.deepEqual(evicted.removed.map((entry: { reason: string }) => entry.reason), ['low-disk', 'low-disk', 'low-disk'])
})

test('the sweep measures an entry whose size is older than its last pass', async t => {
  const root = await mkdtemp(join(tmpdir(), 'babysitter-pr-du-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspaces = pool.createPullRequestWorkspaces({ root, budgetBytes: 1024 ** 4, minFreeRatio: 0 })
  const entry = await workspaces.acquire('o/r', 1)
  await writeFile(join(entry.work, 'blob'), Buffer.alloc(1024 * 1024))
  await entry.record({ head: 'a'.repeat(40), ok: true })
  await entry.release()
  const result = await workspaces.sweep({ status: async () => 'open' })
  assert.equal(result.removed.length, 0)
  const state = JSON.parse(await readFile(join(root, 'o+r+1', 'state.json'), 'utf8'))
  assert.ok(state.bytes >= 1024 * 1024)
})

test('startup sweeps of TMPDIR and the legacy checkout pool leave the PR workspaces alone', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'babysitter-pr-startup-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const dataDir = join(cwd, '.vitehub', 'agents', 'babysitter')
  const temporary = join(cwd, 'tmp')
  await mkdir(join(dataDir, 'checkouts', 'old'), { recursive: true })
  await mkdir(join(dataDir, 'pr-workspaces', 'o+r+1', 'work', 'node_modules'), { recursive: true })
  await mkdir(join(temporary, 'vitehub-provider-abcdef'), { recursive: true })
  const old = new Date(Date.now() - 864e5)
  await utimes(join(temporary, 'vitehub-provider-abcdef'), old, old)
  assert.equal(await host.cleanupLegacyBabysitterCheckouts(dataDir), 1)
  assert.equal(await host.sweepBabysitterWorkspaces(temporary, Date.now(), cwd), 1)
  assert.equal(await host.sweepBabysitterWorkspaces(dataDir, Date.now(), cwd), 0)
  assert.ok(existsSync(join(dataDir, 'pr-workspaces', 'o+r+1', 'work', 'node_modules')))
  assert.equal(existsSync(join(dataDir, 'checkouts')), false)
})

test('the Babysitter pass runs in the PR workspace and records what it left', async () => {
  const server = await readFile(join(dist, 'server-DZOuXkga.js'), 'utf8')
  // The provider works in the pool entry, so runProvider neither creates nor deletes a temporary root.
  assert.match(server, /\.\.\.workspaceEntry && !workerSettings\.box \? \{ cwd: workspaceEntry\.work \} : \{\}/)
  assert.match(server, /persistent: \{\n\t+checkout: workspaceEntry\.checkout,\n\t+work: workspaceEntry\.work/)
  // The workspace is ready before the provider starts, so the pass knows whether it stayed warm.
  assert.match(server, /if \(workerSettings\.box\) providerDirectory = checkout;\n\t+else if \(workspaceEntry\) await preparePersistentWorkspace\(\);/)
  // A kept workspace with a current install record skips the host install.
  assert.match(server, /await hasCurrentGitHubDependencies\(directory\)\) schedulerEvent\("babysitter\.install\.skipped"/)
  // The record holds the head the pass left: its own push or the head it started on.
  assert.match(server, /head: pushedHead \?\? workspaceRun\.head,/)
  assert.match(server, /pullRequestInbox\.onTerminal = \(repository, number\) => \{\n\t+workspaces\.remove\(repository, number\)/)
  const hostSource = await readFile(join(dist, 'host-DBW8wmoH.js'), 'utf8')
  assert.match(hostSource, /root: join\(context\.dataDir, "pr-workspaces"\)/)
  assert.match(hostSource, /sweepWorkspaces\("startup"\)/)
})

test('pool limits come from the environment with sane defaults', () => {
  const GB = 1024 ** 3
  assert.deepEqual(pool.pullRequestWorkspaceLimits({}), { budgetBytes: 60 * GB, idleMs: 7 * 864e5, minFreeRatio: 0.15, sweepMs: 36e5 })
  assert.equal(pool.pullRequestWorkspaceLimits({ BABYSITTER_WORKSPACE_BUDGET_GB: '20' }).budgetBytes, 20 * GB)
  assert.throws(() => pool.pullRequestWorkspaceLimits({ BABYSITTER_WORKSPACE_IDLE_DAYS: 'soon' }), /BABYSITTER_WORKSPACE_IDLE_DAYS/)
})
