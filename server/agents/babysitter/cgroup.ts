// Passes (codex, pnpm install, git clone) are children of the main process, so they share its
// cgroup: their page cache evicts the state database's pages and their dirty pages count against
// the main thread's writeback budget, which froze webhooks for 20–90 s at a time (2026-11-21).
// With systemd's `Delegate=yes` and `DelegateSubgroup=main`, the service owns its cgroup subtree,
// so this moves every other process from the main process's leaf into a sibling cgroup.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface PassCgroupOptions {
  /** Name of the sibling cgroup that holds the passes, such as `passes`. */
  name: string
  /** Written to the main leaf's memory.low, such as `6G`, so pass memory pressure reclaims pass pages first. */
  mainMemoryLow?: string
  intervalMs?: number
  pid?: number
  cgroupRoot?: string
  selfCgroup?: string
  log?(event: string, fields: Record<string, unknown>): void
}

export interface PassCgroup {
  main: string
  passes: string
  /** Moves every process in the main leaf except this one; returns the pids it moved. */
  sweep(): Promise<number[]>
  stop(): void
}

export async function startPassCgroup(options: PassCgroupOptions): Promise<PassCgroup> {
  const log = options.log ?? ((event, fields) => console.log(`[cgroup] ${event} ${JSON.stringify(fields)}`))
  const pid = options.pid ?? process.pid
  const own = (await readFile(options.selfCgroup ?? '/proc/self/cgroup', 'utf8')).split('\n').find(line => line.startsWith('0::'))?.slice(3)
  if (!own || own === '/') throw new Error('[cgroup] this process is not in a cgroup v2 leaf')
  const main = join(options.cgroupRoot ?? '/sys/fs/cgroup', own)
  const parent = dirname(main)
  const passes = join(parent, options.name)
  if (passes === main) throw new Error(`[cgroup] this process already runs in ${main}; set DelegateSubgroup= to another name`)
  await mkdir(passes, { recursive: true })
  for (const controller of ['memory', 'cpu', 'io']) {
    await writeFile(join(parent, 'cgroup.subtree_control'), `+${controller}`).catch((error: Error) => log('controller.unavailable', { controller, error: error.message }))
  }
  if (options.mainMemoryLow) await writeFile(join(main, 'memory.low'), options.mainMemoryLow)

  let running = false
  const sweep = async () => {
    if (running) return []
    running = true
    const moved: number[] = []
    try {
      const pids = (await readFile(join(main, 'cgroup.procs'), 'utf8')).split('\n').map(Number).filter(other => other > 0 && other !== pid)
      for (const other of pids) {
        // ESRCH: the process exited between the read and the move.
        await appendFile(join(passes, 'cgroup.procs'), `${other}\n`).then(() => moved.push(other), (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ESRCH') log('move.failed', { pid: other, error: error.message })
        })
      }
    }
    finally {
      running = false
    }
    return moved
  }
  // A pass forks often (pnpm, git), and a child forked before its parent moved stays behind until the next sweep.
  const timer = setInterval(() => void sweep().catch((error: Error) => log('sweep.failed', { error: error.message })), options.intervalMs ?? 1_000)
  timer.unref()
  log('started', { main, passes, mainMemoryLow: options.mainMemoryLow ?? null })
  return { main, passes, sweep, stop: () => clearInterval(timer) }
}

const registryKey = Symbol.for('babysitter.passCgroup')

/** Starts the mover once per process when BABYSITTER_PASS_CGROUP names the sibling cgroup. */
export function passCgroupFromEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const name = environment.BABYSITTER_PASS_CGROUP
  if (!name) return
  const registry = globalThis as { [key: symbol]: Promise<PassCgroup | undefined> | undefined }
  registry[registryKey] ??= startPassCgroup({ name, mainMemoryLow: environment.BABYSITTER_MAIN_MEMORY_LOW || undefined }).catch((error: Error) => {
    // Passes then share the main cgroup, as they did before; the service keeps working.
    console.error(`[cgroup] passes stay in the main cgroup: ${error.message}`)
    return undefined
  })
}
