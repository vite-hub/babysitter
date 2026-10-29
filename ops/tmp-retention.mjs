#!/usr/bin/env node
// Daily retention for the Babysitter TMPDIR (babysitter-tmp-retention.timer, as svc-babysitter at
// idle IO priority). The service sweeps pass workspaces only at startup, and nothing ever removed
// Node's compile cache: on 2026-10-29 a manual cleanup freed 22 GB of cache files older than 48 h.
//
//   node ops/tmp-retention.mjs [--dry-run]
//
// It removes, inside TMPDIR only:
// - Node compile-cache files older than 48 h, then the oldest ones until the cache fits its budget;
// - pass workspaces older than 48 h, when no unfinished PR in the state DB names them and no
//   process has its cwd or an open file inside. If the state DB can't be read it keeps them all.
// It never follows symlinks, and refuses any root that is not a `tmp` directory, so the state
// databases, backups, bin/ and credentials beside it are out of reach.
import { DatabaseSync } from 'node:sqlite'
import { chmod, lstat, readdir, readlink, rm, rmdir } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const HOUR = 3600_000
export const defaults = {
  root: process.env.BABYSITTER_RETENTION_ROOT || '/home/workspace/babysitter-data/tmp',
  stateDb: process.env.BABYSITTER_RETENTION_STATE_DB || '/home/workspace/babysitter-data/.vitehub/agent-state.db',
  maxAgeMs: Number(process.env.BABYSITTER_RETENTION_MAX_AGE_HOURS || 48) * HOUR,
  compileCacheBudgetBytes: Number(process.env.BABYSITTER_COMPILE_CACHE_BUDGET_MB || 2048) * 2 ** 20,
}

// The names @vite-hub/agent gives pass workspaces (sweepBabysitterWorkspaces in the agent bundle).
const passWorkspace = /^(?:vitehub-provider-(?:launch-)?[A-Za-z0-9]{6}|vitehub-baseline-[A-Za-z0-9]{6}|vitehub-[\w.-]+-pr-\d+-[A-Za-z0-9]{6}(?:\.meta\.json)?|t3-provider-runtime-[A-Za-z0-9]{6})$/

function assertSafeRoot(root) {
  if (basename(root) !== 'tmp' || resolve(root) === '/tmp') throw new Error(`refusing to clean ${root}: not a service tmp directory`)
}
const inside = (path, root) => resolve(path).startsWith(`${resolve(root)}${sep}`)

/** Removes compile-cache files past `maxAgeMs`, then the oldest until the rest fit the budget. */
export async function pruneCompileCache(root, { now = Date.now(), maxAgeMs = defaults.maxAgeMs, budgetBytes = defaults.compileCacheBudgetBytes, dryRun = false } = {}) {
  assertSafeRoot(root)
  const cache = join(root, 'node-compile-cache')
  const files = []
  const directories = []
  // Node keeps one directory per version, architecture and uid, with flat cache files inside.
  for (const version of await readdir(cache, { withFileTypes: true }).catch(() => [])) {
    if (!version.isDirectory()) continue
    const directory = join(cache, version.name)
    directories.push(directory)
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile()) continue
      const path = join(directory, entry.name)
      const info = await lstat(path).catch(() => undefined)
      if (info) files.push({ path, size: info.size, at: info.mtimeMs })
    }
  }
  const result = { removed: 0, freedBytes: 0, keptBytes: 0 }
  const remove = async file => {
    if (!dryRun) await rm(file.path, { force: true })
    result.removed++
    result.freedBytes += file.size
  }
  const kept = []
  for (const file of files) {
    if (now - file.at > maxAgeMs) await remove(file)
    else kept.push(file)
  }
  let total = kept.reduce((sum, file) => sum + file.size, 0)
  for (const file of kept.sort((left, right) => left.at - right.at)) {
    if (total <= budgetBytes) break
    await remove(file)
    total -= file.size
  }
  result.keptBytes = total
  // A running Node writes into its directory, so only drop old empty ones.
  for (const directory of directories) {
    const info = await lstat(directory).catch(() => undefined)
    if (!dryRun && info && now - info.mtimeMs > maxAgeMs) await rmdir(directory).catch(() => {})
  }
  return result
}

/** Workspace name prefixes of PRs that are being worked or are queued: anything but terminal or waiting. */
export function activeWorkspacePrefixes(stateDb) {
  const db = new DatabaseSync(stateDb, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 15000')
    const rows = db.prepare(`SELECT repository, number FROM vitehub_agent_state_babysitter_pull_requests
      WHERE status NOT IN ('terminal', 'waiting') OR lease IS NOT NULL`).all()
    return rows.map(row => `vitehub-${String(row.repository).replace('/', '-')}-pr-${row.number}-`)
  } finally {
    db.close()
  }
}

/** Every cwd and open file of the processes this user can inspect. */
export async function busyPaths(proc = '/proc') {
  const paths = new Set()
  for (const pid of await readdir(proc).catch(() => [])) {
    if (!/^\d+$/.test(pid)) continue
    const cwd = await readlink(join(proc, pid, 'cwd')).catch(() => undefined)
    if (cwd) paths.add(cwd)
    for (const fd of await readdir(join(proc, pid, 'fd')).catch(() => [])) {
      const target = await readlink(join(proc, pid, 'fd', fd)).catch(() => undefined)
      if (target?.startsWith('/')) paths.add(target.replace(/ \(deleted\)$/, ''))
    }
  }
  return [...paths]
}

/** Newest mtime of an entry and its direct children; a pass touches its top level as it works. */
async function lastTouched(path) {
  const info = await lstat(path)
  let at = info.mtimeMs
  if (info.isDirectory()) {
    for (const child of await readdir(path).catch(() => [])) {
      const childInfo = await lstat(join(path, child)).catch(() => undefined)
      if (childInfo) at = Math.max(at, childInfo.mtimeMs)
    }
  }
  return at
}

async function removeTree(path) {
  try {
    await rm(path, { recursive: true, force: true })
  } catch {
    // Some installs leave read-only directories; the owner can make them writable again.
    const fix = async target => {
      const info = await lstat(target).catch(() => undefined)
      if (!info?.isDirectory()) return
      await chmod(target, 0o700).catch(() => {})
      for (const child of await readdir(target).catch(() => [])) await fix(join(target, child))
    }
    await fix(path)
    await rm(path, { recursive: true, force: true })
  }
}

/** Removes abandoned pass workspaces. Returns what it removed and why it kept the rest. */
export async function sweepWorkspaces(root, { now = Date.now(), maxAgeMs = defaults.maxAgeMs, activePrefixes, busy, dryRun = false }) {
  assertSafeRoot(root)
  const result = { removed: [], kept: { recent: 0, queued: 0, busy: 0 }, failed: [] }
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!passWorkspace.test(entry.name) || entry.isSymbolicLink()) continue
    const path = join(root, entry.name)
    if (!inside(path, root)) continue
    const base = entry.name.replace(/\.meta\.json$/, '')
    let touched = await lastTouched(path).catch(() => undefined)
    if (touched === undefined) continue
    // A workspace's metadata file lives as long as the workspace.
    if (base !== entry.name) touched = Math.max(touched, await lastTouched(join(root, base)).catch(() => 0))
    if (now - touched <= maxAgeMs) { result.kept.recent++; continue }
    if (activePrefixes.some(prefix => entry.name.startsWith(prefix))) { result.kept.queued++; continue }
    if (busy.some(target => target === path || target.startsWith(`${path}${sep}`) || target.startsWith(`${join(root, base)}${sep}`))) { result.kept.busy++; continue }
    try {
      if (!dryRun) await removeTree(path)
      result.removed.push(entry.name)
    } catch (error) {
      result.failed.push(`${entry.name}: ${error.message}`)
    }
  }
  return result
}

export async function retain({ root = defaults.root, stateDb = defaults.stateDb, now = Date.now(), maxAgeMs = defaults.maxAgeMs, compileCacheBudgetBytes = defaults.compileCacheBudgetBytes, dryRun = false, proc = '/proc' } = {}) {
  assertSafeRoot(root)
  const compileCache = await pruneCompileCache(root, { now, maxAgeMs, budgetBytes: compileCacheBudgetBytes, dryRun })
  let workspaces
  try {
    const activePrefixes = activeWorkspacePrefixes(stateDb)
    workspaces = await sweepWorkspaces(root, { now, maxAgeMs, activePrefixes, busy: await busyPaths(proc), dryRun })
  } catch (error) {
    workspaces = { skipped: `cannot read active PRs from ${stateDb}: ${error.message}` }
  }
  return { root, dryRun, compileCache, workspaces }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await retain({ dryRun: process.argv.includes('--dry-run') })
  const { compileCache: cache, workspaces } = report
  console.log(`compile cache: removed ${cache.removed} files (${(cache.freedBytes / 2 ** 30).toFixed(2)} GiB), ${(cache.keptBytes / 2 ** 30).toFixed(2)} GiB kept`)
  if (workspaces.skipped) console.log(`workspaces: skipped, ${workspaces.skipped}`)
  else console.log(`workspaces: removed ${workspaces.removed.length}; kept ${workspaces.kept.recent} recent, ${workspaces.kept.queued} for unfinished PRs, ${workspaces.kept.busy} in use${workspaces.failed.length ? `; failed ${workspaces.failed.join('; ')}` : ''}`)
  if (report.dryRun) console.log('dry run: nothing was removed')
  if (workspaces.failed?.length) process.exitCode = 1
}
