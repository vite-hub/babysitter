import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createSqliteProviderRuntimeSessionStore } from '@t3tools/provider-runtime'

test('persists provider cursors and retains the latest 1,000 threads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'babysitter-provider-sessions-'))
  const path = join(directory, 'sessions.sqlite')
  const store = await createSqliteProviderRuntimeSessionStore(path)

  try {
    for (let index = 0; index <= 1_000; index += 1) {
      const value = String(index).padStart(4, '0')
      await store.set(`thread-${value}`, { threadId: `cursor-${value}` })
    }

    assert.equal(await store.get('thread-0000'), undefined)
    assert.deepEqual(await store.get('thread-1000'), { threadId: 'cursor-1000' })

    const database = new DatabaseSync(path, { readOnly: true })
    try {
      assert.equal(database.prepare('SELECT count(*) AS count FROM t3_provider_runtime_sessions').get().count, 1_000)
    }
    finally {
      database.close()
    }
  }
  finally {
    store.close()
    await rm(directory, { force: true, recursive: true })
  }
})
