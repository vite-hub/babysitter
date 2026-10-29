'use strict'
// Loaded by the worker Node wrapper (scripts/worker-bin/node). Typecheck, test and dependency
// install processes each use 1-2.5 GB, and several workers running them at once thrash this host.
// Such a process waits here for one of BABYSITTER_HEAVY_SLOTS host-wide slots. Its child
// processes inherit the lease, so a gated command that runs another one never waits on itself.
const { closeSync, openSync, realpathSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

const installCommands = {
  pnpm: new Set(['install', 'i', 'add', 'install-test', 'it']),
  npm: new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add', 'ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean', 'install-test', 'it', 'install-ci-test', 'cit']),
}
// Options whose value is the next argument, so it is not mistaken for the command.
const valueOptions = new Set(['-C', '--dir', '--workspace-dir', '-F', '--filter', '--filter-prod', '--prefix', '--loglevel', '--reporter', '--userconfig', '--cache', '--registry', '--workspace'])

/** The first positional argument, skipping global options and their values. */
function subcommand(args) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--') return args[index + 1]
    if (!arg.startsWith('-')) return arg
    if (!arg.includes('=') && valueOptions.has(arg)) index++
  }
}

/** The package manager a script runs: a pnpm or npm binary, or Corepack naming one. */
function packageManager(script, args) {
  if (/\/corepack\/dist\/corepack\.js$/.test(script)) {
    const name = /^(pnpm|npm)(?:@[^/\s]+)?$/.exec(args[0] || '')?.[1]
    return name && { name, args: args.slice(1) }
  }
  // Corepack's own cache keeps each version under pnpm/<version>/bin.
  if (/\/corepack\/dist\/pnpm\.js$|\/pnpm\/(?:\d[^/]*\/)?(?:bin|dist)\/pnpm\.c?js$/.test(script)) return { name: 'pnpm', args }
  if (/\/corepack\/dist\/npm\.js$|\/npm\/bin\/npm-cli\.js$/.test(script)) return { name: 'npm', args }
}

/** Whether a Node process for `script` with `args` must hold a heavy slot. */
function isHeavyCommand(script, args) {
  if (/\/typescript\/bin\/tsc$|\/vitest\/vitest\.mjs$|\/vite-plus\/dist\/pack-bin\.js$|\/vite-plus\/bin\/vp$/.test(script)) return true
  const manager = packageManager(script, args)
  return !!manager && installCommands[manager.name].has(subcommand(manager.args))
}

/** Slot lock files: heavy-command.lock, then heavy-command.lock.1 and up. */
function slotFiles(lock, slots) {
  return Array.from({ length: slots }, (_, index) => index ? `${lock}.${index}` : lock)
}

module.exports = { isHeavyCommand, slotFiles }

let script = process.argv[1] || ''
try { script = realpathSync(script) } catch {}
script = script.replace(/\\/g, '/')
const args = process.argv.slice(2)

// Full Nuxt app builds take 6-7 GB each and stalled every worker under the
// service memory limit. Workers must not run local builds; CI builds every push.
if (/\/(?:nuxt\/bin\/nuxt|nuxi\/bin\/nuxi)\.mjs$/.test(script) && /^(?:build|generate)$/.test(args[0] || '')) {
  process.stderr.write('[babysitter] Local Nuxt builds are disabled for workers. Rely on CI for build validation.\n')
  process.exit(1)
}

if (isHeavyCommand(script, args) && !process.env.BABYSITTER_HEAVY_SLOT && !process.env.FLEET_QUEUE_ACTIVE) {
  // Provider sandboxes have private /tmp and PID namespaces and cannot create files here. Open
  // persistent host lock files read-only; flock follows the shared inode across those namespaces.
  const lock = process.env.BABYSITTER_HEAVY_LOCK || join(__dirname, 'heavy-command.lock')
  const slots = Math.max(1, Math.floor(Number(process.env.BABYSITTER_HEAVY_SLOTS)) || 1)
  const files = []
  const descriptors = []
  for (const file of slotFiles(lock, slots)) {
    try { descriptors.push(openSync(file, 'r')); files.push(file) } catch {}
  }
  if (!descriptors.length) {
    process.stderr.write('[babysitter] Shared heavy-command lock is unavailable. Install the host lock before running worker checks.\n')
    process.exit(1)
  }
  if (descriptors.length < slots) process.stderr.write(`[babysitter] Only ${descriptors.length} of ${slots} heavy-command slot locks exist; using those.\n`)
  // One helper tries every slot without blocking and exits with the fd it locked. The lock
  // belongs to the shared open-file description, so this process keeps it after flock exits.
  const fds = descriptors.map((_, index) => index + 3)
  const helper = `while :; do for fd in ${fds.join(' ')}; do flock --exclusive --nonblock "$fd" && exit "$fd"; done; [ -n "$announced" ] || { echo "[babysitter] Waiting for one of ${descriptors.length} shared typecheck/test/install slots; other workers are using them." >&2; announced=1; }; kill -0 "$PPID" 2>/dev/null || exit 1; sleep 1; done`
  const result = spawnSync('sh', ['-c', helper], { stdio: ['inherit', 'inherit', 'inherit', ...descriptors] })
  const held = fds.indexOf(result.status ?? -1)
  if (result.error || held < 0) {
    for (const descriptor of descriptors) closeSync(descriptor)
    process.stderr.write('[babysitter] Shared heavy-command lock could not be acquired.\n')
    process.exit(1)
  }
  descriptors.forEach((descriptor, index) => { if (index !== held) closeSync(descriptor) })
  process.env.BABYSITTER_HEAVY_SLOT = files[held]
  // Children inherit the lease marker; process exit releases the kernel lock automatically.
  process.on('exit', () => closeSync(descriptors[held]))
}
