// Runs shell scripts on a placement host over SSH, and reverse-forwards loopback ports of this
// process to it. Ported from the ServaRICA fleet that babysitter 9e8791e4 removed.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants } from 'node:os'
import type { Readable } from 'node:stream'

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
      // A tunnel belongs to one provider process and closes with it. ssh reports each host port at INFO level.
      const child = spawn('ssh', [...base, '-o', 'LogLevel=INFO', '-S', 'none', '-N', '-o', 'ExitOnForwardFailure=yes', ...ports.flatMap(port => ['-R', `0:127.0.0.1:${port}`]), options.target], { stdio: ['ignore', 'ignore', 'pipe'] })
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
