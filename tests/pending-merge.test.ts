// vite-hub/vitehub#3350: GitHub answered "pending" for one asynchronous merge request for 19 hours,
// and the Babysitter read it again every 30 seconds and edited the status comment each time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let modules = dirname(realpathSync(fileURLToPath(import.meta.resolve('vite-hub/agent'))))
while (!modules.endsWith('/node_modules')) modules = dirname(modules)
const dist = join(modules, '@vite-hub/agent/dist')
const server = join(dist, 'server-DZOuXkga.js')
const { pw: pendingMergeWait } = await import(server)
const source = readFileSync(server, 'utf8')

const minute = 60_000
const attempt = { startedAt: 0, requestId: '9e6273b9-0000-4000-8000-000000000000' }
const delay = (now: number) => {
  const wait = pendingMergeWait(attempt, now)
  assert.equal(wait.stopped, false)
  return wait.retryAt - now
}

test('a pending merge request is polled less often as it ages', () => {
  assert.equal(delay(0), 0.5 * minute)
  assert.equal(delay(1 * minute), 1 * minute)
  assert.equal(delay(2 * minute), 2 * minute)
  assert.equal(delay(10 * minute), 5 * minute)
  assert.equal(delay(29 * minute), 5 * minute)
})

test('a merge request still pending after 30 minutes stops with the reason', () => {
  for (const now of [30 * minute, 19 * 60 * minute]) {
    const wait = pendingMergeWait(attempt, now)
    assert.equal(wait.stopped, true)
    assert.equal(wait.retryAt, undefined)
    assert.match(wait.reason, /GitHub merge request 9e6273b9-0000-4000-8000-000000000000/)
    assert.match(wait.reason, new RegExp(`still pending after ${Math.floor(now / minute)} minutes`))
  }
})

test('a stopped merge releases its fence, parks without a retry, and is not requested again on the same head', () => {
  const has = (pattern: RegExp, message: string) => assert.ok(pattern.test(source), message)
  has(/if \(!wait\.stopped\) return await parkMerge\(wait\.reason, \{ retryAt: wait\.retryAt \}\);/, 'a pending read parks until the backoff retry')
  has(/await pullRequestInbox\.clearDirectMerge\(repository, number, pending\.token\);\n\t+schedulerEvent\("babysitter\.direct_merge\.stopped"[^]*?return await parkMerge\(wait\.reason, \{\}\);/, 'a stopped request releases the fence and parks without a retry')
  has(/stopped\.head === decision\.head && hasRuntimeType\(stopped\.reason, "string"\)\) return await parkMerge\(stopped\.reason, \{\}\);/, 'the same head is not requested again')
  // The fresh-request guard runs before the merge fence opens.
  assert.ok(source.indexOf('stopped.head === decision.head') < source.indexOf('await pullRequestInbox.beginDirectMerge(claim, decision.head, true)'))
})
