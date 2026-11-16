import assert from 'node:assert/strict'
import test from 'node:test'
import type { SandboxRuntime } from 'vite-hub/sandbox'
import { createPlacementPolicy, parseRemoteHosts, readProbe, type HostHealth, type PlacementPolicyOptions, type RemoteHost } from '../server/agents/babysitter/placement/index.ts'

const GiB = 1024 ** 3
const runtime = { name: 'fixture', prepare: async () => { throw new Error('unused') }, open: async () => { throw new Error('unused') } } as unknown as SandboxRuntime

function policy(overrides: Partial<PlacementPolicyOptions> & { local?: number, health?: (host: RemoteHost, active: number) => HostHealth } = {}) {
  const probes: string[] = []
  const failures: Array<(error: unknown) => void> = []
  let now = 0
  const placement = createPlacementPolicy({
    hosts: [{ target: 'svc@remote', slots: 2 }],
    localSlots: () => overrides.local ?? 1,
    probe: async (host, active) => {
      probes.push(host.target)
      return overrides.health?.(host, active) ?? { ok: true, checkedAt: now, home: '/home/svc', admitted: active + 4 }
    },
    runtime: (_host, _health, hooks) => { failures.push(hooks.onOpenFailure); return { runtime } },
    now: () => now,
    ...overrides,
  })
  return { placement, probes, failures, advance: (ms: number) => { now += ms } }
}

test('passes fill this host first, then the remote host up to its slots', async () => {
  const { placement, probes } = policy()
  const first = await placement.place({ repository: 'o/r', number: 1 })
  assert.equal(first.sandbox, undefined)
  assert.deepEqual(probes, [])
  const second = await placement.place({ repository: 'o/r', number: 2 })
  const third = await placement.place({ repository: 'o/r', number: 3 })
  assert.equal(second.sandbox?.runtime, runtime)
  assert.equal(third.sandbox?.runtime, runtime)
  assert.deepEqual(probes, ['svc@remote', 'svc@remote'])
  assert.equal(placement.remoteActive?.(), 2)
  assert.deepEqual(placement.status().hosts[0]!.active, 2)
  await assert.rejects(placement.place({ repository: 'o/r', number: 4 }), { name: 'BabysitterPlacementCapacityError' })
})

test('a full host turns the pass away with a capacity error that names the reason', async () => {
  const { placement } = policy({ local: 0, health: (_host, active) => ({ ok: true, checkedAt: 0, home: '/h', admitted: active }) })
  await assert.rejects(placement.place({ repository: 'o/r', number: 1 }), (error: Error) => {
    assert.equal(error.name, 'BabysitterPlacementCapacityError')
    assert.match(String((error as { why?: string }).why ?? error.message), /full \(0\/0\)/)
    return true
  })
})

test('a probe that refuses the host keeps the pass off it', async () => {
  const { placement } = policy({ local: 0, health: () => ({ ok: false, checkedAt: 0, reason: 'only 900 MiB disk free' }) })
  await assert.rejects(placement.place({ repository: 'o/r', number: 1 }), (error: Error) => {
    assert.match(String((error as { why?: string }).why ?? error.message), /900 MiB disk free/)
    return true
  })
  assert.equal(placement.remoteActive?.(), 0)
})

test('a probe that throws counts as a refusal', async () => {
  const { placement } = policy({ local: 0, probe: async () => { throw new Error('ssh: connect to host remote port 22: Connection refused') } })
  await assert.rejects(placement.place({ repository: 'o/r', number: 1 }), { name: 'BabysitterPlacementCapacityError' })
  assert.equal(placement.status().hosts[0]!.healthy, false)
})

test('release frees the slot once, whether the pass succeeded, failed or was cancelled', async () => {
  const { placement } = policy({ local: 0 })
  const leases = await Promise.all([1, 2].map(number => placement.place({ repository: 'o/r', number })))
  assert.equal(placement.remoteActive?.(), 2)
  // The preset calls release from a finally block on success, failure and abort alike; a second call is harmless.
  leases[0]!.release()
  leases[0]!.release()
  assert.equal(placement.remoteActive?.(), 1)
  const again = await placement.place({ repository: 'o/r', number: 3 })
  assert.ok(again.sandbox)
  leases[1]!.release()
  again.release()
  assert.equal(placement.remoteActive?.(), 0)
})

test('local release frees a local slot', async () => {
  const { placement, probes } = policy({ local: 1 })
  const first = await placement.place({ repository: 'o/r', number: 1 })
  first.release()
  const second = await placement.place({ repository: 'o/r', number: 2 })
  assert.equal(second.sandbox, undefined)
  assert.deepEqual(probes, [])
})

test('concurrent placements never exceed the slots that memory admits', async () => {
  // The host admits one more pass than it runs; four concurrent passes must not all take it.
  const { placement } = policy({ local: 0, health: (_host, active) => ({ ok: true, checkedAt: 0, home: '/h', admitted: active + 1 }) })
  const results = await Promise.allSettled([1, 2, 3, 4].map(number => placement.place({ repository: 'o/r', number })))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(placement.remoteActive?.(), 1)
})

test('a Sandbox that fails to open keeps new passes off the host for the cooldown', async () => {
  const { placement, failures, advance } = policy({ local: 0, failureCooldownMs: 60_000 })
  const lease = await placement.place({ repository: 'o/r', number: 1 })
  failures[0]!(new Error('git object transfer failed'))
  lease.release()
  await assert.rejects(placement.place({ repository: 'o/r', number: 2 }), { name: 'BabysitterPlacementCapacityError' })
  advance(60_000)
  assert.ok((await placement.place({ repository: 'o/r', number: 3 })).sandbox)
})

test('admitted counts local and remote slots and reuses a fresh probe', async () => {
  const { placement, probes, advance } = policy({ local: 3, health: (_host, active) => ({ ok: true, checkedAt: 0, home: '/h', admitted: active + 1 }) })
  assert.equal(await placement.admitted?.(), 3 + 1)
  assert.equal(await placement.admitted?.(), 4)
  assert.equal(probes.length, 1)
  advance(30_000)
  await placement.admitted?.()
  assert.equal(probes.length, 2)
})

test('admitted never drops below the passes that run', async () => {
  let refuse = false
  const { placement, advance } = policy({ local: 0, health: (_host, active) => refuse ? { ok: false, checkedAt: 30_000, reason: 'down' } : { ok: true, checkedAt: 0, home: '/h', admitted: active + 2 } })
  await placement.place({ repository: 'o/r', number: 1 })
  await placement.place({ repository: 'o/r', number: 2 })
  refuse = true
  advance(30_000)
  assert.equal(await placement.admitted?.(), 2)
})

test('the probe admits by memory headroom and refuses low disk, high pressure and missing tools', () => {
  const limits = { minFreeBytes: 4 * GiB, reserveBytes: 2 * GiB, perPassBytes: 2.5 * GiB, maxMemoryPressure: 10 }
  const sample = (free: number, memory: number, pressure: number, tools = 'tools-ok') => `/home/svc\n${free}\n${memory}\n${pressure}\n${tools}\n`
  assert.deepEqual(readProbe(sample(100 * GiB, 9.5 * GiB, 1.2), 0, '', 1, limits, 5), { ok: true, checkedAt: 5, home: '/home/svc', admitted: 1 + 3 })
  assert.equal(readProbe(sample(100 * GiB, 3 * GiB, 0), 0, '', 0, limits, 5).admitted, 0)
  assert.match(readProbe(sample(3 * GiB, 9 * GiB, 0), 0, '', 0, limits, 5).reason!, /disk free/)
  assert.match(readProbe(sample(100 * GiB, 9 * GiB, 12.5), 0, '', 0, limits, 5).reason!, /pressure 12\.5%/)
  assert.match(readProbe(sample(100 * GiB, 9 * GiB, 0, 'tools-missing'), 0, '', 0, limits, 5).reason!, /missing git, codex/)
  assert.deepEqual(readProbe('', 255, 'ssh: Could not resolve hostname', 0, limits, 5), { ok: false, checkedAt: 5, reason: 'ssh: Could not resolve hostname' })
})

test('remote hosts parse from user@host:slots', () => {
  assert.deepEqual(parseRemoteHosts(undefined), [])
  assert.deepEqual(parseRemoteHosts('svc-fleet@servarica:2, box:1 other@b:0'), [{ target: 'svc-fleet@servarica', slots: 2 }, { target: 'box', slots: 1 }])
  assert.throws(() => parseRemoteHosts('servarica'), /user@host:slots/)
})

test('concurrent placements take one local slot once', async () => {
  // The sample resolves later than the call, as a real memory sample does.
  const { placement } = policy({ localSlots: async () => { await new Promise(resolve => setTimeout(resolve, 10)); return 1 } })
  const leases = await Promise.all([1, 2, 3, 4].map(number => placement.place({ repository: 'o/r', number }).catch((error: Error) => error)))
  assert.equal(leases.filter(lease => !(lease instanceof Error) && !lease.sandbox).length, 1)
  assert.equal(placement.status().local, 1)
  assert.equal(placement.remoteActive?.(), 2)
})

test('releasing a remote lease also releases what its runtime holds', async () => {
  let revoked = 0
  const { placement } = policy({ local: 0, runtime: () => ({ runtime, release: () => { revoked++ } }) })
  const lease = await placement.place({ repository: 'o/r', number: 1 })
  lease.release()
  lease.release()
  assert.equal(revoked, 1)
})
