// Writes changed rows and meta keys to stdout as a backup; progress goes to stderr.
// Run as the database owner to avoid root-owned WAL files. See ops/README.md.
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(process.env.BABYSITTER_STATE_DB || '/home/workspace/babysitter-data/.vitehub/agent-state.db')
db.exec('PRAGMA busy_timeout = 15000')
const now = Date.now()
const day = 864e5
// agent.ts dailyPassBudget, and repairPushCap in the server chunk.
const dailyPasses = 16
const repairPushCap = 5
const table = 'vitehub_agent_state_babysitter_pull_requests'
const metaTable = 'vitehub_agent_state_babysitter_meta'
const getMeta = db.prepare(`SELECT value FROM ${metaTable} WHERE scope='babysitter' AND key=?`)
const setMeta = db.prepare(`UPDATE ${metaTable} SET value=? WHERE scope='babysitter' AND key=? AND value=?`)
const update = db.prepare(`UPDATE ${table} SET value=?, summary=? WHERE scope='babysitter' AND repository=? AND number=? AND lease IS NULL AND value=?`)
const backup = { at: now, rows: [], meta: [] }
let unparked = 0
db.exec('BEGIN IMMEDIATE')
try {
  const rows = db.prepare(`SELECT repository, number, value, summary, waiting FROM ${table} WHERE scope='babysitter' AND state='open' AND status<>'terminal' AND lease IS NULL ORDER BY repository, number`).all()
  for (const row of rows) {
    const id = `${row.repository}#${row.number}`
    const value = JSON.parse(row.value)
    const summary = JSON.parse(row.summary)
    const changes = []
    const passes = (value.dailyPassBudget?.passes ?? []).filter((at) => at > now - day)
    if (passes.length >= dailyPasses) {
      value.dailyPassBudget.passes = []
      if (summary.dailyPassBudget) summary.dailyPassBudget.passes = []
      changes.push(`daily passes ${passes.length} -> 0`)
    }
    const pushKey = `repair-pushes:${id}`
    const pushRow = getMeta.get(pushKey)
    const pushes = pushRow ? JSON.parse(pushRow.value) : []
    const recentPushes = Array.isArray(pushes) ? pushes.filter((at) => at > now - day) : []
    if (recentPushes.length >= repairPushCap) {
      backup.meta.push({ key: pushKey, value: pushRow.value })
      if (!setMeta.run('[]', pushKey, pushRow.value).changes) throw new Error(`${pushKey} changed while unparking`)
      changes.push(`repair pushes ${recentPushes.length} -> 0`)
    }
    if (row.waiting && value.wait && !(value.wait.retryAt <= now)) {
      changes.push(`${value.wait.reason} retryAt ${value.wait.retryAt ? new Date(value.wait.retryAt).toISOString() : 'none'} -> now`)
      value.wait.retryAt = now
      if (summary.wait) summary.wait.retryAt = now
    }
    if (value.reviewPushBudget?.count >= 3) console.error(`${id} review push budget spent (${value.reviewPushBudget.count}); left as is`)
    if (value.progressBudget?.exhausted) console.error(`${id} no-progress budget exhausted; left as is`)
    if (!changes.length) continue
    backup.rows.push({ repository: row.repository, number: row.number, value: row.value, summary: row.summary })
    if (!update.run(JSON.stringify(value), JSON.stringify(summary), row.repository, row.number, row.value).changes) throw new Error(`${id} changed while unparking`)
    unparked++
    console.error(`${id}: ${changes.join('; ')}`)
  }
  db.exec('COMMIT')
} catch (error) {
  db.exec('ROLLBACK')
  throw error
}
console.log(JSON.stringify(backup))
console.error('unparked', unparked)
