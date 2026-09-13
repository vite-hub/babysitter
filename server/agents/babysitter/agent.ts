import { defineAgent, type CodexDriverOptions } from 'vite-hub/agent'
import { babysitter, type BabysitterPassResult } from 'vite-hub/agent/presets/babysitter'
import { diagnostics, title } from 'vite-hub/agent/capabilities'
import { createAgentEvlog } from 'vite-hub/agent/evlog'
import { posthogAgentExporter } from 'vite-hub/agent/evlog/posthog'
import { nodeRuntimeResources } from 'vite-hub/runtime/node'
import { usePublicEnv } from '#vitehub/env/public'
import { useServerEnv } from '#vitehub/env/server'
import { createGitHubHost, createGitHubInvocationWorkspaceHandler } from 'vite-hub/agent/server/github'
import { createAgentConsoleDelivery, createAgentHealth } from 'vite-hub/agent/server'
import { createProcessAgentHost } from 'vite-hub/agent/runtime/process'
import { resolveMaxOwners, resolveRepositories } from '../../babysitter.config.ts'
import { parseGitHubInstallations } from '../../babysitter.github.ts'

const installations = parseGitHubInstallations(useServerEnv().github.installations)

export const github = createGitHubHost({
  credentials: ({ repository }) => {
    const config = useServerEnv().github
    const owner = repository?.split('/')[0]?.toLowerCase()
    const installationId = owner ? installations[owner] : undefined
    return installationId ? { ...config, owner, installationId } : config
  },
  identity: {
    email: '320448255+vitehub-bot[bot]@users.noreply.github.com',
    login: 'vitehub-bot[bot]',
  },
})

export const consoleClient = createAgentConsoleDelivery(useServerEnv().console)
const observabilityConfig = useServerEnv().observability
export const telemetry = createAgentEvlog({
  service: 'babysitter',
  environment: observabilityConfig.environment,
  // Keep scheduler and per-PR worker telemetry in the same PostHog project.
  // The worker's runtime identity is added automatically by ViteHub.
  metadata: { agent_family: 'babysitter' },
  level: 'standard',
  ...(observabilityConfig.posthogApiKey ? {
    exporter: posthogAgentExporter({
      apiKey: observabilityConfig.posthogApiKey.unseal(),
      host: observabilityConfig.posthogHost,
      service: 'babysitter',
    }),
  } : {}),
})

const concurrency = resolveMaxOwners(useServerEnv().babysitter.maxOwners)

export const host = await createProcessAgentHost({
  name: 'babysitter',
  intervalMs: 10_000,
  // The production process runs under the restricted `agents` account, whose
  // PATH does not include the global Node bin directory consistently. Use the
  // installed CLI's absolute path so the process health probe and invocations
  // resolve the same executable as the CLI-proxy setup.
  providerCommand: '/usr/bin/codex',
  capacity: {
    concurrency,
    fallbackConcurrency: Math.min(3, concurrency),
    queue: { maxPending: 100 },
    sampleTimeoutMs: 5_000,
  },
  async run(reason, context, accepting) {
    const { runtime } = await import('../../babysitter.runtime.ts')
    await runtime.reconcile(reason, context, accepting)
  },
})

const capabilities = [
  diagnostics({ resources: nodeRuntimeResources() }),
  title({
    execute: ({ input }) => {
      const context = input.context as { pullRequestTitle: string }
      return context.pullRequestTitle
    },
  }),
  ...(consoleClient ? [consoleClient.capability] : []),
  telemetry.capability,
] as const

function workerEnvironment() {
  return {
    ...(process.env.CLIPROXY_API_KEY ? { CLIPROXY_API_KEY: process.env.CLIPROXY_API_KEY } : {}),
    ...(process.env.OPENAI_BASE_URL ? { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL } : {}),
    NODE_OPTIONS: '--max-old-space-size=1024',
  }
}
const babysitterDriver: CodexDriverOptions<BabysitterPassResult> & { kind: 'codex' } = {
  kind: 'codex',
  capacity: host.capacity,
  // The service cannot read the interactive user's Codex configuration.
  env: workerEnvironment,
  model: 'gpt-6-astra',
  permissions: 'allow-edits',
  reasoningEffort: 'medium',
}

const agent = defineAgent({
  preset: 'babysitter',
  presets: { babysitter },
  options: {
    filter: { author: { allow: ['onmax'] } },
    autoMerge: false,
  },
  capabilities,
  channels: {
    github: github.channel({ activity: true, pullRequest: false, webhooks: false }),
  },
  driver: babysitterDriver,
  invocations: host.invocations,
  name: 'babysitter',
  version: usePublicEnv().releaseRevision,
})

export const workspace = createGitHubInvocationWorkspaceHandler({ host: github, invocations: host.invocations })
export const health = createAgentHealth({
  name: 'Babysitter', agent: () => agent, process: host, github,
  console: () => Boolean(consoleClient),
  async workload() { return (await import('../../babysitter.runtime.ts')).runtime.workload() },
  async diagnostics() {
    const config = useServerEnv().babysitter
    const { runtime } = await import('../../babysitter.runtime.ts')
    const queue = runtime.inbox.summary()
    const waiting = queue.filter(item => item.status === 'waiting').length
    const ready = queue.filter(item => item.status === 'ready').length
    const retrying = queue.filter(item => item.attempts >= 3 && item.status !== 'terminal').length
    const repositories = resolveRepositories(config.repositories, config.repository)
    return [
      { label: 'Release', status: 'ok', value: usePublicEnv().releaseRevision },
      { label: 'Repositories', status: 'ok', value: `${repositories.length} configured`, detail: repositories.join(', ') },
      { label: 'Work discovery', status: 'ok', value: 'Durable PR inbox', detail: 'Webhooks and local 10s retry timer; REST recovery every 15–30m' },
      { label: 'PR queue', status: retrying ? 'warning' : 'ok', value: `${ready} ready · ${waiting} waiting`, detail: `${retrying} PRs with repeated unsuccessful passes` },
    ]
  },
})

export default agent
