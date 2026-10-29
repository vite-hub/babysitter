import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { retain } from '../ops/tmp-retention.mjs'

const HOUR = 3600_000
const now = Date.now()

function age(path: string, hours: number) {
  const at = new Date(now - hours * HOUR)
  utimesSync(path, at, at)
}
function file(path: string, bytes = 1, hours = 0) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, Buffer.alloc(bytes))
  age(path, hours)
  return path
}
function workspace(root: string, name: string, hours: number) {
  const path = join(root, name)
  file(join(path, 'node_modules', 'dep', 'index.js'), 10, hours)
  age(join(path, 'node_modules', 'dep'), hours)
  age(join(path, 'node_modules'), hours)
  age(path, hours)
  return path
}

// A Babysitter data directory with its state DB, backups, credentials and a TMPDIR to clean.
function dataDirectory() {
  const data = mkdtempSync(join(tmpdir(), 'babysitter-retention-'))
  const root = join(data, 'tmp')
  mkdirSync(join(data, '.vitehub'), { recursive: true })
  const stateDb = join(data, '.vitehub', 'agent-state.db')
  const db = new DatabaseSync(stateDb)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`CREATE TABLE vitehub_agent_state_babysitter_pull_requests (scope TEXT NOT NULL, repository TEXT NOT NULL, number INTEGER NOT NULL,
    status TEXT NOT NULL, lease TEXT, PRIMARY KEY(scope, repository, number))`)
  const insert = db.prepare('INSERT INTO vitehub_agent_state_babysitter_pull_requests VALUES (?, ?, ?, ?, ?)')
  insert.run('babysitter', 'vite-hub/vitehub', 101, 'working', 'lease-1')
  insert.run('babysitter', 'vite-hub/vitehub', 102, 'ready', null)
  insert.run('babysitter', 'vite-hub/vitehub', 103, 'waiting', null)
  insert.run('babysitter', 'vite-hub/vitehub', 104, 'terminal', null)
  // Keep the connection open so the -wal and -shm files exist, as they do beside the live service.
  const protectedFiles = [
    stateDb, `${stateDb}-wal`, `${stateDb}-shm`,
    file(join(data, '.vitehub', 'agents', 'babysitter', 'invocations.sqlite'), 1, 200),
    file(join(data, 'backups', 'agent-state-20261001.db'), 1, 600),
    file(join(data, 'bin', 'worker', 'heavy-command-gate.cjs'), 1, 600),
    file(join(data, 'github-app.env'), 1, 600),
  ]
  return { data, root, stateDb, db, protectedFiles, cleanup: () => { db.close(); rmSync(data, { recursive: true, force: true }) } }
}

test('old compile-cache files go first, then the oldest until the cache fits its budget', async () => {
  const fixture = dataDirectory()
  try {
    const cache = join(fixture.root, 'node-compile-cache', 'v24.21.0-x64-964aae3f-992')
    const stale = file(join(cache, '00000001'), 100, 49)
    const older = file(join(cache, '00000002'), 100, 10)
    const newer = file(join(cache, '00000003'), 100, 1)
    const newest = file(join(cache, '00000004'), 100, 0)
    const report = await retain({ root: fixture.root, stateDb: fixture.stateDb, now, maxAgeMs: 48 * HOUR, compileCacheBudgetBytes: 250 })
    assert.deepEqual(report.compileCache, { removed: 2, freedBytes: 200, keptBytes: 200 })
    assert.deepEqual([stale, older, newer, newest].map(path => existsSync(path)), [false, false, true, true])
  } finally { fixture.cleanup() }
})

test('abandoned pass workspaces are removed, unless recent, queued, or in use', async () => {
  const fixture = dataDirectory()
  try {
    const { root } = fixture
    const abandoned = workspace(root, 'vitehub-vite-hub-vitehub-pr-104-aB3dE5', 72)
    const abandonedMeta = file(`${abandoned}.meta.json`, 1, 72)
    const waiting = workspace(root, 'vitehub-vite-hub-vitehub-pr-103-Qw3rTy', 72)
    const provider = workspace(root, 'vitehub-provider-Zx9cVb', 72)
    const working = workspace(root, 'vitehub-vite-hub-vitehub-pr-101-aaaaaa', 72)
    const queued = workspace(root, 'vitehub-vite-hub-vitehub-pr-102-bbbbbb', 72)
    const recent = workspace(root, 'vitehub-vite-hub-vitehub-pr-104-cccccc', 2)
    // The metadata file is old, but its workspace is not.
    const recentMeta = file(`${recent}.meta.json`, 1, 72)
    const cwdInside = workspace(root, 'vitehub-provider-launch-dddddd', 72)
    const fileOpen = workspace(root, 't3-provider-runtime-eeeeee', 72)
    // Not a pass workspace name: left to whoever made it.
    const other = workspace(root, 'playwright_chromiumdev_profile-ffffff', 500)
    // Links inside a workspace are removed, never followed.
    for (const [target, link] of [[fixture.stateDb, join(abandoned, 'state.db')], [join(fixture.data, 'backups'), join(provider, 'backups')]] as const) {
      symlinkSync(target, link)
      lutimesSync(link, new Date(now - 72 * HOUR), new Date(now - 72 * HOUR))
    }
    age(abandoned, 72)
    age(provider, 72)
    // An install left a read-only directory behind.
    chmodSync(join(waiting, 'node_modules', 'dep'), 0o555)
    age(join(waiting, 'node_modules'), 72)
    age(waiting, 72)

    const proc = join(fixture.data, 'proc-fixture')
    mkdirSync(join(proc, '41', 'fd'), { recursive: true })
    symlinkSync(join(cwdInside, 'node_modules'), join(proc, '41', 'cwd'))
    mkdirSync(join(proc, '42', 'fd'), { recursive: true })
    symlinkSync('/', join(proc, '42', 'cwd'))
    symlinkSync(join(fileOpen, 'node_modules', 'dep', 'index.js'), join(proc, '42', 'fd', '7'))
    symlinkSync('socket:[1234]', join(proc, '42', 'fd', '8'))

    const dry = await retain({ root, stateDb: fixture.stateDb, now, proc, dryRun: true })
    assert.equal(dry.workspaces.removed.length, 4)
    assert.ok(existsSync(abandoned), 'a dry run removes nothing')

    const report = await retain({ root, stateDb: fixture.stateDb, now, proc })
    assert.deepEqual(report.workspaces.removed.sort(), [
      'vitehub-provider-Zx9cVb',
      'vitehub-vite-hub-vitehub-pr-103-Qw3rTy',
      'vitehub-vite-hub-vitehub-pr-104-aB3dE5',
      'vitehub-vite-hub-vitehub-pr-104-aB3dE5.meta.json',
    ])
    assert.deepEqual(report.workspaces.kept, { recent: 2, queued: 2, busy: 2 })
    assert.deepEqual(report.workspaces.failed, [])
    for (const path of [abandoned, abandonedMeta, waiting, provider]) assert.equal(existsSync(path), false, path)
    for (const path of [working, queued, recent, recentMeta, cwdInside, fileOpen, other]) assert.equal(existsSync(path), true, path)
    for (const path of fixture.protectedFiles) assert.equal(existsSync(path), true, path)
    assert.deepEqual(readdirSync(join(fixture.data, 'backups')), ['agent-state-20261001.db'])
  } finally { fixture.cleanup() }
})

test('an unreadable state DB keeps every workspace but still prunes the compile cache', async () => {
  const fixture = dataDirectory()
  try {
    const abandoned = workspace(fixture.root, 'vitehub-provider-Zx9cVb', 72)
    const stale = file(join(fixture.root, 'node-compile-cache', 'v26', 'aa'), 10, 72)
    const report = await retain({ root: fixture.root, stateDb: join(fixture.data, 'missing.db'), now })
    assert.match(report.workspaces.skipped, /cannot read active PRs/)
    assert.equal(existsSync(abandoned), true)
    assert.equal(existsSync(stale), false)
  } finally { fixture.cleanup() }
})

test('retention refuses any root that is not a service tmp directory', async () => {
  const fixture = dataDirectory()
  try {
    for (const root of [fixture.data, join(fixture.data, '.vitehub'), '/tmp']) {
      await assert.rejects(retain({ root, stateDb: fixture.stateDb, now }), /refusing to clean/)
    }
    for (const path of fixture.protectedFiles) assert.equal(existsSync(path), true, path)
  } finally { fixture.cleanup() }
})
