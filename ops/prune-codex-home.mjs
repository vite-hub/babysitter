#!/usr/bin/env node
// Removes what the worker Codex home keeps for checkouts that no longer exist.
// Codex trusts each pass checkout in config.toml. By 2026-10-20 that left 14,467 [projects."..."]
// tables (1 MB) that every Codex start parses, and .tmp held 14,653 git-* dirs, 9,816 older than 7 days.
// /tmp paths belong to the service's PrivateTmp, which every restart empties, so they are always stale.
// Usage (service stopped, as root): node ops/prune-codex-home.mjs [codex-home]
// The previous config stays next to it as config.toml.before-prune-<date>.
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, chownSync } from 'node:fs'
import { join } from 'node:path'

const home = process.argv[2] ?? '/home/agents/.codex'
const config = join(home, 'config.toml')
const tmpMaxAgeMs = 7 * 24 * 3600 * 1000

const lines = readFileSync(config, 'utf8').split('\n')
const kept = []
let dropping = false
let dropped = 0
for (const line of lines) {
  const table = line.match(/^\[projects\."(.*)"\]\s*$/)
  if (table) {
    dropping = table[1].startsWith('/tmp/') || !existsSync(table[1])
    if (dropping) dropped++
  } else if (line.startsWith('[')) {
    dropping = false
  }
  if (!dropping) kept.push(line)
}
const stamp = new Date().toLocaleString('sv').slice(0, 16).replace(/\D/g, '')
const { uid, gid, mode } = statSync(config)
writeFileSync(`${config}.new`, kept.join('\n'), { mode })
chownSync(`${config}.new`, uid, gid)
renameSync(config, `${config}.before-prune-${stamp}`)
renameSync(`${config}.new`, config)
console.log(`config.toml: dropped ${dropped} stale project tables, ${statSync(config).size} bytes left`)

let removed = 0
const tmp = join(home, '.tmp')
for (const name of existsSync(tmp) ? readdirSync(tmp) : []) {
  const path = join(tmp, name)
  if (Date.now() - statSync(path).mtimeMs < tmpMaxAgeMs) continue
  rmSync(path, { recursive: true, force: true })
  removed++
}
console.log(`.tmp: removed ${removed} entries older than 7 days`)
