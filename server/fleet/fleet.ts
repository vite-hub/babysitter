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
}

const healthTtlMs = 30_000

export function createFleet(options: FleetOptions) {
  const now = options.now ?? Date.now
  const log = options.log ?? ((event, fields) => console.log(`[fleet] ${event} ${JSON.stringify(fields)}`))
  const minFreeBytes = options.minFreeBytes ?? 4 * 1024 ** 3
  let localActive = 0
  let overflow = 0
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
      const result = await runScript(host.transport, `printf '%s\\n' "$HOME"; df -Pk "$HOME" | awk 'NR==2 {print $4}'; PATH="$HOME/.local/bin:$PATH" command -v git codex pnpm setsid flock tar >/dev/null && echo tools-ok`, { timeout: 20_000 })
      const [home, freeKb, tools] = result.stdout.toString('utf8').trim().split('\n')
      if (result.code !== 0 || !home?.startsWith('/')) return { ok: false, checkedAt, reason: result.stderr.trim().slice(-300) || `exit ${result.code}` }
      const freeBytes = Number(freeKb) * 1024
      if (tools !== 'tools-ok') return { ok: false, checkedAt, home, freeBytes, reason: 'missing git, codex, pnpm, setsid, flock or tar' }
      if (!host.swept) {
        // Boxes left by an earlier coordinator process have no owner. This process
        // is the only coordinator for this root, so stop and remove them.
        const root = `${home}/.vitehub-fleet/boxes`
        await runScript(host.transport, `for f in ${q(root)}/*/run/*.pid; do test -f "$f" && kill -s KILL -- "-$(cat "$f")" 2>/dev/null; done; rm -rf ${q(root)}`, { timeout: 120_000 })
        host.swept = true
        log('host.swept', { host: host.config.name })
      }
      if (freeBytes < minFreeBytes) return { ok: false, checkedAt, home, freeBytes, reason: `only ${Math.round(freeBytes / 1024 ** 2)} MiB free` }
      return { ok: true, checkedAt, home, freeBytes }
    }
    catch (error) {
      return { ok: false, checkedAt, reason: error instanceof Error ? error.message : String(error) }
    }
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
      if (localActive < options.localSlots) return local(pass)
      const candidates = hosts
        .filter(host => host.active < host.config.slots)
        .toSorted((left, right) => left.active / left.config.slots - right.active / right.config.slots)
      for (const host of candidates) {
        const state = await health(host)
        // Another pass may have taken the last slot while this one probed.
        if (!state.ok || !state.home || host.active >= host.config.slots) continue
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
      // Every slot is busy or no host is healthy. The global owner limit still bounds the pass.
      return local(pass, true)
    },
    status() {
      return {
        local: { active: localActive, slots: options.localSlots, overflow },
        hosts: hosts.map(host => ({
          name: host.config.name,
          active: host.active,
          slots: host.config.slots,
          placed: host.placed,
          healthy: host.health?.ok ?? null,
          reason: host.health?.reason,
          freeBytes: host.health?.freeBytes,
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
  }
}

export type Fleet = ReturnType<typeof createFleet>

function ensureDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  return path
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
