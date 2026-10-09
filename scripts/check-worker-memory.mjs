import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveBox } from 'vite-hub/box'

const MiB = 1024 ** 2
const missing = await resolveBox({ runtime: {
  kind: 'trusted-host',
  resources: { cgroupParent: '/missing-vitehub-cgroup', memoryMaxBytes: 96 * MiB, memorySwapMaxBytes: 0 },
} }, {})
await assert.rejects(async () => { const unexpected = await missing.open(); await unexpected.close() }, /cgroup|memory controller/)
console.log('Configured limits fail closed without delegation.')

if (process.env.VITEHUB_TEST_ADMISSION === '1') {
  const { createProcessAgentCapacity } = await import('vite-hub/agent/runtime/process')
  const sample = createProcessAgentCapacity({
    concurrency: 1,
    fallbackConcurrency: 0,
    // This proof isolates memory arithmetic from unrelated host CPU/PSI load.
    cpu: { pausePressure: 1, resumePressure: 1 },
    memory: { perInvocationBytes: 4 * 1024 ** 3, reserveBytes: 4 * 1024 ** 3, serviceReserveBytes: 1024 ** 3, pausePressure: 1, resumePressure: 1 },
  }).adaptive.sample
  const result = await sample({ active: 0, concurrency: 1, pending: 1, signal: new AbortController().signal })
  assert.equal(result.concurrency, 1, result.reason)
  console.log('The first 4 GiB worker can be admitted under the staged service budget.')
}

if (process.env.VITEHUB_TEST_DELEGATED_MEMORY === '1') {
  const membership = (await readFile('/proc/self/cgroup', 'utf8')).split('\n').find(line => line.startsWith('0::')).slice(3)
  const parent = dirname(join('/sys/fs/cgroup', membership))
  const before = await readdir(parent)
  const box = await resolveBox({ runtime: {
    kind: 'trusted-host',
    resources: { cgroupParent: parent, memoryMaxBytes: 96 * MiB, memorySwapMaxBytes: 0 },
  } }, {})
  const worker = await box.open()
  const sibling = await box.open()
  try {
    const alive = await sibling.spawn('sleep', ['30'])
    await sibling.exec(process.execPath, ['-e', "const fs=require('node:fs'); const member=fs.readFileSync('/proc/self/cgroup','utf8').trim().slice(3); fs.mkdirSync('/sys/fs/cgroup'+member+'/nested/leaf', {recursive:true})"])
    const held = await worker.spawn(process.execPath, ['-e', "const b=Buffer.alloc(48*1024**2, 1); process.stdout.write('ready'); setInterval(()=>b[0], 100)"])
    const reader = held.stdout.getReader()
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'ready')
    reader.releaseLock()
    await assert.rejects(worker.exec(process.execPath, ['-e', 'const b=Buffer.alloc(48*1024**2, 1); setTimeout(()=>process.exit(b[0]-1), 150)']), /memory limit exceeded.*peak=/)
    await assert.rejects(held.wait(), /memory limit exceeded/)
    await assert.rejects(worker.exec('true'), /memory limit exceeded/)
    assert.equal((await sibling.exec('kill', ['-0', String(alive.pid)])).code, 0)
    console.log('Worker OOM was contained; sibling and controller survived.')
  } finally {
    await worker.close()
    await sibling.close()
  }
  assert.deepEqual((await readdir(parent)).sort(), before.sort())
  console.log('Worker cgroups were removed.')
}
