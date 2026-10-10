import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function initializeWorkerMemory(parent: string) {
  const controllers = (await readFile(join(parent, 'cgroup.controllers'), 'utf8')).trim().split(/\s+/)
  if (!controllers.includes('memory')) {
    throw new Error('Worker cgroup parent must delegate the memory controller')
  }
  if ((await readFile(join(parent, 'cgroup.procs'), 'utf8')).trim()) {
    throw new Error('Worker controller must run in a separate cgroup subgroup')
  }
  // Delegate=memory makes the controller available. Enable it for children
  // before admission samples the controller, rather than waiting for the first Box.
  await writeFile(join(parent, 'cgroup.subtree_control'), '+memory')
}
