// A Sandbox runtime that runs a repair pass on another machine over SSH. This host keeps the
// GitHub credentials, the queue and the checkout; the remote host gets git objects through a
// per-repository mirror, a source tarball without dependency trees, and installs dependencies
// from its own pnpm store. Codex runs there and reaches this host's loopback services (the
// capability MCP endpoint, cliproxy) through SSH reverse forwards.
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, posix, relative } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { promisify } from 'node:util'
import type { SandboxExecOptions, SandboxExecResult, SandboxFileEntry, SandboxProcess, SandboxRuntime, SandboxRuntimeInput, SandboxSession } from 'vite-hub/sandbox'
import { exitCode, must, q, runScript, withProducer, type RunResult, type ScriptTransport } from './ssh.ts'
import { parse, stringify, type TomlPrimitive } from 'smol-toml'

const execFileAsync = promisify(execFile)

const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/
/** The runtime owns these. Host values name host paths and never apply remotely. */
const runtimeEnvironment = new Set(['CODEX_HOME', 'COREPACK_HOME', 'HOME', 'INIT_CWD', 'OLDPWD', 'PATH', 'PWD', 'TEMP', 'TMP', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'])
const exportsOf = (environment: Readonly<Record<string, string>>) =>
  Object.entries(environment).filter(([name]) => environmentName.test(name)).map(([name, value]) => `export ${name}=${q(value)}\n`).join('')

const loopback = /(?:127\.0\.0\.1|localhost):(\d{2,5})(?!\d)/g

/** Point loopback URLs at the host ports their tunnel was given. */
export function remapLoopback(value: string, ports: ReadonlyMap<number, number>) {
  if (!ports.size) return value
  return value.replace(loopback, (match, port: string) => {
    const mapped = ports.get(Number(port))
    return mapped === undefined ? match : `127.0.0.1:${mapped}`
  })
}

/** Loopback ports named in a provider command line or environment. */
export function loopbackPorts(values: readonly string[], always: readonly number[] = []) {
  const ports = new Set(always)
  for (const value of values) {
    for (const match of value.matchAll(loopback)) {
      const port = Number(match[1])
      if (port > 0 && port < 65536) ports.add(port)
    }
  }
  return [...ports].toSorted((a, b) => a - b)
}

/** The model provider that this host's Codex config selects, read from an allowlist of its settings. */
export interface HostModelProvider {
  id: string
  baseUrl: string
  /** The provider's key: the variable its `env_key` names, else its `experimental_bearer_token`. */
  apiKey?: string
  /** Allowlisted top-level and provider settings. */
  topLevel: Record<string, TomlPrimitive>
  settings: Record<string, TomlPrimitive>
}

const topLevelKeys = new Set(['model', 'model_provider', 'model_reasoning_effort', 'model_reasoning_summary', 'model_verbosity', 'service_tier'])
// Headers, query parameters and token settings can all carry credentials, so none of them travel.
const providerKeys = new Set(['name', 'wire_api', 'requires_openai_auth', 'request_max_retries', 'stream_max_retries', 'stream_idle_timeout_ms'])
const isTable = (value: unknown): value is Record<string, TomlPrimitive> => typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
const scalar = (value: unknown): value is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof value)
const allowed = (table: Record<string, TomlPrimitive>, keys: Set<string>) =>
  Object.fromEntries(Object.entries(table).filter(([key, value]) => keys.has(key) && scalar(value)))

/** Reads the selected provider with a TOML parser, so comments, quoting and inline tables follow Codex. */
export function readHostModelProvider(source: string, environment: Readonly<Record<string, string | undefined>>): HostModelProvider | undefined {
  const config = parse(source)
  const id = config.model_provider
  const providers = config.model_providers
  const provider = typeof id === 'string' && isTable(providers) ? providers[id] : undefined
  if (typeof id !== 'string' || !isTable(provider) || typeof provider.base_url !== 'string') return undefined
  const envKey = typeof provider.env_key === 'string' ? provider.env_key : undefined
  const bearer = typeof provider.experimental_bearer_token === 'string' ? provider.experimental_bearer_token : undefined
  return {
    id,
    baseUrl: provider.base_url,
    apiKey: (envKey && environment[envKey]) || bearer,
    topLevel: allowed(config, topLevelKeys),
    settings: allowed(provider, providerKeys),
  }
}

/**
 * Codex settings for a remote pass: the selected provider at `baseUrl`, keyed by the variable `envKey`.
 * Commands that Codex runs get that variable empty, the same as ViteHub's MCP bearer.
 */
export function remoteCodexConfig(provider: HostModelProvider, options: { baseUrl: string, envKey: string }) {
  const base = {
    ...provider.topLevel,
    model_providers: { [provider.id]: { ...provider.settings, base_url: options.baseUrl, env_key: options.envKey } },
    shell_environment_policy: { set: { [options.envKey]: '' } },
  }
  return (workDirectory: string) => `${stringify({ ...base, projects: { [workDirectory]: { trust_level: 'trusted' } } })}\n`
}

const manifestNames = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', '.yarnrc.yml', 'bun.lock', 'bun.lockb'])
/** In-progress operation heads that no ref reaches, such as the base of a prepared merge. */
const pseudoHeads = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']

/**
 * The host checkout could not be reproduced in a Box, for example because its index names an object
 * that never reached the Box. The placement host itself is fine, so it stays in rotation.
 */
export class PlacementWorkspaceError extends Error {
  override name = 'PlacementWorkspaceError'
}

export const isPlacementWorkspaceError = (error: unknown): error is PlacementWorkspaceError => error instanceof Error && error.name === 'PlacementWorkspaceError'

/** Exit status of Box-side steps that fail on the checkout's data, as opposed to the host or SSH. */
const workspaceExit = 70

async function hostGit(checkout: string, args: string[], input?: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GH_|GITHUB_|GIT_)/i.test(key)))
  // Messages such as the empty-bundle refusal are matched in English.
  env.LC_ALL = 'C'
  const child = execFileAsync('git', ['-C', checkout, '-c', 'core.fsmonitor=false', ...args], { env, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' })
  if (input !== undefined) child.child.stdin?.end(input)
  return (await child).stdout
}

/** Host checkout paths a dependency install reads: manifests, lockfiles and pnpm patches. */
async function presentPseudoHeads(checkout: string) {
  const heads: string[] = []
  for (const head of pseudoHeads) if (await lstat(join(checkout, '.git', head)).then(() => true, () => false)) heads.push(head)
  return heads
}

/**
 * Objects the index names that no tree of HEAD or of an in-progress operation head holds: blobs that
 * a merge wrote for cleanly merged files, staged host resolutions and virtual merge bases. No ref
 * reaches them, so the mirror never gets them. Git also writes no loose copy of an object that a
 * pack already holds, as when gc moved the same merge from an earlier pass into a cruft pack, so
 * the loose objects in the metadata tarball can miss them too.
 */
async function indexOnlyObjects(checkout: string, heads: readonly string[]) {
  const committed = new Set<string>()
  for (const tip of ['HEAD', ...heads]) {
    for (const entry of (await hostGit(checkout, ['ls-tree', '-r', '-z', '--full-tree', tip])).toString('utf8').split('\0')) {
      const objectName = /^\d+ \w+ ([0-9a-f]+)\t/.exec(entry)?.[1]
      if (objectName) committed.add(objectName)
    }
  }
  const staged = new Set<string>()
  for (const entry of (await hostGit(checkout, ['ls-files', '--stage', '-z'])).toString('utf8').split('\0')) {
    // Gitlinks name commits of other repositories.
    const match = /^(\d+) ([0-9a-f]+) \d\t/.exec(entry)
    if (match && match[1] !== '160000' && !committed.has(match[2]!)) staged.add(match[2]!)
  }
  return [...staged]
}

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
  const manifest: unknown = await readFile(join(checkout, 'package.json'), 'utf8').then(text => JSON.parse(text), () => undefined)
  return typeof manifest === 'object' && manifest !== null && 'packageManager' in manifest
    && typeof manifest.packageManager === 'string'
    && /^(?:pnpm|yarn|npm)@\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+sha(?:224|256|384|512)\.[a-fA-F0-9]+)?$/.test(manifest.packageManager)
    ? manifest.packageManager
    : undefined
}

/** The shell command that installs a checkout's dependencies in the Box, run from its root. */
async function installCommand(checkout: string) {
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

export interface SshSandboxRuntimeOptions {
  /** Host label for errors and logs. */
  host: string
  transport: ScriptTransport
  /** Absolute remote directory that holds mirrors, stores and Boxes. */
  root: string
  /** Remote PATH for every Box command. */
  path: string
  /** Local loopback ports every provider process reaches through the tunnel. */
  forwardPorts?: readonly number[]
  /** Codex config written to the Box Home when the plan does not declare one. */
  codexConfig?: (workDirectory: string) => string
  /** Rewrites the environment of every Box command, for example to swap a host secret for a lease token. */
  environment?: (environment: Record<string, string>) => Record<string, string>
  /** Step timings, one structured event each. */
  log?: (event: string, fields: Record<string, unknown>) => void
  /** A Box is about to be created on the host. Every open gets its own Box id. */
  onOpen?: (id: string) => void
  /** The Box failed to open. A cancelled open is not a failure. */
  onOpenFailure?: (error: unknown) => void
  /** The Box and its processes are gone from the host, or the attempt to remove them ended. */
  onClose?: (id: string) => void
}

/** A Sandbox session with fast paths for the Babysitter's whole-workspace transfers. */
export interface SshSandboxSession extends SandboxSession {
  readonly host: string
  importWorkspace(checkout: string, signal?: AbortSignal): Promise<void>
  refreshDependencies(checkout: string, signal?: AbortSignal): Promise<void>
}

export function createSshSandboxRuntime(options: SshSandboxRuntimeOptions): SandboxRuntime & { readonly network: 'direct' } {
  return {
    name: 'ssh-placement',
    // Provider processes reach loopback services of this process through SSH reverse forwards.
    network: 'direct',
    async prepare(input) {
      if (input.plan.state.length) throw new Error('[placement] Sandbox Home state is not supported on placement hosts.')
      if (input.checkout) throw new Error('[placement] Sandbox checkout is not supported; pass the host checkout as cwd.')
      return {
        cache: { state: 'disposable' },
        environment: { env: {} },
        executionAuthority: authority,
        identity: input.identity,
        requirements: input.requirements.map(requirement => ({ command: requirement.command, name: requirement.name, ...(requirement.timeout === undefined ? {} : { timeout: requirement.timeout }) })),
        runtime: 'ssh-placement',
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
        // A checkout the Box cannot reproduce is that pass's problem; the caller decides where it runs next.
      if (!openOptions.signal?.aborted) options.onOpenFailure?.(error)
        throw error
      }
    },
  }
}

async function createSession(input: SandboxRuntimeInput, options: SshSandboxRuntimeOptions) {
  if (!input.cwd) throw new Error('[placement] A placed pass needs the host checkout as cwd.')
  const { transport } = options
  const log = options.log ?? (() => {})
  const id = randomUUID()
  options.onOpen?.(id)
  const directory = `${options.root}/boxes/${id}`
  const home = `${directory}/home`
  const work = `${directory}/work`
  const run = `${directory}/run`
  // Tests, Node's compile cache and gh write here; close removes the Box directory, the host /tmp never is.
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
  const rewrite = options.environment ?? (value => value)
  const environment = (extra?: Readonly<Record<string, string>>) => rewrite({
    ...base,
    ...Object.fromEntries(Object.entries(extra ?? {}).filter(([name]) => !runtimeEnvironment.has(name))),
  })
  const live = new Set<ChildProcessWithoutNullStreams>()
  let closing: Promise<void> | undefined
  const assertOpen = () => { if (closing) throw new Error('[placement] Sandbox session is closed.') }
  let mirror: string | undefined
  let generatedCodexConfig = false
  // Hash of the dependency inputs of the last successful install in this Box. A refresh with the
  // same inputs reuses it: 2026-10-19 fleet refreshes reinstalled every time, p50 30 s.
  let installedInputs: string | undefined

  const exec = async (command: string, args: readonly string[] = [], execOptions: SandboxExecOptions = {}): Promise<SandboxExecResult> => {
    assertOpen()
    const script = `cd ${q(execOptions.cwd ?? work)} && eval "$(cat)" && exec ${[command, ...args].map(q).join(' ')} </dev/null`
    const result = await runScript(transport, script, { input: Buffer.from(exportsOf(environment(execOptions.env))), signal: execOptions.signal, timeout: execOptions.timeout })
    return { code: result.code, ok: result.code === 0, stdout: result.stdout.toString('utf8'), stderr: result.stderr }
  }

  const shell = (script: string, what: string, runOptions: Parameters<typeof runScript>[2] = {}) => must(transport, script, what, runOptions)

  const spawnProcess = async (command: string, args: readonly string[] = [], spawnOptions: SandboxExecOptions = {}): Promise<SandboxProcess> => {
    assertOpen()
    const name = `${run}/${randomUUID()}`
    const processEnvironment = environment(spawnOptions.env)
    const ports = loopbackPorts([...args, ...Object.values(processEnvironment)], options.forwardPorts)
    const tunnel = transport.tunnel ? await transport.tunnel(ports) : { ports: new Map<number, number>(), close() {} }
    let child: ChildProcessWithoutNullStreams
    try {
      const values = Object.fromEntries(Object.entries(processEnvironment).map(([key, value]) => [key, remapLoopback(value, tunnel.ports)]))
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
    const exited = exitCode(child).then(code => ({ code }), () => ({ code: 255 }))
    void exited.then(() => {
      live.delete(child)
      tunnel.close()
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

  const files: SandboxSession['files'] = {
    async exists(path, fileOptions) {
      return (await runScript(transport, `test -e ${q(path)} || test -L ${q(path)}`, { signal: fileOptions?.signal })).code === 0
    },
    async list(path, listOptions) {
      const depth = listOptions?.recursive ? '' : '-maxdepth 1'
      const result = await shell(`cd ${q(path)} && find . -mindepth 1 ${depth} -printf '%y %s %P\\0'`, `listing ${path}`, { signal: listOptions?.signal })
      const excluded = listOptions?.exclude ?? []
      const entries: SandboxFileEntry[] = []
      for (const record of result.stdout.toString('utf8').split('\0')) {
        if (!record) continue
        const [kind, size, ...rest] = record.split(' ')
        const relativePath = rest.join(' ')
        const absolute = posix.join(path, relativePath)
        if (excluded.some(pattern => absolute === pattern || absolute.startsWith(`${pattern}/`))) continue
        entries.push({ path: absolute, size: Number(size), type: kind === 'd' ? 'directory' : kind === 'l' ? 'symlink' : 'file' })
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
      if (result.code !== 0) throw new Error(`[placement] reading ${path} failed: ${result.stderr.trim()}`)
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
    const heads = await presentPseudoHeads(checkout)
    const scratch = await mkdtemp(join(tmpdir(), 'vitehub-placement-bundle-'))
    try {
      const bundle = join(scratch, 'sync.bundle')
      const exclusions = present.map(sha => `^${sha}\n`).join('')
      const create = (refs: string[]) => hostGit(checkout, ['bundle', 'create', '-q', bundle, 'HEAD', ...heads, ...refs, '--stdin'], exclusions).then(() => true, (error: { stderr?: Buffer }) => {
        if (String(error.stderr ?? '').includes('empty bundle')) return false
        throw new PlacementWorkspaceError(`[placement] git bundle failed: ${String(error.stderr ?? error)}`)
      })
      // Every ref, so the pass can diff against any branch. A ref with missing objects fails the whole
      // bundle; then the pass gets its head, its local branches and the default branch.
      const created = await create(['--all']).catch(async (error: Error) => {
        if (!/bad (?:tree )?object|missing|pack-objects died/i.test(error.message)) throw error
        const fallback = ['--branches', ...(await hostGit(checkout, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']).then(value => [value.toString().trim()].filter(Boolean), () => []))]
        log('placement.box.bundle_fallback', { host: options.host, box: id, refs: fallback, reason: error.message.slice(0, 300) })
        return await create(fallback)
      })
      if (!created) return
      const incoming = `refs/fleet/incoming/${id}`
      const bundleStream = createReadStream(bundle)
      // Every head the bundle lists lands under an incoming namespace, is recorded as known, then dropped.
      await shell(`f=${q(`${run}/sync.bundle`)} && cat > "$f" && flock ${q(lock)} sh -c 'set -e; m="$1"; f="$2"; i="$3"; git bundle list-heads "$f" | awk -v i="$i" "{ print \\"+\\" \\$2 \\":\\" i \\"/\\" NR }" > "$f.refspecs"; xargs git -C "$m" fetch -q --no-tags --no-write-fetch-head "$f" < "$f.refspecs"; rm -f "$f.refspecs"; git -C "$m" for-each-ref --format="update refs/fleet/known/%(objectname) %(objectname)" "$i/" | sort -u | git -C "$m" update-ref --stdin; git -C "$m" for-each-ref --format="delete %(refname)" "$i/" | git -C "$m" update-ref --stdin' sh ${q(mirror)} "$f" ${q(incoming)}; s=$?; rm -f "$f"; exit $s`, 'git object transfer', { input: bundleStream, signal: abortSignal })
        .finally(() => bundleStream.destroy())
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
    // the shared seed; Boxes receive independent copies and can repair their manifests.
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
    const failure = `[placement] Dependency install failed on ${options.host}: ${result.stderr.trim().slice(-2000)}`
    // The Box opens without dependencies: the model reads the record and repairs the PR's
    // dependency inputs or works without them. A refresh the model asked for still throws.
    if (frozen) {
      await record('failed', failure)
      return false
    }
    throw new Error(failure)
  }

  /** Copy host-side files into the Box work tree as one tarball. */
  const uploadPaths = async (checkout: string, paths: readonly string[], abortSignal?: AbortSignal) => {
    if (!paths.length) return
    await withProducer('tar', ['-C', checkout, '--null', '--no-recursion', '--ignore-failed-read', '-T', '-', '-czf', '-'], { input: paths.map(path => `${path}\0`).join('') },
      stdout => shell(`tar -C ${q(work)} --no-same-owner -xzf -`, 'file upload', { input: stdout, signal: abortSignal }))
  }

  const session: SshSandboxSession & { materialize(input: SandboxRuntimeInput, abortSignal?: AbortSignal): Promise<void> } = {
    id,
    cwd: work,
    host: options.host,
    executionAuthority: authority,
    inspectionConcurrency: 4,
    files,
    exec,
    spawn: spawnProcess,
    async materialize(sandboxInput, abortSignal) {
      const checkout = sandboxInput.cwd!
      const timings: Record<string, number> = {}
      const startedAt = Date.now()
      let stepAt = startedAt
      const step = (name: string) => { const at = Date.now(); timings[`${name}Ms`] = at - stepAt; stepAt = at }
      await shell(`mkdir -p ${q(home)} ${q(work)} ${q(tmp)} && umask 077 && mkdir -p ${q(run)}`, 'Box directory creation', { signal: abortSignal })
      await syncObjects(checkout, abortSignal)
      step('mirror')
      const head = (await hostGit(checkout, ['rev-parse', 'HEAD'])).toString().trim()
      // Git metadata without packed objects: the mirror provides those. Loose objects travel, and so does a
      // pack of the index objects that no commit in the mirror holds (see indexOnlyObjects). The Box then
      // writes the tree from its index, so only the files that differ from the index cross the network:
      // Slimbook's uplink to ServaRICA moves about 0.5 MB/s, and a whole vite-hub tree took a minute.
      const scratch = await mkdtemp(join(tmpdir(), 'vitehub-placement-index-'))
      let unpacked: RunResult
      try {
        const extra = await indexOnlyObjects(checkout, await presentPseudoHeads(checkout))
        const pack = 'vitehub-index-objects.pack'
        const members = ['-C', join(checkout, '.git'), '.']
        if (extra.length) {
          await writeFile(join(scratch, pack), await hostGit(checkout, ['pack-objects', '--stdout', '-q'], `${extra.join('\n')}\n`))
          members.push('-C', scratch, pack)
        }
        const box = q(work)
        const restore = `{ ! test -f ${box}/.git/${pack} || { git -C ${box} index-pack --stdin < ${box}/.git/${pack} >/dev/null && rm -f ${box}/.git/${pack}; } || exit ${workspaceExit}; } && { git -C ${box} checkout-index --all --force || exit ${workspaceExit}; }`
        unpacked = await withProducer('tar', ['--exclude=./objects/pack', '-czf', '-', ...members], {}, metadata => runScript(transport, `mkdir -p ${box}/.git && tar -C ${box}/.git --no-same-owner -xzf - && mkdir -p ${box}/.git/objects/info ${box}/.git/objects/pack && printf '%s\\n' ${q(`${mirror}/objects`)} > ${box}/.git/objects/info/alternates && ${restore} && git -C ${box} rev-parse HEAD`, { input: metadata, signal: abortSignal }))
      }
      finally {
        await rm(scratch, { recursive: true, force: true })
      }
      if (unpacked.code === workspaceExit) throw new PlacementWorkspaceError(`[placement] workspace upload failed: ${unpacked.stderr.trim().slice(-2000)}`)
      if (unpacked.code !== 0) throw new Error(`[placement] workspace upload failed (${unpacked.code}): ${unpacked.stderr.trim().slice(-2000)}`)
      if (unpacked.stdout.toString().trim() !== head) throw new PlacementWorkspaceError(`[placement] Box HEAD does not match the host checkout ${head}.`)
      const listed = async (args: string[]) => (await hostGit(checkout, [...args, '-z'])).toString('utf8').split('\0').filter(Boolean)
      // Unstaged edits, conflicted files with their markers and untracked files that are not ignored.
      const changed = new Set([...await listed(['ls-files', '--modified', '--others', '--exclude-standard']), ...await listed(['diff', '--name-only', '--diff-filter=U'])])
      await uploadPaths(checkout, [...changed], abortSignal)
      const deleted = await listed(['ls-files', '--deleted'])
      if (deleted.length) await shell(`cd ${q(work)} && xargs -0 rm -f --`, 'deleted file removal', { input: Buffer.from(deleted.map(path => `${path}\0`).join('')), signal: abortSignal })
      step('upload')
      const inputs = await dependencyInputsHash(checkout, await dependencyInputs(checkout))
      const installed = await install(checkout, abortSignal)
      if (installed) installedInputs = inputs
      step('install')
      for (const [path, file] of Object.entries(sandboxInput.plan.files)) await files.write(`${home}/${path}`, await file.resolve(), { signal: abortSignal })
      if (options.codexConfig && !Object.hasOwn(sandboxInput.plan.files, '.codex/config.toml')) {
        await files.write(`${home}/.codex/config.toml`, Buffer.from(options.codexConfig(work)), { signal: abortSignal })
        generatedCodexConfig = true
      }
      const checks = sandboxInput.requirements.map(requirement => `command -v ${q(requirement.command)} >/dev/null || { echo ${q(requirement.name)}; exit 1; }`).join('; ')
      if (checks) {
        const result = await runScript(transport, `eval "$(cat)" && ${checks}`, { input: Buffer.from(exportsOf(environment())), signal: abortSignal })
        if (result.code !== 0) throw new Error(`[placement] ${options.host} is missing the Sandbox requirement ${result.stdout.toString().trim() || result.stderr.trim()}.`)
      }
      step('setup')
      log('placement.box.opened', { host: options.host, box: id, ...timings, installed, totalMs: Date.now() - startedAt })
    },
    async importWorkspace(checkout, abortSignal) {
      const list = (output: Buffer) => output.toString('utf8').split('\0').filter(path => path && !isAbsolute(path) && !path.split('/').some(part => part === '..' || part === '.git'))
      const remote = list((await shell(`git -C ${q(work)} -c core.fsmonitor=false ls-files --cached --others --exclude-standard -z`, 'Box file listing', { signal: abortSignal })).stdout)
      const local = list(await hostGit(checkout, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']))
      const scratch = await mkdtemp(join(tmpdir(), 'vitehub-placement-import-'))
      try {
        const archive = await shell(`cd ${q(work)} && tar --null --no-recursion --ignore-failed-read -T - -czf -`, 'Box workspace export', { input: Buffer.from(remote.map(path => `${path}\0`).join('')), signal: abortSignal })
        const extract = spawn('tar', ['-C', scratch, '--no-same-owner', '-xzf', '-'], { stdio: ['pipe', 'ignore', 'pipe'] })
        extract.stdin.end(archive.stdout)
        await new Promise<void>((resolve, reject) => extract.once('close', code => code === 0 ? resolve() : reject(new Error('[placement] Box workspace archive could not be extracted.'))))
        const root = await realpath(checkout)
        const inside = (path: string) => { const part = relative(root, path); return part === '' || (!part.startsWith('..') && !isAbsolute(part)) }
        for (const path of new Set([...remote, ...local])) {
          abortSignal?.throwIfAborted()
          const destination = join(root, path)
          let parent = dirname(destination)
          while (!await lstat(parent).catch(() => undefined)) parent = dirname(parent)
          if (!inside(await realpath(parent))) throw new Error('[placement] Box import destination must stay inside the checkout.')
          const source = join(scratch, path)
          const entry = await lstat(source).catch(() => undefined)
          if (entry?.isDirectory()) continue
          await rm(destination, { force: true })
          if (!entry) continue
          await mkdir(dirname(destination), { recursive: true })
          if (!inside(await realpath(dirname(destination)))) throw new Error('[placement] Box import destination changed during transfer.')
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
        log('placement.box.refreshed', { host: options.host, box: id, skipped: true, totalMs: 0 })
        return
      }
      const startedAt = Date.now()
      installedInputs = undefined
      await uploadPaths(checkout, paths, abortSignal)
      if (await install(checkout, abortSignal, false)) installedInputs = inputs
      log('placement.box.refreshed', { host: options.host, box: id, skipped: false, totalMs: Date.now() - startedAt })
    },
    async close() {
      return closing ??= (async () => {
        const startedAt = Date.now()
        const kill = (signalName: string) => `for f in ${q(run)}/*.pid; do test -f "$f" && kill -s ${signalName} -- "-$(cat "$f")" 2>/dev/null; done; true`
        await runScript(transport, `${kill('TERM')}; sleep 2; ${kill('KILL')}; ${killOwnBox(options.root, id)}`, { timeout: 30_000 }).catch(() => undefined)
        await runScript(transport, `chmod -R u+w ${q(directory)} 2>/dev/null; rm -rf ${q(directory)}`, { timeout: 60_000 }).catch(() => undefined)
        log('placement.box.closed', { host: options.host, box: id, totalMs: Date.now() - startedAt })
        for (const child of live) child.kill('SIGKILL')
        options.onClose?.(id)
      })()
    },
  }
  return session
}

/** Kills the processes of one Box by its Home, including tool commands Codex started in their own sessions. */
function killOwnBox(root: string, id: string) {
  return `for e in /proc/[0-9]*/environ; do tr '\\0' '\\n' 2>/dev/null < "$e" | grep -qxF ${q(`HOME=${root}/boxes/${id}/home`)} && { p=\${e#/proc/}; kill -s KILL "\${p%/environ}" 2>/dev/null; }; done; true`
}
