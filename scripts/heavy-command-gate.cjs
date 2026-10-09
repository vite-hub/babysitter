'use strict'
// Loaded by the worker Node wrapper. Finite checks share the host verification
// slot while model workers keep running in parallel.
const { closeSync, openSync, realpathSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

let script = process.argv[1] || ''
try { script = realpathSync(script) } catch {}
script = script.replace(/\\/g, '/')

if (/\/(?:nuxt\/bin\/nuxt|nuxi\/bin\/nuxi)\.mjs$/.test(script) && /^(?:build|generate)$/.test(process.argv[2] || '')) {
  process.stderr.write('[babysitter] Local Nuxt builds are disabled for workers. Rely on CI for build validation.\n')
  process.exit(1)
}
const heavy = /\/typescript\/bin\/tsc$|\/vitest\/vitest\.mjs$|\/vite-plus\/dist\/pack-bin\.js$|\/vite-plus\/bin\/vp$/.test(script)

if (heavy && !process.env.BABYSITTER_HEAVY_SLOT && !process.env.FLEET_QUEUE_ACTIVE) {
  // Provider sandboxes have private /tmp and PID namespaces. Open a persistent
  // host lock read-only; flock follows the shared inode across those namespaces.
  const lock = process.env.BABYSITTER_HEAVY_LOCK || join(__dirname, 'heavy-command.lock')
  let descriptor
  try { descriptor = openSync(lock, 'r') }
  catch {
    process.stderr.write('[babysitter] Shared verification lock is unavailable. Install the host lock before running worker checks.\n')
    process.exit(1)
  }
  process.stderr.write('[babysitter] Waiting for the shared host verification slot.\n')
  const result = spawnSync('flock', ['--exclusive', '3'], {
    stdio: ['inherit', 'inherit', 'inherit', descriptor],
  })
  if (result.error || result.status !== 0) {
    closeSync(descriptor)
    process.stderr.write('[babysitter] Shared verification lock could not be acquired.\n')
    process.exit(1)
  }
  process.env.BABYSITTER_HEAVY_SLOT = lock
  // The parent keeps this open-file description after flock exits. Children
  // inherit the lease marker; process exit releases the kernel lock automatically.
  process.on('exit', () => closeSync(descriptor))
}
