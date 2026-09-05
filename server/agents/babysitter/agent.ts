import { github as githubSource } from 'vite-hub/workspace'
import { codexDriver, defineAgent } from 'vite-hub/agent'
import { diagnostics, title, skills } from 'vite-hub/agent/capabilities'
import { nodeRuntimeResources } from 'vite-hub/runtime/node'
import { useServerEnv } from '#vitehub/env/server'
import { createGitHubHost } from '@vite-hub/agent/server/github'
import { createAgentConsoleDelivery } from 'vite-hub/agent/server'
import { createProcessAgentHost } from 'vite-hub/agent/runtime/process'
import { defaultMaxOwners, resolveMaxOwners } from '../../babysitter.queue.ts'

export const github = createGitHubHost({
  credentials: () => useServerEnv().github,
  identity: {
    email: '320448255+vitehub-bot[bot]@users.noreply.github.com',
    login: 'vitehub-bot[bot]',
  },
})

export const consoleClient = createAgentConsoleDelivery(useServerEnv().console)

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
    const { reconcileBabysitterWork } = await import('../../babysitter.schedule.ts')
    await reconcileBabysitterWork(reason, context, accepting)
  },
})

export type PassResult = { disposition: 'park' | 'retry', text: string }
const passResultSchema = {
  '~standard': {
    version: 1 as const,
    vendor: 'babysitter',
    validate(value: unknown) {
      if (value && typeof value === 'object' && 'disposition' in value && 'text' in value
        && (value.disposition === 'park' || value.disposition === 'retry')
        && typeof value.text === 'string' && value.text.trim()) {
        return { value: { disposition: value.disposition, text: value.text } as PassResult }
      }
      return { issues: [{ message: 'Expected a park/retry disposition and a non-empty text result.' }] }
    },
  },
}

const capabilities = [
  ...['code-review', 'resolving-merge-conflicts'].map(name => skills({
    id: `skills.${name}`,
    path: `skills/${name}`,
    source: githubSource({ repo: 'vite-hub/vitehub', ref: '724a19c68157518d1ec67b3129af44488ce7e784', root: `docs/skills/${name}`, include: ['SKILL.md', 'references/**'], materialize: 'build' }),
    shellExecution: 'write',
  })),
  diagnostics({ resources: nodeRuntimeResources() }), title({
  execute: ({ input }) => {
    const context = input.context as { pullRequestTitle: string }
    return context.pullRequestTitle
  },
}), ...(consoleClient ? [consoleClient.capability] : [])] as const
const driver = codexDriver({
  capacity: host.capacity,
  env: async () => ({ ...await github.environment(), NODE_OPTIONS: '--max-old-space-size=1024' }),
  model: 'gpt-6-astra',
  output: { schema: passResultSchema },
  permissions: 'allow-all',
  sessionStorePath: host.providerSessionStorePath,
  reasoningEffort: 'medium',
})

const agent = defineAgent({
  capabilities,
  channels: {
    github: github.channel({ activity: true }),
  },
  driver,
  invocations: host.invocations,
  name: 'babysitter',
})

export function createBabysitterAgent(checkout: string) {
  if (!checkout) throw new Error('Babysitter requires a checkout.')
  return defineAgent({
    extends: agent,
    name: 'babysitter',
    workspace: {
      commit: true,
      mode: 'write',
      store: { provider: 'local', root: checkout },
    },
  })
}

export default agent
