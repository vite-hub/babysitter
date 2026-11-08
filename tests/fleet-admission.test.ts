import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { createFleet, FleetCapacityError } from '../server/fleet/fleet.ts'

const resources = { availableMemoryBytes: 8 * 1024 ** 3, memoryPressure: 0 }

function fixture() {
  const directory = resolve('.data/fleet-admission-tests')
  mkdirSync(directory, { recursive: true })
  const root = mkdtempSync(join(directory, 'fleet-'))
  const output = JSON.stringify('/fixture\n10000000\n8388608\n0\ntools-ok\n')
  return {
    stateDirectory: root,
    transport: () => ({ start: () => spawn(process.execPath, ['-e', `process.stdout.write(${output})`], { stdio: 'pipe' }) }),
    log: () => {},
  }
}

async function beforeProbeCompletes<T>(operation: Promise<T>, ready: Promise<unknown>) {
  return Promise.race([
    operation.then(value => ({ kind: 'completed', value }) as const),
    ready.then(() => setImmediate()).then(() => ({ kind: 'blocked' }) as const),
  ])
}

test('admission uses fresh local capacity while remote health is pending', async () => {
  const options = fixture()
  const probed = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let availableMemoryBytes = resources.availableMemoryBytes
  let samples = 0
  const fleet = createFleet({
    ...options,
    localSlots: 2,
    hosts: [{ name: 'remote', target: 'fixture', slots: 2 }],
    localResources: () => ({ ...resources, availableMemoryBytes }),
    hostResources: async () => {
      samples++
      probed.resolve()
      await release.promise
      return resources
    },
  })
  const admission = fleet.admission()
  try {
    const result = await beforeProbeCompletes(admission, probed.promise)
    assert.ok(result.kind === 'completed', 'local work waits for a remote probe')
    assert.equal(result.value.local.admitted, 2)
    assert.equal(result.value.hosts[0]!.admitted, 0)
    assert.equal(result.value.hosts[0]!.healthy, null)
    const first = await fleet.place({ repository: 'o/r', number: 1 })
    const second = await fleet.place({ repository: 'o/r', number: 2 })
    assert.equal(first.host, 'local')
    assert.equal(second.host, 'local')
    first.release()
    second.release()
    availableMemoryBytes = 2 * 1024 ** 3
    const constrained = fleet.admission()
    release.resolve()
    const current = await constrained
    assert.equal(current.local.admitted, 0)
    assert.equal(current.hosts[0]!.admitted, 2)
    assert.equal(samples, 1)
  }
  finally {
    release.resolve()
    await admission
    await fleet.refresh()
    rmSync(options.stateDirectory, { recursive: true, force: true })
  }
})

test('admission uses a responsive remote without waiting for another host', async () => {
  const options = fixture()
  const blocked = Promise.withResolvers<void>()
  const fastUp = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const samples = new Map<string, number>()
  const fleet = createFleet({
    ...options,
    localSlots: 0,
    hosts: [{ name: 'slow', target: 'fixture', slots: 2 }, { name: 'fast', target: 'fixture', slots: 2 }],
    localResources: () => resources,
    hostResources: async (host) => {
      samples.set(host.name, (samples.get(host.name) ?? 0) + 1)
      if (host.name === 'slow') {
        blocked.resolve()
        await release.promise
      }
      return resources
    },
    log: (event, fields) => { if (event === 'host.up' && fields.host === 'fast') fastUp.resolve() },
  })
  const admission = fleet.admission()
  try {
    const result = await beforeProbeCompletes(admission, Promise.all([blocked.promise, fastUp.promise]))
    assert.ok(result.kind === 'completed', 'a healthy remote waits for another host')
    assert.equal(result.value.hosts[0]!.admitted, 0)
    assert.equal(result.value.hosts[1]!.admitted, 2)
    assert.equal((await fleet.admission()).hosts[1]!.admitted, 2)
    release.resolve()
    await fleet.refresh()
    assert.equal(fleet.status().hosts[0]!.admitted, 2)
    assert.deepEqual([...samples].sort(), [['fast', 1], ['slow', 1]])
  }
  finally {
    release.resolve()
    await admission
    await fleet.refresh()
    rmSync(options.stateDirectory, { recursive: true, force: true })
  }
})

test('placement bypasses a pending probe and keeps fair slot reservations', async () => {
  const options = fixture()
  const blocked = Promise.withResolvers<void>()
  const fastUp = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const fleet = createFleet({
    ...options,
    localSlots: 0,
    hosts: [{ name: 'slow', target: 'fixture', slots: 2 }, { name: 'fast', target: 'fixture', slots: 2 }],
    localResources: () => resources,
    hostResources: async (host) => {
      if (host.name === 'slow') {
        blocked.resolve()
        await release.promise
      }
      return resources
    },
    log: (event, fields) => { if (event === 'host.up' && fields.host === 'fast') fastUp.resolve() },
  })
  const placement = fleet.place({ repository: 'o/r', number: 1 })
  const placed: Awaited<typeof placement>[] = []
  try {
    // On a sequential implementation, the fast probe never starts.
    const fastProbe = fleet.refresh()
    const result = await beforeProbeCompletes(placement, Promise.all([blocked.promise, fastUp.promise]))
    assert.ok(result.kind === 'completed', 'placement waits for the first host in configuration order')
    placed.push(result.value)
    assert.equal(result.value.host, 'fast')
    release.resolve()
    await fastProbe
    placed.push(await fleet.place({ repository: 'o/r', number: 2 }))
    assert.equal(placed[1]!.host, 'slow')
    const concurrent = await Promise.allSettled(Array.from({ length: 6 }, (_, number) => fleet.place({ repository: 'o/r', number: number + 3 })))
    for (const result of concurrent) {
      if (result.status === 'fulfilled') placed.push(result.value)
      else assert.ok(result.reason instanceof FleetCapacityError)
    }
    assert.equal(placed.length, 4)
    assert.deepEqual(fleet.status().hosts.map(host => host.active), [2, 2])
    for (const pass of placed) { pass.release(); pass.release() }
    assert.deepEqual(fleet.status().hosts.map(host => host.active), [0, 0])
  }
  finally {
    release.resolve()
    const first = await placement
    first.release()
    for (const pass of placed) pass.release()
    await fleet.refresh()
    rmSync(options.stateDirectory, { recursive: true, force: true })
  }
})

test('expired health admits only active reservations until a fresh probe recovers', async () => {
  const options = fixture()
  const release = Promise.withResolvers<void>()
  let clock = 0
  let pressure = 0
  const fleet = createFleet({
    ...options,
    localSlots: 0,
    hosts: [{ name: 'remote', target: 'fixture', slots: 2 }],
    localResources: () => resources,
    hostResources: async () => {
      if (clock > 0) await release.promise
      return { ...resources, memoryPressure: pressure }
    },
    now: () => clock,
  })
  let placement: Awaited<ReturnType<typeof fleet.place>> | undefined
  try {
    await fleet.refresh()
    placement = await fleet.place({ repository: 'o/r', number: 1 })
    clock = 30_001
    assert.equal(fleet.status().hosts[0]!.admitted, 1, 'expired health admits unreserved capacity')
    pressure = 6
    const admission = fleet.admission()
    release.resolve()
    assert.equal((await admission).hosts[0]!.admitted, 1)
    await assert.rejects(fleet.place({ repository: 'o/r', number: 2 }), FleetCapacityError)
    placement.release()
    placement.release()
    assert.equal(fleet.status().hosts[0]!.admitted, 0)
    clock += 30_001
    pressure = 0
    assert.equal((await fleet.admission()).hosts[0]!.admitted, 2)
    placement = await fleet.place({ repository: 'o/r', number: 3 })
    assert.equal(placement.host, 'remote')
  }
  finally {
    release.resolve()
    placement?.release()
    await fleet.refresh()
    rmSync(options.stateDirectory, { recursive: true, force: true })
  }
})

test('local memory pressure retains active reservations without admitting local overflow', async () => {
  const options = fixture()
  let pressure = 0
  const fleet = createFleet({
    ...options,
    localSlots: 2,
    hosts: [{ name: 'remote', target: 'fixture', slots: 2 }],
    localResources: () => ({ ...resources, memoryPressure: pressure }),
  })
  const placements: Awaited<ReturnType<typeof fleet.place>>[] = []
  try {
    await fleet.refresh()
    placements.push(await fleet.place({ repository: 'o/r', number: 1 }))
    pressure = 6
    const admission = await fleet.admission()
    assert.equal(admission.local.admitted, 1, 'an active local reservation reduces unrelated remote capacity')
    assert.equal(admission.local.healthy, false)
    assert.equal(admission.hosts[0]!.admitted, 2)
    placements.push(await fleet.place({ repository: 'o/r', number: 2 }))
    placements.push(await fleet.place({ repository: 'o/r', number: 3 }))
    assert.deepEqual(placements.map(placement => placement.host), ['local', 'remote', 'remote'])
    await assert.rejects(fleet.place({ repository: 'o/r', number: 4 }), FleetCapacityError)
    assert.equal(fleet.status().local.overflow, 0)
  }
  finally {
    for (const placement of placements) placement.release()
    await fleet.refresh()
    rmSync(options.stateDirectory, { recursive: true, force: true })
  }
})
