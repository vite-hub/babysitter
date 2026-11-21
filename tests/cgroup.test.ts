import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startPassCgroup } from '../server/agents/babysitter/cgroup.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cgroup-'))
  const unit = join(root, 'system.slice/app.service')
  await mkdir(join(unit, 'main'), { recursive: true })
  await writeFile(join(unit, 'main/cgroup.procs'), '10\n11\n12\n')
  const self = join(root, 'self-cgroup')
  await writeFile(self, '0::/system.slice/app.service/main\n')
  return { root, unit, self }
}

test('moves every process but the main one into the sibling cgroup and protects the main leaf', async () => {
  const { root, unit, self } = await fixture()
  const cgroup = await startPassCgroup({ name: 'passes', mainMemoryLow: '6G', pid: 10, cgroupRoot: root, selfCgroup: self, log: () => {} })
  try {
    assert.equal(cgroup.passes, join(unit, 'passes'))
    assert.deepEqual(await cgroup.sweep(), [11, 12])
    assert.equal(await readFile(join(unit, 'passes/cgroup.procs'), 'utf8'), '11\n12\n')
    assert.equal(await readFile(join(unit, 'main/memory.low'), 'utf8'), '6G')
  }
  finally {
    cgroup.stop()
  }
})

test('refuses a sibling with the main leaf\'s own name', async () => {
  const { root, self } = await fixture()
  await assert.rejects(startPassCgroup({ name: 'main', cgroupRoot: root, selfCgroup: self, log: () => {} }), /already runs in/)
})
