import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'
import { hostname, cpus } from 'node:os'
import { createFleet } from '../server/fleet/fleet.ts'

await mkdir(resolve('.data/bench-fleet-admission'), { recursive: true })
const root = await mkdtemp(resolve('.data/bench-fleet-admission/fixture-'))
const trials = Number(process.env.TRIALS ?? 7)
const slowMs = Number(process.env.PROBE_DELAY_MS ?? 250)
const healthy = { availableMemoryBytes: 8 * 1024 ** 3, memoryPressure: 0 }
const fixture = ['/fixture', '10000000', String(8 * 1024 * 1024), '0', 'tools-ok'].join('\n') + '\n'
const results: { label: string, ms: number, result: unknown }[] = []

function makeFleet(localSlots: number) {
  let clock = 0
  const fleet = createFleet({
    localSlots,
    hosts: [{ name: 'slow', target: 'fixture', slots: 2 }, { name: 'fast', target: 'fixture', slots: 2 }],
    stateDirectory: join(root, 'state'),
    transport: host => ({ start: () => spawn(process.execPath, ['-e', `setTimeout(() => process.stdout.write(${JSON.stringify(fixture)}), ${host.name === 'slow' ? slowMs : 0})`], { stdio: 'pipe' }) }),
    localResources: () => healthy,
    log: () => {},
    now: () => clock,
  })
  return { fleet, expire: () => { clock += 30_001 } }
}

async function measure(label: string, run: () => Promise<unknown>) {
  const start = performance.now()
  const result = await run()
  results.push({ label, ms: performance.now() - start, result })
}

async function localAdmission(fleet: ReturnType<typeof createFleet>) {
  const admitted = (await fleet.admission()).local.admitted
  assert.equal(admitted, 2)
  return admitted
}

try {
  for (let trial = 0; trial < trials; trial++) {
    const { fleet, expire } = makeFleet(2)
    await measure('cold-local-admission', () => localAdmission(fleet))
    await fleet.refresh()
    await measure('warm-local-admission', () => localAdmission(fleet))
    expire()
    await measure('expired-local-admission', () => localAdmission(fleet))
    await fleet.refresh()
    const remote = makeFleet(0)
    await measure('cold-remote-admission', async () => (await remote.fleet.admission()).hosts.filter(host => host.admitted > 0).map(host => host.name))
    await remote.fleet.refresh()
    remote.expire()
    await measure('expired-remote-placement', async () => {
      const placement = await remote.fleet.place({ repository: 'fixture/r', number: trial })
      placement.release()
      return placement.host
    })
    await remote.fleet.refresh()
  }
  console.log(JSON.stringify({
    machine: hostname(),
    cpu: cpus()[0]?.model,
    node: process.version,
    fixture: 'two hosts, 2 slots each, local resources fixed to 8 GiB / 0 pressure; child processes return synthetic probe output; slow host delays every transport call',
    slowMs,
    trials,
    cache: 'cold fleet per trial; warm probe health fresh; expired uses clock +30001ms; OS cache warm, no network/model/install',
    results,
  }, null, 2))
}
finally { await rm(root, { recursive: true, force: true }) }
