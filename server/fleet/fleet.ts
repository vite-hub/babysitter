// Places Babysitter repair passes on this machine or on fleet hosts reached over
// (Tailscale) SSH. The coordinator keeps the queue, the claims and the GitHub
// credentials; a fleet host only runs the provider in a remote Box.
import { readFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createSshBoxRuntime, q, runScript, sshTransport, type FleetTransport } from './ssh-box.ts'

export interface FleetHostConfig {
  /** Label used in logs and status. */
  name: string
  /** SSH destination, for example `svc-fleet@servarica`. */
  target: string
  slots: number
}

export interface FleetOptions {
  localSlots: number
  hosts: readonly FleetHostConfig[]
  /** Directory for SSH known hosts. */
  stateDirectory: string
  /** Short directory for SSH control sockets. */
  controlDirectory?: string
  /** Coordinator loopback ports forwarded to every remote provider process. */
  forwardPorts?: readonly number[]
  /** Hosts with less free disk are not used. */
  minFreeBytes?: number
  /** Keep this much memory free on every host before admitting another Box. */
  minFreeMemoryBytes?: number
  /** Do not admit work while memory pressure exceeds this percentage. */
  maxMemoryPressure?: number
  /** Memory budget reserved for one additional provider pass. */
  memoryPerSlotBytes?: number
  /** Override local resource sampling in tests or host-specific deployments. */
  localResources?: () => FleetResourceHealth | Promise<FleetResourceHealth>
  /** Override remote memory sampling while retaining the SSH disk/tool probe. */
  hostResources?: (host: FleetHostConfig) => FleetResourceHealth | Promise<FleetResourceHealth>
  codexConfig?: (workDirectory: string) => string
  transport?: (host: FleetHostConfig) => FleetTransport
  log?: (event: string, fields: Record<string, unknown>) => void
  now?: () => number
}

export interface FleetPlacement {
  readonly host: string
  /** Box definition for a remote pass; absent when the pass runs locally. */
  readonly box?: { runtime: ReturnType<typeof createSshBoxRuntime> }
  release(): void
}

interface HostHealth {
  ok: boolean
  checkedAt: number
  reason?: string
  home?: string
  freeBytes?: number
  availableMemoryBytes?: number
  memoryPressure?: number
}

export interface FleetResourceHealth {
  availableMemoryBytes: number
  memoryPressure: number
}

/** A claim must be retried later when all fleet slots are unavailable. */
export class FleetCapacityError extends Error {
  readonly code = 'fleet_capacity'
  readonly retryable = true

  constructor(reason: string) {
    super(`[fleet] No admitted fleet slot is available: ${reason}`)
    this.name = 'FleetCapacityError'
  }
}

const healthTtlMs = 30_000

export function createFleet(options: FleetOptions) {
  const now = options.now ?? Date.now
  const log = options.log ?? ((event, fields) => console.log(`[fleet] ${event} ${JSON.stringify(fields)}`))
  const minFreeBytes = options.minFreeBytes ?? 4 * 1024 ** 3
  const minFreeMemoryBytes = options.minFreeMemoryBytes ?? 2 * 1024 ** 3
  const maxMemoryPressure = options.maxMemoryPressure ?? 5
  const memoryPerSlotBytes = options.memoryPerSlotBytes ?? 512 * 1024 ** 2
  let localActive = 0
  let overflow = 0
  let localHealth: (FleetResourceHealth & { ok: boolean, reason?: string }) | undefined
  const hosts = options.hosts.map(config => ({
    config,
    active: 0,
    placed: 0,
    transport: options.transport?.(config) ?? sshTransport({
      target: config.target,
      // Unix sockets allow about 108 bytes and TMPDIR can be deep; ssh appends a random suffix.
      controlDir: ensureDirectory(options.controlDirectory ?? `/tmp/vhf-${process.getuid?.() ?? 0}`),
      knownHosts: join(ensureDirectory(options.stateDirectory), 'known_hosts'),
    }),
    health: undefined as HostHealth | undefined,
    probing: undefined as Promise<HostHealth> | undefined,
    swept: false,
  }))
  type Host = (typeof hosts)[number]

  async function probe(host: Host): Promise<HostHealth> {
    const checkedAt = now()
    try {
      const result = await runScript(host.transport, `printf '%s\\n' "$HOME"; df -Pk "$HOME" | awk 'NR==2 {print $4}'; awk '/^MemAvailable:/ {print $2}' /proc/meminfo; awk '$1 == "full" { for (i = 2; i <= NF; i++) if ($i ~ /^avg10=/) { sub(/^avg10=/, "", $i); print $i; exit } }' /proc/pressure/memory; PATH="$HOME/.local/bin:$PATH" command -v git codex pnpm setsid flock tar >/dev/null && echo tools-ok`, { timeout: 20_000 })
      const [home, freeKb, memoryKb, pressureText, tools] = result.stdout.toString('utf8').trim().split('\n')
      if (result.code !== 0 || !home?.startsWith('/')) return { ok: false, checkedAt, reason: result.stderr.trim().slice(-300) || `exit ${result.code}` }
      const freeBytes = Number(freeKb) * 1024
      const sampledMemory = { availableMemoryBytes: Number(memoryKb) * 1024, memoryPressure: Number(pressureText) }
      const override = await options.hostResources?.(host.config)
      const availableMemoryBytes = override?.availableMemoryBytes ?? sampledMemory.availableMemoryBytes
      const memoryPressure = override?.memoryPressure ?? sampledMemory.memoryPressure
      if (tools !== 'tools-ok') return { ok: false, checkedAt, home, freeBytes, reason: 'missing git, codex, pnpm, setsid, flock or tar' }
      if (!host.swept) {
        // Boxes left by an earlier coordinator process have no owner. This process
        // is the only coordinator for this root, so stop and remove them.
        const root = `${home}/.vitehub-fleet/boxes`
        await runScript(host.transport, `for f in ${q(root)}/*/run/*.pid; do test -f "$f" && kill -s KILL -- "-$(cat "$f")" 2>/dev/null; done; rm -rf ${q(root)}`, { timeout: 120_000 })
        host.swept = true
        log('host.swept', { host: host.config.name })
      }
      if (!Number.isFinite(freeBytes)) return { ok: false, checkedAt, home, reason: 'disk availability probe unavailable' }
      if (!Number.isFinite(availableMemoryBytes) || !Number.isFinite(memoryPressure)) return { ok: false, checkedAt, home, freeBytes, reason: 'memory availability or pressure probe unavailable' }
      if (freeBytes < minFreeBytes) return { ok: false, checkedAt, home, freeBytes, availableMemoryBytes, memoryPressure, reason: `only ${Math.round(freeBytes / 1024 ** 2)} MiB disk free` }
      if (memoryPressure > maxMemoryPressure) return { ok: false, checkedAt, home, freeBytes, availableMemoryBytes, memoryPressure, reason: `memory pressure ${memoryPressure.toFixed(1)}% exceeds ${maxMemoryPressure}%` }
      if (availableMemoryBytes < minFreeMemoryBytes) return { ok: false, checkedAt, home, freeBytes, availableMemoryBytes, memoryPressure, reason: `only ${Math.round(availableMemoryBytes / 1024 ** 2)} MiB memory available` }
      return { ok: true, checkedAt, home, freeBytes, availableMemoryBytes, memoryPressure }
    }
    catch (error) {
      return { ok: false, checkedAt, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async function localResources() {
    try {
      const resources = await (options.localResources?.() ?? readLocalResources())
      localHealth = { ...resources, ok: true }
      if (!Number.isFinite(resources.availableMemoryBytes) || !Number.isFinite(resources.memoryPressure)) throw new Error('memory availability or pressure probe unavailable')
      if (resources.memoryPressure > maxMemoryPressure) {
        localHealth = { ...resources, ok: false, reason: `memory pressure ${resources.memoryPressure.toFixed(1)}% exceeds ${maxMemoryPressure}%` }
      }
      else if (resources.availableMemoryBytes < minFreeMemoryBytes) {
        localHealth = { ...resources, ok: false, reason: `only ${Math.round(resources.availableMemoryBytes / 1024 ** 2)} MiB memory available` }
      }
      return localHealth
    }
    catch (error) {
      localHealth = { ok: false, availableMemoryBytes: 0, memoryPressure: 100, reason: error instanceof Error ? error.message : String(error) }
      return localHealth
    }
  }

  function admittedSlots(slots: number, active: number, resources: FleetResourceHealth) {
    const byMemory = Math.floor(Math.max(0, resources.availableMemoryBytes - minFreeMemoryBytes) / memoryPerSlotBytes)
    return Math.min(slots, Math.max(active, byMemory))
  }

  async function health(host: Host) {
    if (host.health && now() - host.health.checkedAt < healthTtlMs) return host.health
    host.probing ??= probe(host).then((result) => {
      if (result.ok !== host.health?.ok) log(result.ok ? 'host.up' : 'host.down', { host: host.config.name, reason: result.reason, freeBytes: result.freeBytes })
      host.health = result
      host.probing = undefined
      return result
    })
    return await host.probing
  }

  function once(release: () => void) {
    let released = false
    return () => {
      if (released) return
      released = true
      release()
    }
  }

  function local(fields: Record<string, unknown>, overflowed = false): FleetPlacement {
    localActive++
    if (overflowed) overflow++
    log('placed', { ...fields, host: 'local', overflow: overflowed, localActive })
    return { host: 'local', release: once(() => { localActive-- }) }
  }

  return {
    async place(pass: { repository: string, number: number }): Promise<FleetPlacement> {
      const localState = await localResources()
      const localSlots = localState.ok ? admittedSlots(options.localSlots, localActive, localState) : 0
      if (localActive < localSlots) return local(pass)
      const candidates = hosts
        .filter(host => host.active < host.config.slots)
        .toSorted((left, right) => left.active / left.config.slots - right.active / right.config.slots)
      for (const host of candidates) {
        const state = await health(host)
        // Another pass may have taken the last slot while this one probed.
        if (!state.ok || !state.home || state.availableMemoryBytes === undefined || state.memoryPressure === undefined || host.active >= host.config.slots) continue
        const hostSlots = admittedSlots(host.config.slots, host.active, {
          availableMemoryBytes: state.availableMemoryBytes,
          memoryPressure: state.memoryPressure,
        })
        if (host.active >= hostSlots) continue
        host.active++
        host.placed++
        let closed = false
        const release = once(() => { host.active-- })
        const runtime = createSshBoxRuntime({
          host: host.config.name,
          transport: host.transport,
          root: `${state.home}/.vitehub-fleet`,
          path: `${state.home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
          forwardPorts: options.forwardPorts,
          codexConfig: options.codexConfig,
          onClose: () => { closed = true },
          // Keep new passes off a host whose Boxes fail until the next probe.
          onHostFailure: (error) => {
            host.health = { ok: false, checkedAt: now(), home: state.home, reason: `Box open failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) }
            log('host.down', { host: host.config.name, reason: host.health.reason })
          },
        })
        log('placed', { ...pass, host: host.config.name, active: host.active, slots: host.config.slots })
        return {
          host: host.config.name,
          box: { runtime },
          release: () => {
            if (!closed) log('released.unclosed', { ...pass, host: host.config.name })
            release()
          },
        }
      }
      // Never turn a failed remote probe into an unbounded local workload. The
      // durable PR claim is released by the worker and retried after the next wake.
      throw new FleetCapacityError(localState.reason ?? 'all configured hosts are full or unhealthy')
    },
    status() {
      return {
        local: {
          active: localActive,
          slots: options.localSlots,
          admitted: localHealth?.ok ? admittedSlots(options.localSlots, localActive, localHealth) : 0,
          overflow,
          healthy: localHealth?.ok ?? null,
          availableMemoryBytes: localHealth?.availableMemoryBytes,
          memoryPressure: localHealth?.memoryPressure,
          reason: localHealth?.reason,
        },
        hosts: hosts.map(host => ({
          name: host.config.name,
          active: host.active,
          slots: host.config.slots,
          admitted: host.health?.ok && host.health.availableMemoryBytes !== undefined && host.health.memoryPressure !== undefined
            ? admittedSlots(host.config.slots, host.active, {
              availableMemoryBytes: host.health.availableMemoryBytes,
              memoryPressure: host.health.memoryPressure,
            })
            : 0,
          placed: host.placed,
          healthy: host.health?.ok ?? null,
          reason: host.health?.reason,
          freeBytes: host.health?.freeBytes,
          availableMemoryBytes: host.health?.availableMemoryBytes,
          memoryPressure: host.health?.memoryPressure,
          checkedAt: host.health ? new Date(host.health.checkedAt).toISOString() : null,
        })),
      }
    },
    /** Remote passes hold no local memory; the capacity sampler leaves them out. */
    remoteActive() {
      return hosts.reduce((total, host) => total + host.active, 0)
    },
    /** Probe every host now, for startup logs and status. */
    async refresh() {
      await Promise.all(hosts.map(host => health(host)))
    },
    /** Refresh resource admission before the scheduler claims another batch. */
    async admission() {
      await localResources()
      await Promise.all(hosts.map(host => health(host)))
      return this.status()
    },
  }
}

export type Fleet = ReturnType<typeof createFleet>

function ensureDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  return path
}

function readLocalResources(): FleetResourceHealth {
  const meminfo = readFileSync('/proc/meminfo', 'utf8')
  const availableKb = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1]
  if (!availableKb) throw new Error('MemAvailable probe unavailable')
  const hostAvailableBytes = Number(availableKb) * 1024
  const pressure = parsePressure(readFileSync('/proc/pressure/memory', 'utf8'))
  const cgroup = readLocalCgroupResources()
  return {
    availableMemoryBytes: Math.min(hostAvailableBytes, cgroup.availableBytes),
    memoryPressure: Math.max(pressure, cgroup.pressure),
  }
}

function parsePressure(value: string) {
  const line = value.split('\n').find(candidate => candidate.startsWith('full '))
  const match = line && /(?:^|\s)avg10=([\d.]+)/.exec(line)
  return match ? Number(match[1]) : 0
}

function readLocalCgroupResources(): { availableBytes: number, pressure: number } {
  try {
    const cgroupPath = /^0::(.*)$/m.exec(readFileSync('/proc/self/cgroup', 'utf8'))?.[1]
    if (cgroupPath === undefined) return { availableBytes: Number.POSITIVE_INFINITY, pressure: 0 }
    const root = join('/sys/fs/cgroup', cgroupPath)
    const current = Number(readFileSync(join(root, 'memory.current'), 'utf8').trim())
    const maxText = readFileSync(join(root, 'memory.max'), 'utf8').trim()
    const max = maxText === 'max' ? Number.POSITIVE_INFINITY : Number(maxText)
    const pressure = parsePressure(readFileSync(join(root, 'memory.pressure'), 'utf8'))
    return {
      availableBytes: Number.isFinite(max) ? Math.max(0, max - current) : Number.POSITIVE_INFINITY,
      pressure,
    }
  }
  catch {
    return { availableBytes: Number.POSITIVE_INFINITY, pressure: 0 }
  }
}

/** `name=user@host:slots`, comma or space separated. */
export function parseFleetHosts(value: string | undefined): FleetHostConfig[] {
  return (value ?? '').split(/[,\s]+/).filter(Boolean).map((entry) => {
    const match = /^([\w.-]+)=([^\s:@]+@[^\s:]+|[^\s:]+):(\d+)$/.exec(entry)
    if (!match) throw new Error(`[fleet] Invalid BABYSITTER_FLEET_HOSTS entry "${entry}". Use name=user@host:slots.`)
    return { name: match[1]!, target: match[2]!, slots: Number(match[3]) }
  }).filter(host => host.slots > 0)
}

/**
 * Codex settings for remote Boxes: the host's top-level settings and model providers,
 * with the provider bearer read from CLIPROXY_API_KEY instead of written to disk.
 */
export function remoteCodexConfig(source: string, apiKeyName = 'CLIPROXY_API_KEY') {
  const kept: string[] = []
  let section: string | undefined
  for (const line of source.split('\n')) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line)
    if (header) {
      section = header[1]
      if (section!.startsWith('model_providers.')) kept.push('', line)
      continue
    }
    if (section !== undefined && !section.startsWith('model_providers.')) continue
    if (/^\s*experimental_bearer_token\s*=/.test(line)) {
      kept.push(`env_key = "${apiKeyName}"`)
      continue
    }
    if (line.trim()) kept.push(line)
  }
  const base = kept.join('\n')
  return (workDirectory: string) => `${base}\n\n[projects.${JSON.stringify(workDirectory)}]\ntrust_level = "trusted"\n`
}

const registry = Symbol.for('vitehub.babysitter.fleet')

/** Configure the fleet from the service environment and expose it to the Babysitter preset. */
export function registerFleetFromEnvironment(environment: NodeJS.ProcessEnv = process.env): Fleet | undefined {
  const existing = (globalThis as Record<symbol, Fleet | undefined>)[registry]
  if (existing) return existing
  const hosts = parseFleetHosts(environment.BABYSITTER_FLEET_HOSTS)
  if (!hosts.length) return undefined
  const proxyPort = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(environment.OPENAI_BASE_URL ?? '')?.[1]
  const forwardPorts = (environment.BABYSITTER_FLEET_FORWARD_PORTS ?? proxyPort ?? '').split(/[,\s]+/).filter(Boolean).map(Number)
  let codexConfig: ((work: string) => string) | undefined
  try {
    codexConfig = remoteCodexConfig(readFileSync(join(environment.CODEX_HOME ?? join(environment.HOME ?? '', '.codex'), 'config.toml'), 'utf8'))
  }
  catch {
    codexConfig = undefined
  }
  const fleet = createFleet({
    localSlots: Number(environment.BABYSITTER_FLEET_LOCAL_SLOTS ?? 15),
    hosts,
    stateDirectory: environment.BABYSITTER_FLEET_STATE ?? join(process.cwd(), '.vitehub', 'fleet'),
    minFreeMemoryBytes: positiveNumber(environment.BABYSITTER_FLEET_MIN_FREE_MEMORY_BYTES, 2 * 1024 ** 3),
    maxMemoryPressure: positiveNumber(environment.BABYSITTER_FLEET_MAX_MEMORY_PRESSURE, 5),
    memoryPerSlotBytes: positiveNumber(environment.BABYSITTER_FLEET_MEMORY_PER_SLOT_BYTES, 512 * 1024 ** 2),
    forwardPorts,
    codexConfig,
  })
  ;(globalThis as Record<symbol, Fleet | undefined>)[registry] = fleet
  void fleet.refresh().then(() => console.log(`[fleet] status ${JSON.stringify(fleet.status())}`))
  return fleet
}

export function registeredFleet(): Fleet | undefined {
  return (globalThis as Record<symbol, Fleet | undefined>)[registry]
}

function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
