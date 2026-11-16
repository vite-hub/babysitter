// Runs shell scripts on a placement host over SSH, and reverse-forwards loopback ports of this
// process to it. Ported from the ServaRICA fleet that babysitter 9e8791e4 removed.
import { spawn, type ChildProcessByStdio, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants } from 'node:os'
import type { Readable, Writable } from 'node:stream'

/** Loopback ports of this process reachable on the host, keyed by local port. */
export interface SshTunnel {
  readonly ports: ReadonlyMap<number, number>
  close(): void
}

/** Starts a POSIX shell script on one host. */
export interface ScriptTransport {
  start(script: string): ChildProcessWithoutNullStreams
  /**
   * Forward local loopback ports to free host ports. A fixed host port can be taken by another
   * tunnel or another pass, so the host picks each port.
   */
  tunnel?(ports: readonly number[]): Promise<SshTunnel>
}

export function sshTransport(options: { target: string, controlDirectory: string, knownHosts: string, connectTimeoutSeconds?: number }): ScriptTransport {
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
      return spawn('ssh', [...base, '-o', 'LogLevel=ERROR', '-o', 'ControlMaster=auto', '-o', `ControlPath=${options.controlDirectory}/%C`, '-o', 'ControlPersist=300', options.target, '--', script], { stdio: 'pipe' })
    },
    tunnel(ports) {
      if (!ports.length) return Promise.resolve({ ports: new Map(), close() {} })
      // A tunnel belongs to one provider process and closes with it. Each forward listens on the host's
      // loopback only, whatever GatewayPorts says. ssh reports each host port at INFO level.
      const child = spawn('ssh', [...base, '-o', 'LogLevel=INFO', '-S', 'none', '-N', '-o', 'ExitOnForwardFailure=yes', ...ports.flatMap(port => ['-R', `127.0.0.1:0:127.0.0.1:${port}`]), options.target], { stdio: ['ignore', 'ignore', 'pipe'] })
      return new Promise((resolve, reject) => {
        const mapped = new Map<number, number>()
        let stderr = ''
        const fail = (message: string) => { clearTimeout(timer); child.kill('SIGTERM'); reject(new Error(`[placement] Tunnel to ${options.target} failed: ${message}`)) }
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
export function localTransport(): ScriptTransport {
  return { start: script => spawn('sh', ['-c', script], { stdio: 'pipe' }) }
}

export const q = (value: string) => `'${value.replaceAll('\'', `'"'"'`)}'`

export interface RunResult { code: number, stdout: Buffer, stderr: string }

export async function runScript(transport: ScriptTransport, script: string, options: { input?: Uint8Array | Readable, signal?: AbortSignal, timeout?: number } = {}): Promise<RunResult> {
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
  if (options.input && 'pipe' in options.input) options.input.pipe(child.stdin)
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

export function exitCode(child: ChildProcessWithoutNullStreams) {
  return new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve(code ?? 128 + (signal ? constants.signals[signal] ?? 1 : 1)))
  })
}

export async function must(transport: ScriptTransport, script: string, what: string, options: Parameters<typeof runScript>[2] = {}) {
  const result = await runScript(transport, script, options)
  if (result.code !== 0) throw new Error(`[placement] ${what} failed (${result.code}): ${result.stderr.trim().slice(-2000)}`)
  return result
}

/**
 * Runs `consume` with the stdout of a local producer, such as a `tar` that feeds an SSH upload. A
 * producer blocks on a full pipe when the remote end stops reading, so a failed `consume` kills it,
 * and the call fails when the producer fails or has not finished `drainMs` after `consume`.
 */
export async function withProducer<T>(command: string, args: readonly string[], options: { input?: string, drainMs?: number }, consume: (stdout: Readable) => Promise<T>): Promise<T> {
  const child = spawn(command, args, { stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }) as ChildProcessByStdio<Writable | null, Readable, Readable>
  child.stdin?.on('error', () => {})
  child.stdin?.end(options.input)
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2000) })
  const exited = new Promise<number>((resolve) => {
    child.once('error', () => resolve(127))
    // 'close' would also wait for stdout, which stays open while a failed upload leaves it paused.
    child.once('exit', (code, signal) => resolve(code ?? 128 + (signal ? constants.signals[signal] ?? 1 : 1)))
  })
  try {
    const result = await consume(child.stdout)
    let timer: NodeJS.Timeout | undefined
    const code = await Promise.race([exited, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), options.drainMs ?? 30_000) })]).finally(() => clearTimeout(timer))
    if (code === undefined) throw new Error(`[placement] ${command} did not finish after the upload ended.`)
    if (code !== 0) throw new Error(`[placement] ${command} exited ${code}: ${stderr.trim()}`)
    return result
  }
  catch (error) {
    child.kill('SIGKILL')
    child.stdout.destroy()
    await exited
    throw error
  }
}
