import { createProcessAgentHost } from 'vite-hub/agent/runtime/process'
import { defaultMaxOwners, resolveMaxOwners } from './babysitter.queue.ts'

const concurrency = resolveMaxOwners(process.env.BABYSITTER_MAX_OWNERS || defaultMaxOwners)

export const host = await createProcessAgentHost({
  name: 'babysitter',
  providerCommand: 'codex',
  capacity: {
    concurrency,
    fallbackConcurrency: Math.min(3, concurrency),
    queue: { maxPending: 100 },
    sampleTimeoutMs: 5_000,
  },
  async run(reason, context, accepting) {
    const { reconcileBabysitterWork } = await import('./babysitter.schedule.ts')
    await reconcileBabysitterWork(reason, context, accepting)
  },
})
export default host
