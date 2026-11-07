// Contracts of the @vite-hub/agent patch that stops the Babysitter from re-reading its state
// databases. On 2026-11-07 the service read ~9 MB/s: the admission token budget walked the whole
// invocation journal every minute, and every check webhook parsed each leased or waiting PR snapshot.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dist } from './agent-dist.ts'

const source = readdirSync(dist, { recursive: true, encoding: 'utf8' })
  .filter(name => name.endsWith('.js'))
  .map(name => readFileSync(join(dist, name), 'utf8'))
  .join('\n')

test('the admission token budget lists only invocations updated since its last read', () => {
  assert.match(source, /updatedSince: new Date\(since\)\.toISOString\(\)/)
  assert.match(source, /filters\.push\("updated_at >= \?"\);/)
  assert.match(source, /WHERE sequence IN \(SELECT sequence FROM \$\{table\}\$\{where\} ORDER BY sequence DESC LIMIT \?\)/)
})

test('check webhooks match pending heads in SQL instead of parsing every leased or waiting snapshot', () => {
  assert.doesNotMatch(source, /SELECT number, value FROM \$\{t\.pullRequests\} WHERE scope=\? AND repository=\? AND state='open' AND \(lease IS NOT NULL OR waiting=1\)`/)
  assert.match(source, /AND \(wait_head=\? OR \(lease IS NOT NULL AND lease_until>\? AND EXISTS \(SELECT 1 FROM json_each\(lease_heads\) WHERE value=\?\)\)\)/)
})

test('stale CI evidence is deleted in SQL, and metadata prefixes read a key range', () => {
  assert.doesNotMatch(source, /await this\.metaEntries\("ci-evidence:v1:"\)/)
  assert.match(source, /key>='ci-evidence:v1:' AND key<'ci-evidence:v1;'/)
  assert.match(source, /WHERE scope=\? AND key>=\? AND key<\? AND substr\(key, 1, \?\)=\? ORDER BY key/)
})

test('a version 1 inbox moves the JSON columns last and fills the pending-head columns', async () => {
  const { PullRequestInbox, createNodeSqliteInboxStorage } = await import(join(dist, 'server/github-inbox.js'))
  const directory = mkdtempSync(join(tmpdir(), 'babysitter-state-'))
  const path = join(directory, 'inbox.db')
  try {
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE vitehub_babysitter_schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO vitehub_babysitter_schema_version VALUES (1);
      CREATE TABLE vitehub_babysitter_pull_requests (scope TEXT NOT NULL, repository TEXT NOT NULL, number INTEGER NOT NULL,
        value TEXT NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL, generation INTEGER NOT NULL, handled INTEGER NOT NULL,
        dirty_at INTEGER NOT NULL, next_at INTEGER NOT NULL, lease TEXT, lease_until INTEGER NOT NULL, waiting INTEGER NOT NULL,
        progress_blocked INTEGER NOT NULL, state TEXT, head_sha TEXT, head_ref TEXT, base_ref TEXT, PRIMARY KEY(scope, repository, number));
      CREATE TABLE vitehub_babysitter_deliveries (scope TEXT NOT NULL, id TEXT NOT NULL, event TEXT, received INTEGER NOT NULL,
        payload TEXT, result TEXT, PRIMARY KEY(scope, id));
      CREATE TABLE vitehub_babysitter_meta (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY(scope, key));`)
    const insert = db.prepare(`INSERT INTO vitehub_babysitter_pull_requests VALUES (?, 'o/r', ?, ?, '{}', 'waiting', 1, 1, 0, 0, ?, 0, ?, 0, 'open', 'h', 'f', 'main')`)
    insert.run('s', 1, JSON.stringify({ wait: { headSha: 'a'.repeat(40) } }), null, 1)
    insert.run('s', 2, JSON.stringify({ lease: 't', sourcePushHeads: ['b'], prospectivePush: { token: 't', heads: ['c', 'b'] } }), 't', 0)
    insert.run('s', 3, JSON.stringify({ lease: 't', prospectivePush: { token: 'old', heads: ['d'] } }), 't', 0)
    insert.run('s', 4, 'not json', null, 0)
    db.close()

    const inbox = new PullRequestInbox({ storage: createNodeSqliteInboxStorage(path), scope: 's', repositories: ['o/r'] })
    await inbox.init()
    await inbox.close()

    const migrated = new DatabaseSync(path)
    const columns = migrated.prepare(`SELECT name FROM pragma_table_info('vitehub_babysitter_pull_requests')`).all().map(row => row.name)
    assert.deepEqual(columns.slice(-4), ['wait_head', 'lease_heads', 'summary', 'value'])
    const rows = migrated.prepare(`SELECT number, wait_head, lease_heads, value FROM vitehub_babysitter_pull_requests ORDER BY number`).all()
    assert.deepEqual(rows.map(row => [row.number, row.wait_head, row.lease_heads && JSON.parse(String(row.lease_heads)).sort()]), [
      [1, 'a'.repeat(40), null],
      [2, null, ['b', 'c']],
      [3, null, []],
      [4, null, null],
    ])
    assert.equal(rows[3]?.value, 'not json')
    assert.equal(migrated.prepare(`SELECT MAX(version) AS version FROM vitehub_babysitter_schema_version`).get()?.version, 2)
    migrated.close()
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an updatedSince listing returns what a filtered walk of the whole journal returns', async () => {
  const { createLibsqlAgentInvocationStore } = await import(join(dist, 'invocations/sqlite.js'))
  const directory = mkdtempSync(join(tmpdir(), 'babysitter-invocations-'))
  try {
    const store = createLibsqlAgentInvocationStore({ url: `file:${join(directory, 'invocations.db')}` })
    const statuses = ['pending', 'running', 'completed', 'failed', 'cancelled']
    const base = Date.now() - 360 * 60_000
    // updatedAt is out of sequence order on purpose: a long pass has an old sequence and a new updatedAt.
    for (let index = 0; index < 250; index++) {
      const updatedAt = new Date(base + ((index * 7919) % 250) * 60_000).toISOString()
      await store.create({
        id: `sha256_${String(index).padStart(64, '0')}`,
        agentName: 'babysitter-worker',
        channelId: 'github',
        threadId: `thread-${index}`,
        traceId: `sha256_${String(index).padStart(64, '1')}`,
        status: statuses[index % statuses.length],
        createdAt: updatedAt,
        updatedAt,
        observations: [],
      })
    }
    const walk = async (options: object) => {
      const ids: string[] = []
      let cursor: string | undefined
      do {
        const page = await store.list({ ...options, cursor, limit: 100 })
        ids.push(...page.invocations.map((invocation: { id: string, updatedAt: string }) => `${invocation.id}@${invocation.updatedAt}`))
        cursor = page.cursor
      } while (cursor)
      return ids
    }
    const everything = await walk({})
    for (const minutes of [0, 100, 249, 300]) {
      const since = new Date(base + minutes * 60_000).toISOString()
      assert.deepEqual(await walk({ status: statuses, updatedSince: since }), everything.filter(entry => entry.split('@')[1]! >= since))
    }
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
