#!/usr/bin/env node
// Copies the Babysitter state DB into a compact file without the synthetic `reconcile:` deliveries.
// Until 2026-10-19 their IDs hashed the embedded PR, so every 15-minute probe re-stored every review
// and comment (27k rows, 500 MB an hour) and the DB grew to 18 GB, 16.5 GB of it in deliveries.
// Those rows only deduplicate later probes, and the new IDs never match them, so dropping them is safe.
// Usage (service stopped, as root): node ops/compact-state-db.mjs <source.db> <dest.db>
// --trial skips the source checkpoint, for a trial copy while the service is up. The source is never
// written either way; it opens read-write only because an attached database inherits the open flags.
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'

const [source, dest] = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const trial = process.argv.includes('--trial')
if (!source || !dest) throw new Error('usage: compact-state-db.mjs <source.db> <dest.db> [--trial]')
if (existsSync(dest)) throw new Error(`${dest} already exists`)

const db = new DatabaseSync(source)
db.exec('PRAGMA busy_timeout = 15000')
if (!trial) db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
db.exec(`ATTACH DATABASE '${dest.replaceAll("'", "''")}' AS d`)
db.exec('PRAGMA d.journal_mode = WAL')

const deliveries = 'vitehub_agent_state_babysitter_deliveries'
// Two primary-key ranges around the synthetic IDs, so the copy never reads their payload pages.
// A single NOT (...) filter makes the planner scan the whole 16 GB table.
const kept = schema => [`${schema}."${deliveries}" INDEXED BY sqlite_autoindex_${deliveries}_1 WHERE scope = 'babysitter' AND id < 'reconcile:'`, `${schema}."${deliveries}" INDEXED BY sqlite_autoindex_${deliveries}_1 WHERE scope = 'babysitter' AND id >= 'reconcile;'`]
const objects = db.prepare("SELECT type, name, tbl_name, sql FROM main.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type = 'index', rowid").all()
const started = Date.now()
db.exec('BEGIN')
for (const { type, name, sql } of objects.filter(object => object.type === 'table')) {
  db.exec(sql.replace(/^CREATE TABLE /, 'CREATE TABLE d.'))
  const sources = name === deliveries ? kept('main') : [`main."${name}"`]
  let copied = 0
  for (const from of sources) copied += db.prepare(`INSERT INTO d."${name}" SELECT * FROM ${from}`).run().changes
  console.log(type, name, copied, `${Math.round((Date.now() - started) / 1000)}s`)
}
for (const { name, sql } of objects.filter(object => object.type === 'index')) {
  db.exec(sql.replace(/^CREATE INDEX /, 'CREATE INDEX d.'))
  console.log('index', name, `${Math.round((Date.now() - started) / 1000)}s`)
}
if (db.prepare("SELECT 1 FROM d.sqlite_master WHERE name = 'sqlite_sequence'").get()) {
  db.exec('DELETE FROM d.sqlite_sequence')
  db.exec('INSERT INTO d.sqlite_sequence SELECT * FROM main.sqlite_sequence')
}
// Every table except deliveries must match row for row, inside the same read snapshot.
for (const { name } of objects.filter(object => object.type === 'table')) {
  const count = (schema, filtered) => (filtered ? kept(schema) : [`${schema}."${name}"`]).reduce((sum, from) => sum + db.prepare(`SELECT count(*) n FROM ${from}`).get().n, 0)
  const [from, to] = [count('main', name === deliveries), count('d', false)]
  if (from !== to) throw new Error(`${name}: ${from} rows in the source, ${to} in the copy`)
}
db.exec('COMMIT')
const check = db.prepare('PRAGMA d.quick_check').get()
if (Object.values(check)[0] !== 'ok') throw new Error(`quick_check: ${JSON.stringify(check)}`)
db.exec('PRAGMA d.wal_checkpoint(TRUNCATE)')
console.log('done', `${Math.round((Date.now() - started) / 1000)}s`)
