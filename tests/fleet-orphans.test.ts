import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { killByHome } from '../server/fleet/ssh-box.ts'

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const detached = (home: string) => {
  // setsid puts the child in its own session, like a tool command Codex starts inside a Box.
  const child = spawn('setsid', ['sleep', '60'], { env: { ...process.env, HOME: home }, stdio: 'ignore' })
  return child
}

test('closing a Box kills processes that left its process group, and only those', { skip: process.platform !== 'linux' }, async () => {
  const root = `/tmp/fleet-orphans-${process.pid}/boxes`
  const orphan = detached(`${root}/box-a/home`)
  const neighbour = detached(`${root}/box-b/home`)
  const unrelated = detached('/tmp/not-a-box')
  await new Promise(resolve => setTimeout(resolve, 200))
  try {
    execFileSync('sh', ['-c', killByHome(`${root}/box-a/home`)])
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(alive(orphan.pid!), false)
    assert.equal(alive(neighbour.pid!), true)
    assert.equal(alive(unrelated.pid!), true)
    // The startup sweep removes every Box under the root.
    execFileSync('sh', ['-c', killByHome(`${root}/`)])
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(alive(neighbour.pid!), false)
    assert.equal(alive(unrelated.pid!), true)
  }
  finally {
    for (const child of [orphan, neighbour, unrelated]) child.kill('SIGKILL')
  }
})
