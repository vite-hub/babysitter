// Places each Babysitter pass on this host while local memory admission has room, then on remote
// hosts reached over (Tailscale) SSH. This host keeps the queue, the claims and the GitHub
// credentials; a remote host only runs the provider in a Sandbox. Unset BABYSITTER_REMOTE_HOSTS
// means no placement at all.
import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createProcessAgentCapacity, type ProcessAgentCapacityOptions } from 'vite-hub/agent/process'
import { BabysitterPlacementCapacityError, type BabysitterPlacement, type BabysitterPlacementLease } from 'vite-hub/presets/babysitter'
import type { SandboxRuntime } from 'vite-hub/sandbox'
import { startModelRelay } from './relay.ts'
import { createSshSandboxRuntime, isPlacementWorkspaceError, readHostModelProvider, remoteCodexConfig } from './sandbox.ts'
import { q, runScript, sshTransport } from './ssh.ts'

export interface RemoteHost {
  /** SSH destination, for example `svc-fleet@servarica`. */
  target: string
  slots: number
}

export interface HostHealth {
  ok: boolean
  checkedAt: number
  reason?: string
  home?: string
  /** Slots that the host's memory admits, counting passes already running there. */
  admitted?: number
}

export interface PlacementPolicyOptions {
  hosts: readonly RemoteHost[]
  /** Slots this host admits now, counting `active` local passes. */
  localSlots(active: { local: number, remote: number }): number | Promise<number>
  /** A fresh health and memory sample of one host. `active` passes run there now. */
  probe(host: RemoteHost, active: number): Promise<HostHealth>
  /**
   * The Sandbox runtime for one pass on a healthy host, and what to undo when the lease ends.
   * `onOpenFailure` keeps new passes off the host for a while, unless the failure was the pass's own
   * checkout (`PlacementWorkspaceError`).
   */
  runtime(host: RemoteHost, health: HostHealth, hooks: { onOpenFailure(error: unknown): void }): RemoteLease | Promise<RemoteLease>
  log?(event: string, fields: Record<string, unknown>): void
  now?(): number
  /** Reuse a probe this long in `admitted()`. `place()` always probes again. */
  healthTtlMs?: number
  /** Keep a host whose Sandbox failed to open out of placement this long. */
  failureCooldownMs?: number
  /** Run a pass whose checkout a remote Box could not reproduce only on this host, this long. */
  localOnlyMs?: number
}

export interface RemoteLease {
  runtime: SandboxRuntime
  release?(): void
}

export type Placement = BabysitterPlacement & {
  status(): { local: number, hosts: { target: string, active: number, slots: number, admitted: number, healthy: boolean | null, reason?: string }[] }
}

/** Local first, then remote hosts up to their slots and memory. */
export function createPlacementPolicy(options: PlacementPolicyOptions): Placement {
  const now = options.now ?? Date.now
  const log = options.log ?? (() => {})
  const healthTtlMs = options.healthTtlMs ?? 30_000
  const failureCooldownMs = options.failureCooldownMs ?? 5 * 60_000
  const localOnlyMs = options.localOnlyMs ?? 60 * 60_000
  let localActive = 0
  // Passes, by `repository#number`, that wait for a local slot until the time they map to.
  const localOnly = new Map<string, number>()
  const hosts = options.hosts.map(config => ({
    config,
    active: 0,
    health: undefined as HostHealth | undefined,
    probing: undefined as Promise<HostHealth> | undefined,
    downUntil: 0,
  }))
  type Host = (typeof hosts)[number]
  const remoteActive = () => hosts.reduce((total, host) => total + host.active, 0)

  // Concurrent callers share one probe per host.
  const probe = (host: Host) => host.probing ??= options.probe(host.config, host.active)
    .catch((error: unknown): HostHealth => ({ ok: false, checkedAt: now(), reason: error instanceof Error ? error.message : String(error) }))
    .then((health) => {
      if (health.ok !== host.health?.ok) log(health.ok ? 'placement.host.up' : 'placement.host.down', { host: host.config.target, reason: health.reason })
      host.health = health
      host.probing = undefined
      return health
    })

  /** Slots a host admits, never fewer than the passes it runs. A failed or cooling host admits no more. */
  const hostSlots = (host: Host) => {
    const health = host.health
    if (!health?.ok || host.downUntil > now()) return host.active
    return Math.min(host.config.slots, Math.max(host.active, health.admitted ?? 0))
  }

  const once = (release: () => void) => {
    let released = false
    return () => {
      if (released) return
      released = true
      release()
    }
  }

  const localSlots = async () => {
    try {
      const slots = await options.localSlots({ local: localActive, remote: remoteActive() })
      return Math.max(localActive, slots)
    }
    catch {
      return localActive
    }
  }

  return {
    async place(pass) {
      const key = `${pass.repository}#${pass.number}`
      const localUntil = localOnly.get(key) ?? 0
      if (localUntil <= now()) localOnly.delete(key)
      // Read the count after the sample: concurrent placements must not all fit in the same slot.
      const slots = await localSlots()
      if (localActive < slots) {
        localActive++
        log('placement.placed', { ...pass, host: 'local', localActive })
        return { release: once(() => { localActive-- }) }
      }
      if (localUntil > now()) throw new BabysitterPlacementCapacityError(`this host is full, and ${key} runs only on this host until ${new Date(localUntil).toISOString()} because a remote Box could not reproduce its checkout`)
      const candidates = hosts
        .filter(host => host.active < host.config.slots && host.downUntil <= now())
        .toSorted((left, right) => left.active / left.config.slots - right.active / right.config.slots)
      const reasons: string[] = []
      for (const host of candidates) {
        // Probe before every remote pass: the host is shared, and its memory changes between passes.
        const health = await probe(host)
        if (!health.ok) { reasons.push(`${host.config.target}: ${health.reason}`); continue }
        // Another pass may have taken the last slot while this one probed.
        if (host.active >= hostSlots(host)) { reasons.push(`${host.config.target}: full (${host.active}/${hostSlots(host)})`); continue }
        host.active++
        let remote: RemoteLease
        try {
          remote = await options.runtime(host.config, health, {
            onOpenFailure(error) {
              if (isPlacementWorkspaceError(error)) return
              host.downUntil = now() + failureCooldownMs
              log('placement.host.cooldown', { host: host.config.target, reason: (error instanceof Error ? error.message : String(error)).slice(0, 500) })
            },
          })
        }
        catch (error) {
          host.active--
          throw error
        }
        log('placement.placed', { ...pass, host: host.config.target, active: host.active, slots: host.config.slots })
        const runtime: SandboxRuntime = {
          ...remote.runtime,
          // A Box that cannot reproduce this pass's checkout fails only this pass. The pull request waits
          // without a failure strike and runs on this host next.
          async open(...args: Parameters<SandboxRuntime['open']>) {
            try {
              return await remote.runtime.open(...args)
            }
            catch (error) {
              if (!isPlacementWorkspaceError(error)) throw error
              localOnly.set(key, now() + localOnlyMs)
              log('placement.pass.local_only', { ...pass, host: host.config.target, reason: error.message.slice(0, 500) })
              throw new BabysitterPlacementCapacityError(`${host.config.target} could not reproduce the checkout of ${key}, which runs on this host next: ${error.message.slice(0, 500)}`)
            }
          },
        }
        const lease: BabysitterPlacementLease = { sandbox: { runtime }, release: once(() => { host.active--; remote.release?.() }) }
        return lease
      }
      throw new BabysitterPlacementCapacityError(['this host is full', ...reasons].join('; '))
    },
    remoteActive,
    async admitted() {
      const stale = hosts.filter(host => host.active < host.config.slots && host.downUntil <= now() && (!host.health || now() - host.health.checkedAt >= healthTtlMs))
      const [local] = await Promise.all([localSlots(), ...stale.map(probe)])
      return local + hosts.reduce((total, host) => total + hostSlots(host), 0)
    },
    status() {
      return {
        local: localActive,
        hosts: hosts.map(host => ({ target: host.config.target, active: host.active, slots: host.config.slots, admitted: hostSlots(host), healthy: host.health?.ok ?? null, reason: host.health?.reason })),
      }
    },
  }
}

export interface ProbeLimits {
  /** Refuse a host with less free disk in its home. */
  minFreeBytes: number
  /** Memory kept free for the host's own work. */
  reserveBytes: number
  /** Memory one pass may grow to. */
  perPassBytes: number
  /** Refuse a host whose memory pressure (full avg10, percent) exceeds this. */
  maxMemoryPressure: number
}

/**
 * Shell that prints the host's Home, free disk, memory available to this user (MemAvailable,
 * capped by its cgroup's memory.high), memory pressure and whether the tools exist. It also kills
 * and removes every Box under `$HOME/<root>/boxes` that is not in `keep`.
 *
 * Each command a Box runs inherits the Box's HOME, but Codex starts tool commands in their own
 * sessions, so a process group kill misses them. On 2026-11-09 ten `tsc --noEmit` runs left by
 * closed Boxes filled ServaRICA's memory and swap.
 */
export function probeScript(root: string, keep: readonly string[]) {
  const others = (box: string) => `case ${q(` ${keep.join(' ')} `)} in *" ${box} "*) false ;; *) true ;; esac`
  return [
    `boxes="$HOME"/${q(`${root}/boxes`)}`,
    `printf '%s\\n' "$HOME"`,
    `df -Pk "$HOME" | awk 'NR==2 {print $4 * 1024}'`,
    // The user slice caps svc-fleet below the host's free memory, so the smaller headroom counts.
    `a=$(awk '/^MemAvailable:/ {print $2 * 1024}' /proc/meminfo); d=/sys/fs/cgroup$(sed -n 's/^0:://p' /proc/self/cgroup); while [ "$d" != /sys/fs/cgroup ] && [ -n "$d" ]; do h=$(cat "$d/memory.high" 2>/dev/null); c=$(cat "$d/memory.current" 2>/dev/null); f=$(awk '$1 == "inactive_file" {print $2}' "$d/memory.stat" 2>/dev/null); case "$h" in ''|max) ;; *) r=$((h - c + \${f:-0})); [ "$r" -lt "$a" ] && a=$r ;; esac; d=$(dirname "$d"); done; echo "$a"`,
    `awk '$1 == "full" { for (i = 2; i <= NF; i++) if ($i ~ /^avg10=/) { sub(/^avg10=/, "", $i); print $i; exit } }' /proc/pressure/memory`,
    `PATH="$HOME/.local/bin:$PATH" command -v git codex pnpm setsid flock tar >/dev/null && echo tools-ok || echo tools-missing`,
    // Boxes that no live pass owns: an earlier process that died, or a pass whose close failed. A Box
    // younger than 10 minutes may belong to a pass that opened after this probe read the live list.
    `stale=" "; for b in "$boxes"/*; do test -d "$b" || continue; n=\${b##*/}; ${others('$n')} && test -n "$(find "$b" -maxdepth 0 -mmin +10)" && stale="$stale$n "; done`,
    `for f in "$boxes"/*/run/*.pid; do test -f "$f" || continue; b=\${f#"$boxes"/}; b=\${b%%/*}; case "$stale" in *" $b "*) kill -s KILL -- "-$(cat "$f")" 2>/dev/null ;; esac; done; true`,
    `for e in /proc/[0-9]*/environ; do h=$(tr '\\0' '\\n' 2>/dev/null < "$e" | sed -n "s|^HOME=$boxes/||p" | head -1); test -n "$h" || continue; b=\${h%%/*}; case "$stale" in *" $b "*) ;; *) test -d "$boxes/$b" && continue; ${others('$b')} || continue ;; esac; p=\${e#/proc/}; kill -s KILL "\${p%/environ}" 2>/dev/null; done; true`,
    // Tests can leave read-only directories behind.
    `for n in $stale; do chmod -R u+w "$boxes/$n" 2>/dev/null; rm -rf "$boxes/$n"; done; true`,
  ].join('\n')
}

/** Reads the probe output into a health sample. */
export function readProbe(stdout: string, code: number, stderr: string, active: number, limits: ProbeLimits, checkedAt: number): HostHealth {
  const [home, freeText, memoryText, pressureText, tools] = stdout.trim().split('\n')
  if (code !== 0 || !home?.startsWith('/')) return { ok: false, checkedAt, reason: stderr.trim().slice(-300) || `exit ${code}` }
  const freeBytes = Number(freeText)
  const availableBytes = Number(memoryText)
  const pressure = Number(pressureText)
  if (tools !== 'tools-ok') return { ok: false, checkedAt, home, reason: 'missing git, codex, pnpm, setsid, flock or tar' }
  if (![freeBytes, availableBytes, pressure].every(Number.isFinite)) return { ok: false, checkedAt, home, reason: 'disk or memory probe unavailable' }
  if (freeBytes < limits.minFreeBytes) return { ok: false, checkedAt, home, reason: `only ${Math.round(freeBytes / 1024 ** 2)} MiB disk free` }
  if (pressure > limits.maxMemoryPressure) return { ok: false, checkedAt, home, reason: `memory pressure ${pressure.toFixed(1)}% exceeds ${limits.maxMemoryPressure}%` }
  // Running passes already hold part of their budget in the sample; each new one needs a whole one.
  const admitted = active + Math.floor(Math.max(0, availableBytes - limits.reserveBytes) / limits.perPassBytes)
  return { ok: true, checkedAt, home, admitted }
}

/** `user@host:slots`, comma or space separated. */
export function parseRemoteHosts(value: string | undefined): RemoteHost[] {
  return (value ?? '').split(/[,\s]+/).filter(Boolean).map((entry) => {
    const match = /^([^\s:@]+@[^\s:]+|[^\s:@]+):(\d+)$/.exec(entry)
    if (!match) throw new Error(`[placement] Invalid BABYSITTER_REMOTE_HOSTS entry "${entry}". Use user@host:slots.`)
    return { target: match[1]!, slots: Number(match[2]) }
  }).filter(host => host.slots > 0)
}

export interface EnvironmentPlacementOptions {
  /** The same capacity options the preset uses, so local admission matches the worker queue's. */
  capacity: Omit<ProcessAgentCapacityOptions, 'remoteActive' | 'concurrency'>
  concurrency: number
  perPassBytes: number
  log?(event: string, fields: Record<string, unknown>): void
}

export type EnvironmentPlacement = Placement

/** Environment variable that carries a lease's relay token to the remote Codex. */
const remoteTokenName = 'VITEHUB_PLACEMENT_MODEL_TOKEN'

/**
 * Configures placement from the service environment. Returns undefined without
 * BABYSITTER_REMOTE_HOSTS, so every pass stays on this host as before.
 */
export function placementFromEnvironment(options: EnvironmentPlacementOptions, environment: NodeJS.ProcessEnv = process.env): EnvironmentPlacement | undefined {
  const hosts = parseRemoteHosts(environment.BABYSITTER_REMOTE_HOSTS)
  if (!hosts.length) return undefined
  // The agent module can load more than once in one process; its slot counts must not split.
  const registry = globalThis as { [key: symbol]: EnvironmentPlacement | undefined }
  return registry[registryKey] ??= createEnvironmentPlacement(hosts, options, environment)
}

const registryKey = Symbol.for('babysitter.placement')

/** Swaps the model key for a lease token everywhere in a remote environment, and points the base URL at the relay. */
export function leaseEnvironment(value: Record<string, string>, secret: string, token: string, baseUrl: string) {
  const result: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value)) if (!entry.includes(secret)) result[name] = entry
  if ('OPENAI_BASE_URL' in result) result.OPENAI_BASE_URL = baseUrl
  result[remoteTokenName] = token
  return result
}

function createEnvironmentPlacement(hosts: RemoteHost[], options: EnvironmentPlacementOptions, environment: NodeJS.ProcessEnv): EnvironmentPlacement {
  const log = options.log ?? ((event, fields) => console.log(`[placement] ${event} ${JSON.stringify(fields)}`))
  const codexHome = environment.CODEX_HOME ?? join(environment.HOME ?? '', '.codex')
  const provider = readHostModelProvider(readFileSync(join(codexHome, 'config.toml'), 'utf8'), environment)
  const apiKey = provider?.apiKey
  if (!provider || !apiKey) throw new Error(`[placement] ${codexHome}/config.toml must select a model_provider with a base_url and an env_key or experimental_bearer_token; remote passes reach it through this host.`)
  const upstream = new URL(provider.baseUrl)
  let relay: ReturnType<typeof startModelRelay> | undefined
  const state = environment.BABYSITTER_REMOTE_STATE ?? join(process.cwd(), '.vitehub', 'placement')
  mkdirSync(state, { recursive: true, mode: 0o700 })
  // Unix sockets allow about 108 bytes and TMPDIR can be deep; ssh appends a random suffix.
  const controlDirectory = `/tmp/vhp-${process.getuid?.() ?? 0}`
  mkdirSync(controlDirectory, { recursive: true, mode: 0o700 })
  const limits: ProbeLimits = {
    minFreeBytes: positive(environment.BABYSITTER_REMOTE_MIN_FREE_BYTES, 4 * 1024 ** 3),
    reserveBytes: positive(environment.BABYSITTER_REMOTE_RESERVE_BYTES, 2 * 1024 ** 3),
    perPassBytes: positive(environment.BABYSITTER_REMOTE_PASS_BYTES, options.perPassBytes),
    maxMemoryPressure: positive(environment.BABYSITTER_REMOTE_MAX_MEMORY_PRESSURE, 10),
  }
  const transports = new Map(hosts.map(host => [host.target, sshTransport({ target: host.target, controlDirectory, knownHosts: join(state, 'known_hosts') })]))
  // Box ids of passes whose Sandbox is open. A probe removes every other Box under the root.
  const live = new Set<string>()
  // The fleet's directory: its git mirrors and pnpm store are warm.
  const remoteRoot = '.vitehub-fleet'
  const local = createProcessAgentCapacity({ ...options.capacity, concurrency: options.concurrency, remoteActive: () => policy.remoteActive?.() ?? 0 }).adaptive!
  const policy = createPlacementPolicy({
    hosts,
    log,
    async localSlots(active) {
      // The sampler counts every active pass it is given as local; `remoteActive` holds the remote slots.
      const sample = await local.sample({ active: active.local, concurrency: options.concurrency, pending: 0, signal: AbortSignal.timeout(5_000) })
      return sample.concurrency
    },
    async probe(host, active) {
      const result = await runScript(transports.get(host.target)!, probeScript(remoteRoot, [...live]), { timeout: 60_000 })
      return readProbe(result.stdout.toString('utf8'), result.code, result.stderr, active, limits, Date.now())
    },
    async runtime(host, health, hooks) {
      const { port } = await (relay ??= startModelRelay({ upstream: upstream.origin, apiKey }))
      const lease = (await relay).issue()
      const baseUrl = `http://127.0.0.1:${port}${upstream.pathname}${upstream.search}`
      const runtime = createSshSandboxRuntime({
        host: host.target,
        transport: transports.get(host.target)!,
        root: `${health.home}/${remoteRoot}`,
        path: `${health.home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
        forwardPorts: [port],
        codexConfig: remoteCodexConfig(provider, { baseUrl, envKey: remoteTokenName }),
        environment: value => leaseEnvironment(value, apiKey, lease.token, baseUrl),
        log,
        onOpen: id => live.add(id),
        onOpenFailure: hooks.onOpenFailure,
        onClose: id => live.delete(id),
      })
      return { runtime, release: lease.revoke }
    },
  })
  return policy
}

function positive(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return value !== undefined && value !== '' && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
