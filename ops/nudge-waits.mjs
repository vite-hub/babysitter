// Wakes every open waiting PR so it is re-evaluated now, typically right after a deploy changes the
// wait rules. Sets wait.retryAt to now on unleased waiting rows and backs them up to /root first.
// Usage: sudo node ops/nudge-waits.mjs
import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'
const db = new DatabaseSync('/home/workspace/babysitter-data/.vitehub/agent-state.db')
db.exec('PRAGMA busy_timeout = 10000')
const now = Date.now()
const rows = db.prepare(`SELECT repository, number, value, summary FROM vitehub_agent_state_babysitter_pull_requests WHERE scope='babysitter' AND state='open' AND waiting=1 AND lease IS NULL AND status<>'terminal'`).all()
writeFileSync(`/root/babysitter-nudge-backup-${now}.json`, JSON.stringify(rows))
const update = db.prepare(`UPDATE vitehub_agent_state_babysitter_pull_requests SET value=?, summary=? WHERE scope='babysitter' AND repository=? AND number=? AND waiting=1 AND lease IS NULL AND value=?`)
let n = 0
db.exec('BEGIN IMMEDIATE')
for (const row of rows) {
  const value = JSON.parse(row.value)
  if (!value.wait || (value.wait.retryAt !== undefined && value.wait.retryAt <= now)) continue
  const before = value.wait.retryAt
  value.wait.retryAt = now
  const summary = JSON.parse(row.summary)
  if (summary.wait) summary.wait.retryAt = now
  const r = update.run(JSON.stringify(value), JSON.stringify(summary), row.repository, row.number, row.value)
  if (r.changes) { n++; console.log(`${row.repository}#${row.number} ${value.wait.reason} retryAt ${before ? new Date(before).toISOString() : 'none'} -> now`) }
}
db.exec('COMMIT')
console.log('nudged', n)
