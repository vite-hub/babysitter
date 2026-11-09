// A Box runtime that runs repair passes on another machine over (Tailscale) SSH.
// The coordinator keeps the GitHub credentials, the queue and the host checkout.
// The remote host receives git objects through a per-repository mirror, a source
// tarball without dependency trees, and installs dependencies from its own store.
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:os'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, posix, relative } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { promisify } from 'node:util'
import type { BoxExecOptions, BoxExecResult, BoxFileEntry, BoxProcess, BoxRuntime, BoxRuntimeInput, BoxSession } from 'vite-hub/box'

const execFileAsync = promisify(execFile)

/** Coordinator loopback ports reachable on the host, keyed by coordinator port. */
export interface FleetTunnel {
  readonly ports: ReadonlyMap<number, number>
  close(): void
}

/** Starts a POSIX shell script on one host. */
export interface FleetTransport {
  start(script: string): ChildProcessWithoutNullStreams
  /**
   * Forward coordinator loopback ports to free host ports. Fixed host ports can be
   * taken by other tunnels or by another pass, so the host picks each port.
   */
  tunnel?(ports: readonly number[]): Promise<FleetTunnel>
}

export function sshTransport(options: { target: string, controlDir: string, knownHosts: string, connectTimeoutSeconds?: number }): FleetTransport {
  const base = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${options.knownHosts}`,
    '-o', `ConnectTimeout=${options.connectTimeoutSeconds ?? 10}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
  ]
  return {
    start(script) {
      // Short commands and provider processes share one multiplexed connection.
      return spawn('ssh', [...base, '-o', 'LogLevel=ERROR', '-o', 'ControlMaster=auto', '-o', `ControlPath=${options.controlDir}/%C`, '-o', 'ControlPersist=300', options.target, '--', script], { stdio: 'pipe' })
    },
    tunnel(ports) {
      if (!ports.length) return Promise.resolve({ ports: new Map(), close() {} })
      // A tunnel belongs to one provider process and closes with it. ssh reports each
      // host port it was given at INFO level.
      const child = spawn('ssh', [...base, '-o', 'LogLevel=INFO', '-S', 'none', '-N', '-o', 'ExitOnForwardFailure=yes', ...ports.flatMap(port => ['-R', `0:127.0.0.1:${port}`]), options.target], { stdio: ['ignore', 'ignore', 'pipe'] })
      return new Promise((resolve, reject) => {
        const mapped = new Map<number, number>()
        let stderr = ''
        const fail = (message: string) => { clearTimeout(timer); child.kill('SIGTERM'); reject(new Error(`[fleet] Tunnel to ${options.target} failed: ${message}`)) }
        const timer = setTimeout(() => fail(`no port allocation after 30 s. ${stderr.trim()}`), 30_000)
        child.once('error', error => fail(error.message))
        child.once('exit', code => { if (mapped.size < ports.length) fail(`ssh exited ${code}. ${stderr.trim()}`) })
        child.stderr.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString('utf8')).slice(-4000)
          for (const match of stderr.matchAll(/Allocated port (\d+) for remote forward to 127\.0\.0\.1:(\d+)/g)) mapped.set(Number(match[2]), Number(match[1]))
          if (mapped.size === ports.length) {
            clearTimeout(timer)
            resolve({ ports: mapped, close: () => { child.kill('SIGTERM') } })
          }
        })
      })
    },
  }
}

/** Runs scripts on this machine. Tests use it to exercise the runtime without SSH. */
export function localTransport(): FleetTransport {
  return { start: script => spawn('sh', ['-c', script], { stdio: 'pipe' }) }
}

export const q = (value: string) => `'${value.replaceAll('\'', `'"'"'`)}'`

/**
 * Shell that kills every process whose HOME starts with `prefix`. Each command a Box runs inherits the
 * Box's HOME, but Codex starts tool commands in their own sessions, so a process group kill misses them.
 * On 2026-11-09 ten `tsc --noEmit` runs left by closed Boxes filled ServaRICA's memory and swap.
 */
export const killByHome = (prefix: string) =>
  `for e in /proc/[0-9]*/environ; do tr '\\0' '\\n' < "$e" 2>/dev/null | awk -v p=${q(`HOME=${prefix}`)} 'index($0, p) == 1 { found = 1 } END { exit !found }' && { p=\${e#/proc/}; kill -s KILL "\${p%/environ}" 2>/dev/null; }; done; true`

export interface RunResult { code: number, stdout: Buffer, stderr: string }

export async function runScript(transport: FleetTransport, script: string, options: { input?: Uint8Array | Readable, signal?: AbortSignal, timeout?: number } = {}): Promise<RunResult> {
  options.signal?.throwIfAborted()
  const child = transport.start(script)
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', chunk => stdout.push(chunk))
  child.stderr.on('data', chunk => stderr.push(chunk))
  child.stdin.on('error', () => {})
  const stop = () => child.kill('SIGTERM')
  options.signal?.addEventListener('abort', stop, { once: true })
  const timer = options.timeout ? setTimeout(stop, options.timeout) : undefined
  if (options.input instanceof Readable) options.input.pipe(child.stdin)
  else child.stdin.end(options.input)
  try {
    const code = await exitCode(child)
    options.signal?.throwIfAborted()
    return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') }
  }
  finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', stop)
  }
}

function exitCode(child: ChildProcessWithoutNullStreams) {
  return new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve(code ?? 128 + (signal ? constants.signals[signal] ?? 1 : 1)))
  })
}

async function must(transport: FleetTransport, script: string, what: string, options: Parameters<typeof runScript>[2] = {}) {
  const result = await runScript(transport, script, options)
  if (result.code !== 0) throw new Error(`[fleet] ${what} failed (${result.code}): ${result.stderr.trim().slice(-2000)}`)
  return result
}

const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/
/** The runtime owns these. Host values name host paths and never apply remotely. */
const runtimeEnvironment = new Set(['CODEX_HOME', 'COREPACK_HOME', 'HOME', 'INIT_CWD', 'OLDPWD', 'PATH', 'PWD', 'TEMP', 'TMP', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'])
const exportsOf = (environment: Readonly<Record<string, string>>) =>
  Object.entries(environment).filter(([name]) => environmentName.test(name)).map(([name, value]) => `export ${name}=${q(value)}\n`).join('')

/** Point loopback URLs at the host ports their tunnel was given. */
export function remapLoopback(value: string, ports: ReadonlyMap<number, number>) {
  if (!ports.size) return value
  return value.replace(/(?:127\.0\.0\.1|localhost):(\d{2,5})(?!\d)/g, (match, port: string) => {
    const mapped = ports.get(Number(port))
    return mapped === undefined ? match : `127.0.0.1:${mapped}`
  })
}

/** Loopback ports named in a provider command line or environment. */
export function loopbackPorts(values: readonly string[], always: readonly number[] = []) {
  const ports = new Set(always)
  for (const value of values) {
    for (const match of value.matchAll(/(?:127\.0\.0\.1|localhost):(\d{2,5})(?!\d)/g)) {
      const port = Number(match[1])
      if (port > 0 && port < 65536) ports.add(port)
    }
  }
  return [...ports].toSorted((a, b) => a - b)
}

const dependencyExcludes = ['--exclude=./.git/objects', '--exclude=node_modules', '--exclude=./.pnp.cjs', '--exclude=./.pnp.loader.mjs', '--exclude=./.pnp.data.json', '--exclude=./.yarn/cache', '--exclude=./.yarn/unplugged']
const manifestNames = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', '.yarnrc.yml', 'bun.lock', 'bun.lockb'])

async function hostGit(checkout: string, args: string[], input?: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GH_|GITHUB_|GIT_)/i.test(key)))
  // Messages such as the empty-bundle refusal are matched in English.
  env.LC_ALL = 'C'
  const child = execFileAsync('git', ['-C', checkout, '-c', 'core.fsmonitor=false', ...args], { env, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' })
  if (input !== undefined) child.child.stdin?.end(input)
  return (await child).stdout
}

/** Host checkout paths a dependency install reads: manifests, lockfiles and pnpm patches. */
async function dependencyInputs(checkout: string) {
  const paths = (await hostGit(checkout, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).toString('utf8').split('\0')
  return [...new Set(paths.filter(path => path && (manifestNames.has(posix.basename(path)) || path.startsWith('patches/'))))].toSorted()
}

async function dependencyInputsHash(checkout: string, paths: readonly string[]) {
  const hash = createHash('sha256')
  for (const path of paths) {
    const contents = await readFile(join(checkout, path)).catch(() => undefined)
    hash.update(path).update(contents ? '\0file\0' : '\0missing\0')
    if (contents) hash.update(contents).update('\0')
  }
  return hash.digest('hex')
}

const pnpmInstall = 'pnpm install --frozen-lockfile --prefer-offline --ignore-scripts --ignore-pnpmfile'

async function pinnedPackageManager(checkout: string): Promise<string | undefined> {
  const manifest: unknown = await readFile(join(checkout, 'package.json'), 'utf8').then(text => JSON.parse(text), () => undefined).catch(() => undefined)
  return typeof manifest === 'object' && manifest !== null && 'packageManager' in manifest
    && typeof manifest.packageManager === 'string'
    && /^(?:pnpm|yarn|npm)@\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+sha(?:224|256|384|512)\.[a-fA-F0-9]+)?$/.test(manifest.packageManager)
    ? manifest.packageManager
    : undefined
}

/** The shell command that installs a checkout's dependencies in the Box, run from its root. */
export async function installCommand(checkout: string) {
  const exists = (name: string) => lstat(join(checkout, name)).then(() => true, () => false)
  if (await exists('pnpm-lock.yaml')) {
    // The Box never runs repository pnpm hooks, but pnpm refuses a frozen install of a lockfile
    // that records the hook's checksum. Install without that line, then restore the checked-out lockfile.
    if (!/^pnpmfileChecksum:/m.test(await readFile(join(checkout, 'pnpm-lock.yaml'), 'utf8'))) return pnpmInstall
    return `(b=$(mktemp) && cp pnpm-lock.yaml "$b" && sed -i '/^pnpmfileChecksum:/d' pnpm-lock.yaml && { ${pnpmInstall}; s=$?; cp "$b" pnpm-lock.yaml; rm -f "$b"; exit $s; })`
  }
  if (await exists('package-lock.json')) return 'npm ci --prefer-offline --no-audit --no-fund --ignore-scripts'
  return undefined
}

const authority = {
  credentials: 'unknown',
  environment: 'selected',
  filesystem: { access: 'read-write', scope: 'host' },
  isolation: 'none',
  network: 'unrestricted',
  processes: 'arbitrary',
} as const

export interface SshBoxRuntimeOptions {
  /** Host label for errors and logs. */
  host: string
  transport: FleetTransport
  /** Absolute remote directory that holds mirrors, stores and Boxes. */
  root: string
  /** Remote PATH for every Box command. */
  path: string
  /** Coordinator loopback ports every provider process reaches through the tunnel. */
  forwardPorts?: readonly number[]
  /** Codex config written to the Box Home when the plan does not declare one. */
  codexConfig?: (workDirectory: string) => string
  onClose?: () => void
  /**
   * Local directory that receives the Box's Codex session logs before close removes the Box.
   * Each host gets `<sessionArchive>/<host>/YYYY/MM/DD/rollout-*.jsonl`, the same layout as CODEX_HOME/sessions.
   */
  sessionArchive?: string
  /** Step timings and session copies, one structured event each. */
  log?: (event: string, fields: Record<string, unknown>) => void
  /** The host failed: a Box did not open, or a provider connection dropped at once. */
  onHostFailure?: (error: unknown) => void
}

/** A Box session with fast paths for the Babysitter's whole-workspace transfers. */
export interface FleetBoxSession extends BoxSession {
  readonly host: string
  importWorkspace(checkout: string, signal?: AbortSignal): Promise<void>
  refreshDependencies(checkout: string, signal?: AbortSignal): Promise<void>
}

export function createSshBoxRuntime(options: SshBoxRuntimeOptions): BoxRuntime & { readonly network: 'direct', readonly host: string } {
  return {
    name: 'fleet',
    // Provider processes reach coordinator loopback services through SSH reverse forwards.
    network: 'direct',
    host: options.host,
    async prepare(input) {
      if (input.plan.state.length) throw new Error('[fleet] Box Home state is not supported on fleet hosts.')
      if (input.checkout) throw new Error('[fleet] Box checkout is not supported; pass the host checkout as cwd.')
      return {
        cache: { state: 'disposable' },
        environment: { env: {} },
        executionAuthority: authority,
        identity: input.identity,
        requirements: input.requirements.map(requirement => ({ command: requirement.command, name: requirement.name, ...(requirement.timeout === undefined ? {} : { timeout: requirement.timeout }) })),
        runtime: 'fleet',
        workspace: { state: 'disposable', workDir: '.' },
      }
    },
    async open(input, openOptions) {
      const session = await createSession(input, options)
      try {
        await session.materialize(input, openOptions.signal)
        await openOptions.initialize?.(session, { signal: openOptions.signal })
        return session
      }
      catch (error) {
        await session.close().catch(() => undefined)
        if (!openOptions.signal?.aborted) options.onHostFailure?.(error)
        throw error
      }
    },
  }
}

async function createSession(input: BoxRuntimeInput, options: SshBoxRuntimeOptions) {
  if (!input.cwd) throw new Error('[fleet] A fleet Box needs the host checkout as cwd.')
  const { transport } = options
  const log = options.log ?? (() => {})
  const id = randomUUID()
  const directory = `${options.root}/boxes/${id}`
  const home = `${directory}/home`
  const work = `${directory}/work`
  const run = `${directory}/run`
  // Tests, Node's compile cache and gh write here; the Box directory is removed on close, the host /tmp never is.
  const tmp = `${directory}/tmp`
  const base: Record<string, string> = {
    HOME: home,
    INIT_CWD: work,
    OLDPWD: work,
    PWD: work,
    PATH: options.path,
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
    XDG_CACHE_HOME: `${home}/.cache`,
    XDG_CONFIG_HOME: `${home}/.config`,
    XDG_STATE_HOME: `${home}/.local/state`,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    COREPACK_HOME: `${home}/.cache/node/corepack`,
    npm_config_store_dir: `${options.root}/pnpm-store`,
    npm_config_cache_dir: `${options.root}/pnpm-cache`,
  }
  for (const [name, resolve] of Object.entries(input.plan.env)) base[name] = await resolve()
  const environment = (extra?: Readonly<Record<string, string>>) => ({
    ...base,
    ...Object.fromEntries(Object.entries(extra ?? {}).filter(([name]) => !runtimeEnvironment.has(name))),
  })
  const live = new Set<ChildProcessWithoutNullStreams>()
  let closing: Promise<void> | undefined
  const assertOpen = () => { if (closing) throw new Error('[fleet] Box session is closed.') }
  let mirror: string | undefined
  let generatedCodexConfig = false
  // Hash of the dependency inputs of the last successful install in this Box. A refresh with the
  // same inputs reuses it: 2026-10-19 fleet refreshes reinstalled every time, p50 30 s.
  let installedInputs: string | undefined

  const exec = async (command: string, args: readonly string[] = [], execOptions: BoxExecOptions = {}): Promise<BoxExecResult> => {
    assertOpen()
    const script = `cd ${q(execOptions.cwd ?? work)} && eval "$(cat)" && exec ${[command, ...args].map(q).join(' ')} </dev/null`
    const result = await runScript(transport, script, { input: Buffer.from(exportsOf(environment(execOptions.env))), signal: execOptions.signal, timeout: execOptions.timeout })
    return { code: result.code, ok: result.code === 0, stdout: result.stdout.toString('utf8'), stderr: result.stderr }
  }

  const shell = (script: string, what: string, runOptions: Parameters<typeof runScript>[2] = {}) => must(transport, script, what, runOptions)

  const spawnProcess = async (command: string, args: readonly string[] = [], spawnOptions: BoxExecOptions = {}): Promise<BoxProcess> => {
    assertOpen()
    const name = `${run}/${randomUUID()}`
    const ports = loopbackPorts([...args, ...Object.values(spawnOptions.env ?? {})], options.forwardPorts)
    const tunnel = transport.tunnel ? await transport.tunnel(ports) : { ports: new Map<number, number>(), close() {} }
    let child: ChildProcessWithoutNullStreams
    try {
      const values = Object.fromEntries(Object.entries(environment(spawnOptions.env)).map(([key, value]) => [key, remapLoopback(value, tunnel.ports)]))
      // Codex reads its provider URL from config, so render it for this tunnel.
      if (generatedCodexConfig && options.codexConfig) await files.write(`${home}/.codex/config.toml`, Buffer.from(remapLoopback(options.codexConfig(work), tunnel.ports)), { signal: spawnOptions.signal })
      // Secrets travel in a private file, never on a command line.
      await shell(`umask 077 && cat > ${q(`${name}.env`)}`, 'provider environment upload', { input: Buffer.from(exportsOf(values)), signal: spawnOptions.signal })
      const script = `cd ${q(spawnOptions.cwd ?? work)} && exec setsid -w sh -c 'echo $$ > "$1"; . "$2"; rm -f "$2"; shift 2; exec "$@"' sh ${q(`${name}.pid`)} ${q(`${name}.env`)} ${[command, ...args.map(arg => remapLoopback(arg, tunnel.ports))].map(q).join(' ')}`
      child = transport.start(script)
    }
    catch (error) {
      tunnel.close()
      throw error
    }
    live.add(child)
    child.stdin.on('error', () => {})
    const startedAt = Date.now()
    let stderrTail = ''
    child.stderr.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000) })
    const exited = exitCode(child).then(code => ({ code }), () => ({ code: 255 }))
    void exited.then(({ code }) => {
      live.delete(child)
      tunnel.close()
      // ssh exits 255 when the connection fails; a provider that ran for a while is not a host failure.
      if (code === 255 && Date.now() - startedAt < 60_000 && !closing) options.onHostFailure?.(new Error(`[fleet] Provider connection to ${options.host} failed: ${stderrTail.trim().slice(-500)}`))
    })
    return {
      stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
      stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      async kill(signalName = 'SIGTERM') {
        const remoteSignal = signalName.replace(/^SIG/, '')
        await runScript(transport, `p=$(cat ${q(`${name}.pid`)} 2>/dev/null) && kill -s ${q(remoteSignal)} -- "-$p" 2>/dev/null; true`, { timeout: 15_000 }).catch(() => undefined)
        const done = await Promise.race([exited.then(() => true), new Promise<boolean>(resolve => setTimeout(resolve, 5000, false).unref())])
        if (!done) child.kill('SIGKILL')
      },
      wait: () => exited,
    }
  }

  const files: BoxSession['files'] = {
    async exists(path, fileOptions) {
      return (await runScript(transport, `test -e ${q(path)} || test -L ${q(path)}`, { signal: fileOptions?.signal })).code === 0
    },
    async list(path, listOptions) {
      const depth = listOptions?.recursive ? '' : '-maxdepth 1'
      const result = await shell(`cd ${q(path)} && find . -mindepth 1 ${depth} -printf '%y %s %P\\0'`, `listing ${path}`, { signal: listOptions?.signal })
      const excluded = listOptions?.exclude ?? []
      const entries: BoxFileEntry[] = []
      for (const record of result.stdout.toString('utf8').split('\0')) {
        if (!record) continue
        const [kind, size, ...rest] = record.split(' ')
        const relativePath = rest.join(' ')
        if (excluded.some(pattern => relativePath === pattern || relativePath.startsWith(`${pattern}/`) || relativePath.split('/').includes(pattern))) continue
        entries.push({ path: posix.join(path, relativePath), size: Number(size), type: kind === 'd' ? 'directory' : kind === 'l' ? 'symlink' : 'file' })
      }
      return entries
    },
    async mkdir(path, mkdirOptions) {
      await shell(`mkdir ${mkdirOptions?.recursive ? '-p ' : ''}${q(path)}`, `mkdir ${path}`, { signal: mkdirOptions?.signal })
    },
    async move(source, destination, moveOptions) {
      await shell(`mv -f ${q(source)} ${q(destination)}`, `move ${source}`, { signal: moveOptions?.signal })
    },
    async read(path, readOptions) {
      const result = await runScript(transport, `if test -f ${q(path)}; then exec cat ${q(path)}; else exit 44; fi`, { signal: readOptions?.signal })
      if (result.code === 44) return null
      if (result.code !== 0) throw new Error(`[fleet] reading ${path} failed: ${result.stderr.trim()}`)
      return new Uint8Array(result.stdout)
    },
    async remove(path, removeOptions) {
      await shell(`rm -f ${removeOptions?.recursive ? '-r ' : ''}${q(path)}`, `remove ${path}`, { signal: removeOptions?.signal })
    },
    async write(path, contents, writeOptions) {
      await shell(`mkdir -p ${q(posix.dirname(path))} && cat > ${q(path)}`, `write ${path}`, { input: contents, signal: writeOptions?.signal })
    },
  }

  /** Bring the mirror up to date with every object reachable in the host checkout. */
  const syncObjects = async (checkout: string, abortSignal?: AbortSignal) => {
    const origin = (await hostGit(checkout, ['config', '--get', 'remote.origin.url']).then(value => value.toString().trim(), () => '')) || checkout
    mirror = `${options.root}/git/${createHash('sha256').update(origin).digest('hex').slice(0, 16)}.git`
    const lock = `${mirror}.lock`
    const known = await shell(`mkdir -p ${q(`${options.root}/git`)} && flock ${q(lock)} sh -c 'test -d "$1" || git init -q --bare "$1"; git -C "$1" config gc.auto 0; git -C "$1" for-each-ref --format="%(objectname)" refs/fleet/known' sh ${q(mirror)}`, 'mirror preparation', { signal: abortSignal })
    const tips = known.stdout.toString('utf8').split('\n').filter(line => /^[0-9a-f]{40,64}$/.test(line))
    const present = tips.length
      ? (await hostGit(checkout, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], `${tips.join('\n')}\n`)).toString('utf8').split('\n').filter(line => / (?:commit|tag)$/.test(line)).map(line => line.split(' ')[0]!)
      : []
    const scratch = await mkdtemp(join(tmpdir(), 'vitehub-fleet-bundle-'))
    try {
      const bundle = join(scratch, 'sync.bundle')
      const created = await hostGit(checkout, ['bundle', 'create', '-q', bundle, 'HEAD', '--all', '--stdin'], present.map(sha => `^${sha}\n`).join('')).then(() => true, (error: { stderr?: Buffer }) => {
        if (String(error.stderr ?? '').includes('empty bundle')) return false
        throw new Error(`[fleet] git bundle failed: ${String(error.stderr ?? error)}`)
      })
      if (!created) return
      const incoming = `refs/fleet/incoming/${id}`
      await shell(`f=${q(`${run}/sync.bundle`)} && cat > "$f" && flock ${q(lock)} sh -c 'set -e; set -- "$1" "$2" "$3" "+refs/*:$3/*"; if git bundle list-heads "$2" | grep -q " HEAD$"; then set -- "$@" "+HEAD:$3/HEAD"; fi; m="$1"; f="$2"; i="$3"; shift 3; git -C "$m" fetch -q --no-tags --no-write-fetch-head "$f" "$@"; set -- "$m" "$f" "$i"; git -C "$1" for-each-ref --format="update refs/fleet/known/%(objectname) %(objectname)" "$3/" | sort -u | git -C "$1" update-ref --stdin; git -C "$1" for-each-ref --format="delete %(refname)" "$3/" | git -C "$1" update-ref --stdin' sh ${q(mirror)} "$f" ${q(incoming)}; s=$?; rm -f "$f"; exit $s`, 'git object transfer', { input: createReadStream(bundle), signal: abortSignal })
    }
    finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  /** Whether the Box now has the dependencies its inputs describe. */
  const install = async (checkout: string, abortSignal?: AbortSignal, frozen = true): Promise<boolean> => {
    const pin = await pinnedPackageManager(checkout)
    const pinKey = pin && createHash('sha256').update(pin).digest('hex')
    base.COREPACK_HOME = `${home}/.cache/node/corepack${pinKey ? `/${pinKey}` : ''}`
    const command = await installCommand(checkout)
    if (!command) return true
    // Corepack skips integrity checks on cache hits. Only runtime-owned downloads populate
    // the shared seed; workers receive independent copies and can repair their manifests.
    const cache = `${options.root}/pnpm-cache/corepack-seeds-v1/${pinKey}`
    const staging = `${cache}.tmp.${id}`
    const seed = `set -e; cache="$1"; pin="$2"; if ! test -d "$cache/v1"; then seed="$3"; mkdir "$seed"; trap 'rm -rf "$seed"' EXIT; COREPACK_HOME="$seed" corepack install --global --cache-only "$pin"; test -d "$seed/v1"; mv "$seed" "$cache"; fi`
    const prepareCorepack = pin?.startsWith('pnpm@')
      ? `if command -v corepack >/dev/null 2>&1 && manager=$(command -v pnpm) && grep -Fq ${q("require('./lib/corepack.cjs').runMain(['pnpm',")} "$manager"; then mkdir -p ${q(`${options.root}/pnpm-cache/corepack-seeds-v1`)} ${q(base.COREPACK_HOME)} && flock ${q(`${cache}.lock`)} sh -c ${q(seed)} sh ${q(cache)} ${q(pin)} ${q(staging)} && rm -rf ${q(`${base.COREPACK_HOME}/v1`)} && cp -R ${q(`${cache}/v1`)} ${q(`${base.COREPACK_HOME}/v1`)}; fi`
      : ':'
    const pid = `${run}/install.pid`
    const script = (line: string) => `echo $$ > ${q(pid)}; cd ${q(work)} && eval "$(cat)" && { { ${prepareCorepack}; } && ${line}; } > ${q(`${run}/install.log`)} 2>&1; s=$?; tail -c 4000 ${q(`${run}/install.log`)} >&2; rm -f ${q(pid)}; exit $s`
    const runInstall = async (line: string) => {
      try {
        return await runScript(transport, `exec setsid -w sh -c ${q(script(line))}`, { input: Buffer.from(exportsOf(environment())), signal: abortSignal })
      }
      catch (error) {
        await runScript(transport, `p=$(cat ${q(pid)} 2>/dev/null) && kill -s KILL -- "-$p" 2>/dev/null; rm -rf ${q(staging)}; rm -f ${q(pid)}; true`, { timeout: 15_000 }).catch(() => undefined)
        throw error
      }
    }
    let result = await runInstall(command)
    if (result.code !== 0 && !frozen) result = await runInstall(command.replace('--frozen-lockfile', '--no-frozen-lockfile'))
    const record = (status: 'installed' | 'failed', reason?: string) => files.write(`${work}/.git/vitehub-install.json`, Buffer.from(JSON.stringify({ status, reason, at: new Date().toISOString() })), { signal: abortSignal })
    if (result.code === 0) {
      await record('installed')
      return true
    }
    // A prepared conflict merge can leave lockfiles unmerged; the pass resolves them.
    const unmerged = await runScript(transport, `git -C ${q(work)} ls-files -u | head -1`, { signal: abortSignal })
    if (unmerged.code === 0 && unmerged.stdout.length) return false
    const failure = `[fleet] Dependency install failed on ${options.host}: ${result.stderr.trim().slice(-2000)}`
    // Materializing the Box continues without dependencies: the model reads the record and repairs
    // the PR's dependency inputs or works without them. A refresh the model asked for still throws.
    if (frozen) {
      await record('failed', failure)
      return false
    }
    throw new Error(failure)
  }

  /** Copy host-side files into the Box work tree as one tarball. */
  const uploadPaths = async (checkout: string, paths: readonly string[], abortSignal?: AbortSignal) => {
    if (!paths.length) return
    const tar = spawn('tar', ['-C', checkout, '--null', '--no-recursion', '--ignore-failed-read', '-T', '-', '-czf', '-'], { stdio: ['pipe', 'pipe', 'ignore'] })
    tar.stdin.end(paths.map(path => `${path}\0`).join(''))
    await shell(`tar -C ${q(work)} --no-same-owner -xzf -`, 'manifest upload', { input: tar.stdout, signal: abortSignal })
  }

  const session: FleetBoxSession & { materialize(input: BoxRuntimeInput, abortSignal?: AbortSignal): Promise<void> } = {
    id,
    cwd: work,
    host: options.host,
    executionAuthority: authority,
    inspectionConcurrency: 4,
    files,
    exec,
    spawn: spawnProcess,
    async materialize(boxInput, abortSignal) {
      const checkout = boxInput.cwd!
      const timings: Record<string, number> = {}
      const startedAt = Date.now()
      let stepAt = startedAt
      const step = (name: string) => { const at = Date.now(); timings[`${name}Ms`] = at - stepAt; stepAt = at }
      await shell(`mkdir -p ${q(home)} ${q(work)} ${q(tmp)} && umask 077 && mkdir -p ${q(run)}`, 'Box directory creation', { signal: abortSignal })
      await syncObjects(checkout, abortSignal)
      step('mirror')
      const head = (await hostGit(checkout, ['rev-parse', 'HEAD'])).toString().trim()
      // The source tree and Git metadata, without objects or dependency trees.
      const tar = spawn('tar', ['-C', checkout, ...dependencyExcludes, '-czf', '-', '.'], { stdio: ['ignore', 'pipe', 'ignore'] })
      const unpacked = await shell(`tar -C ${q(work)} --no-same-owner -xzf - && mkdir -p ${q(`${work}/.git/objects/info`)} ${q(`${work}/.git/objects/pack`)} && printf '%s\\n' ${q(`${mirror}/objects`)} > ${q(`${work}/.git/objects/info/alternates`)} && git -C ${q(work)} rev-parse HEAD`, 'workspace upload', { input: tar.stdout, signal: abortSignal })
      if (unpacked.stdout.toString().trim() !== head) throw new Error(`[fleet] Box HEAD does not match the host checkout ${head}.`)
      step('upload')
      const inputs = await dependencyInputsHash(checkout, await dependencyInputs(checkout))
      const installed = await install(checkout, abortSignal)
      if (installed) installedInputs = inputs
      step('install')
      for (const [path, file] of Object.entries(boxInput.plan.files)) await files.write(`${home}/${path}`, await file.resolve(), { signal: abortSignal })
      if (options.codexConfig && !Object.hasOwn(boxInput.plan.files, '.codex/config.toml')) {
        await files.write(`${home}/.codex/config.toml`, Buffer.from(options.codexConfig(work)), { signal: abortSignal })
        generatedCodexConfig = true
      }
      const checks = boxInput.requirements.map(requirement => `command -v ${q(requirement.command)} >/dev/null || { echo ${q(requirement.name)}; exit 1; }`).join('; ')
      if (checks) {
        const result = await runScript(transport, `eval "$(cat)" && ${checks}`, { input: Buffer.from(exportsOf(environment())), signal: abortSignal })
        if (result.code !== 0) throw new Error(`[fleet] ${options.host} is missing the Box requirement ${result.stdout.toString().trim() || result.stderr.trim()}.`)
      }
      step('setup')
      log('box.opened', { host: options.host, box: id, ...timings, installed, totalMs: Date.now() - startedAt })
    },
    async importWorkspace(checkout, abortSignal) {
      const list = (output: Buffer) => output.toString('utf8').split('\0').filter(path => path && !isAbsolute(path) && !path.split('/').some(part => part === '..' || part === '.git'))
      const remote = list((await shell(`git -C ${q(work)} -c core.fsmonitor=false ls-files --cached --others --exclude-standard -z`, 'Box file listing', { signal: abortSignal })).stdout)
      const local = list(await hostGit(checkout, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']))
      const scratch = await mkdtemp(join(tmpdir(), 'vitehub-fleet-import-'))
      try {
        const archive = await shell(`cd ${q(work)} && tar --null --no-recursion --ignore-failed-read -T - -czf -`, 'Box workspace export', { input: Buffer.from(remote.map(path => `${path}\0`).join('')), signal: abortSignal })
        const extract = spawn('tar', ['-C', scratch, '--no-same-owner', '-xzf', '-'], { stdio: ['pipe', 'ignore', 'pipe'] })
        extract.stdin.end(archive.stdout)
        await new Promise<void>((resolve, reject) => extract.once('close', code => code === 0 ? resolve() : reject(new Error('[fleet] Box workspace archive could not be extracted.'))))
        const root = await realpath(checkout)
        const inside = (path: string) => { const part = relative(root, path); return part === '' || (!part.startsWith('..') && !isAbsolute(part)) }
        for (const path of new Set([...remote, ...local])) {
          abortSignal?.throwIfAborted()
          const destination = join(root, path)
          let parent = dirname(destination)
          while (!await lstat(parent).catch(() => undefined)) parent = dirname(parent)
          if (!inside(await realpath(parent))) throw new Error('[fleet] Box import destination must stay inside the checkout.')
          const source = join(scratch, path)
          const entry = await lstat(source).catch(() => undefined)
          if (entry?.isDirectory()) continue
          await rm(destination, { force: true })
          if (!entry) continue
          await mkdir(dirname(destination), { recursive: true })
          if (!inside(await realpath(dirname(destination)))) throw new Error('[fleet] Box import destination changed during transfer.')
          if (entry.isSymbolicLink()) await symlink(await readlink(source), destination)
          else { await copyFile(source, destination); await chmod(destination, entry.mode & 0o111 ? 0o755 : 0o644) }
        }
      }
      finally {
        await rm(scratch, { recursive: true, force: true })
      }
    },
    async refreshDependencies(checkout, abortSignal) {
      const paths = await dependencyInputs(checkout)
      const inputs = await dependencyInputsHash(checkout, paths)
      if (inputs === installedInputs) {
        log('box.refreshed', { host: options.host, box: id, skipped: true, totalMs: 0 })
        return
      }
      const startedAt = Date.now()
      installedInputs = undefined
      await uploadPaths(checkout, paths, abortSignal)
      if (await install(checkout, abortSignal, false)) installedInputs = inputs
      log('box.refreshed', { host: options.host, box: id, skipped: false, totalMs: Date.now() - startedAt })
    },
    async close() {
      return closing ??= (async () => {
        const startedAt = Date.now()
        const kill = (signalName: string) => `for f in ${q(run)}/*.pid; do test -f "$f" && kill -s ${signalName} -- "-$(cat "$f")" 2>/dev/null; done; true`
        await runScript(transport, `${kill('TERM')}; sleep 2; ${kill('KILL')}; ${killByHome(home)}`, { timeout: 30_000 }).catch(() => undefined)
        // Codex writes its session log in the Box Home, which the rm below deletes. Copy it first so
        // fleet passes can be measured like local ones. A failed copy never keeps the Box.
        const sessions = options.sessionArchive
          ? await archiveSessions(transport, `${home}/.codex/sessions`, join(options.sessionArchive, options.host)).catch((error: unknown) => {
              log('box.sessions.failed', { host: options.host, box: id, reason: (error instanceof Error ? error.message : String(error)).slice(0, 500) })
              return 0
            })
          : 0
        await runScript(transport, `rm -rf ${q(directory)}`, { timeout: 60_000 }).catch(() => undefined)
        log('box.closed', { host: options.host, box: id, sessions, totalMs: Date.now() - startedAt })
        for (const child of live) child.kill('SIGKILL')
        options.onClose?.()
      })()
    },
  }
  return session
}

/** Session log paths inside CODEX_HOME/sessions. Anything else in the archive is ignored. */
const sessionLogPath = /^\d{4}\/\d{2}\/\d{2}\/rollout-[\w.-]+\.jsonl$/

/**
 * Copy the Codex session logs under `remote` to `local`, keeping their date folders. The archive comes
 * from a Box the agent controlled, so only regular files with a session log path are kept.
 */
export async function archiveSessions(transport: FleetTransport, remote: string, local: string): Promise<number> {
  const listed = await runScript(transport, `cd ${q(remote)} 2>/dev/null || exit 0; find . -type f -name 'rollout-*.jsonl' -print0 | tar --null -T - -czf -`, { timeout: 60_000 })
  if (listed.code !== 0) throw new Error(`session archive failed (${listed.code}): ${listed.stderr.trim().slice(-500)}`)
  if (!listed.stdout.length) return 0
  const scratch = await mkdtemp(join(tmpdir(), 'vitehub-fleet-sessions-'))
  try {
    const extract = spawn('tar', ['-C', scratch, '--no-same-owner', '--no-same-permissions', '-xzf', '-'], { stdio: ['pipe', 'ignore', 'pipe'] })
    extract.stdin.end(listed.stdout)
    await new Promise<void>((resolve, reject) => extract.once('close', code => code === 0 ? resolve() : reject(new Error('session archive could not be extracted'))))
    let copied = 0
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) { await walk(path); continue }
        const name = relative(scratch, path)
        if (!entry.isFile() || !sessionLogPath.test(name)) continue
        await mkdir(join(local, dirname(name)), { recursive: true })
        await copyFile(path, join(local, name))
        copied++
      }
    }
    await walk(scratch)
    return copied
  }
  finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Delete archived session logs older than `days`, and the date folders they leave empty. */
export async function pruneSessionArchive(root: string, days: number, now = Date.now()) {
  const cutoff = now - days * 86_400_000
  const walk = async (directory: string): Promise<boolean> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    let empty = true
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (await walk(path)) await rm(path, { recursive: true, force: true })
        else empty = false
        continue
      }
      if ((await lstat(path)).mtimeMs < cutoff) await rm(path, { force: true })
      else empty = false
    }
    return empty
  }
  await walk(root)
}
