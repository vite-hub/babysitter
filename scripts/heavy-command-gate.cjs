'use strict'
// Preloaded into Babysitter worker commands through NODE_OPTIONS. Typecheck,
// test, and build processes each use 1-2 GB, and several workers running them
// at once thrash this host. Such a process waits here for one of a few
// host-wide slots. Its child processes inherit the slot.
const { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } = require('node:fs')

const script = (process.argv[1] || '').replace(/\\/g, '/')
const heavy = /\/typescript\/bin\/tsc$|\/vitest\/vitest\.mjs$|\/vite-plus\/dist\/pack-bin\.js$|\/vite-plus\/bin\/vp$/.test(script)

if (heavy && !process.env.BABYSITTER_HEAVY_SLOT) {
  const directory = process.env.BABYSITTER_HEAVY_DIR || '/tmp/babysitter-heavy-slots'
  const slots = Math.max(1, Number(process.env.BABYSITTER_HEAVY_SLOTS) || 2)
  mkdirSync(directory, { recursive: true, mode: 0o1777 })
  const alive = (pid) => {
    try { process.kill(pid, 0); return true }
    catch (error) { return error.code === 'EPERM' }
  }
  const stale = (file) => {
    try {
      const owner = Number(readFileSync(file, 'utf8'))
      // A slot file is written right after creation; give a new one a moment.
      if (!owner) return Date.now() - statSync(file).mtimeMs > 5_000
      return !alive(owner)
    } catch { return false }
  }
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  let held
  let announced = false
  while (!held) {
    for (let index = 0; index < slots && !held; index++) {
      const file = `${directory}/slot-${index}`
      try {
        const descriptor = openSync(file, 'wx', 0o666)
        writeSync(descriptor, String(process.pid))
        closeSync(descriptor)
        held = file
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        if (stale(file)) { try { unlinkSync(file) } catch {} }
      }
    }
    if (held) break
    if (!announced) {
      process.stderr.write(`[babysitter] Waiting for one of ${slots} shared typecheck/test slots; other workers are using them.\n`)
      announced = true
    }
    Atomics.wait(sleeper, 0, 0, 1_000)
  }
  process.env.BABYSITTER_HEAVY_SLOT = held
  process.on('exit', () => {
    try { if (readFileSync(held, 'utf8') === String(process.pid)) unlinkSync(held) } catch {}
  })
}
