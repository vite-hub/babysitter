import { github as githubSource } from 'vite-hub/workspace'
import { codexDriver, defineAgent } from 'vite-hub/agent'
import { diagnostics, title, skills } from 'vite-hub/agent/capabilities'
import { nodeRuntimeResources } from 'vite-hub/runtime/node'
import { consoleClient } from '../../console.ts'
import { github as githubHost } from '../../github.ts'
import { host } from '../../host.ts'

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
    source: githubSource({ repo: 'vite-hub/vitehub', ref: 'e2b541722b9a46d957a082c8319af1afc4bdcc3e', root: `docs/skills/${name}`, include: ['SKILL.md', 'references/**'], materialize: 'build' }),
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
  env: async () => ({ ...await githubHost.environment(), NODE_OPTIONS: '--max-old-space-size=1024' }),
  model: 'gpt-6-astra',
  output: { schema: passResultSchema },
  permissions: 'allow-all',
  sessionStorePath: host.providerSessionStorePath,
  reasoningEffort: 'medium',
})

const agent = defineAgent({
  capabilities,
  channels: {
    github: githubHost.channel({ activity: true }),
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
