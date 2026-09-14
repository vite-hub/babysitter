import { github as githubSource } from 'vite-hub/workspace'
import { defineAgent, type CodexDriverOptions } from 'vite-hub/agent'
import { diagnostics, title, skills } from 'vite-hub/agent/capabilities'
import { createAgentEvlog } from 'vite-hub/agent/evlog'
import { posthogAgentExporter } from 'vite-hub/agent/evlog/posthog'
import { nodeRuntimeResources } from 'vite-hub/runtime/node'
import { usePublicEnv } from '#vitehub/env/public'
import { useServerEnv } from '#vitehub/env/server'
import { createGitHubHost, createGitHubInvocationWorkspaceHandler } from 'vite-hub/agent/server/github'
import { createAgentConsoleDelivery, createAgentHealth } from 'vite-hub/agent/server'
import { createProcessAgentHost } from 'vite-hub/agent/runtime/process'
import { resolveMaxOwners, resolveRepositories } from '../../babysitter.queue.ts'
import { pullRequestInbox } from '../../babysitter.inbox-runtime.ts'
import { prepareProviderGit, createProviderProofLaunch, providerGitEnvironment } from '../../babysitter.provider-checkout.ts'

export const github = createGitHubHost({
  credentials: () => useServerEnv().github,
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
    const { reconcileBabysitterWork } = await import('../../babysitter.schedule.ts')
    await reconcileBabysitterWork(reason, context, accepting)
  },
})


export type { PassResult } from '../../babysitter.pass-result.ts'
import { passResultSchema, type PassResult } from '../../babysitter.pass-result.ts'

const capabilities = [
  ...['code-review'].map(name => skills({
    id: `skills.${name}`,
    path: `skills/${name}`,
    source: githubSource({ repo: 'vite-hub/vitehub', ref: '724a19c68157518d1ec67b3129af44488ce7e784', root: `docs/skills/${name}`, include: ['SKILL.md', 'references/**'], materialize: 'build' }),
    shellExecution: 'write',
  })),
  // Keep this skill colocated with the Babysitter agent so every worker
  // invocation receives the same conflict-resolution procedure as the code.
  skills({ id: 'skills.resolving-merge-conflicts', path: 'skills/resolving-merge-conflicts',
    source: githubSource({ repo: 'vite-hub/babysitter', ref: 'daa9c7ca72fef22a7b139961489efc844a1e69b4', root: 'server/agents/babysitter/skills/resolving-merge-conflicts', include: ['SKILL.md', 'references/**'], materialize: 'build' }),
    shellExecution: 'write' }),
  diagnostics({ resources: nodeRuntimeResources() }), title({
  execute: ({ input }) => {
    const context = input.context as { pullRequestTitle: string }
    return context.pullRequestTitle
  },
}), ...(consoleClient ? [consoleClient.capability] : []), telemetry.capability] as const
async function workerEnvironment(repository?: string) {
      const githubEnv = providerGitEnvironment(await github.environment())
      return {
        ...githubEnv,
        ...(repository ? { GH_REPO: repository } : {}),
        // The worker wrapper routes `gh` API calls through ghx.onmax.me. Keep
        // GH_HOST unset here so Git's github.com credential helper can match
        // the checkout remote while still receiving the App token below.
        // Keep worker subprocesses aligned with the agents user's global ghx
        // wrapper. The system PATH applies the same proxy to other agents.
        PATH: `/home/agents/.local/worker-ghx/bin:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
        GHX_GH_PATH: '/usr/bin/gh',
        ...(process.env.CLIPROXY_API_KEY ? { CLIPROXY_API_KEY: process.env.CLIPROXY_API_KEY } : {}),
        ...(process.env.OPENAI_BASE_URL ? { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL } : {}),
        NODE_OPTIONS: '--max-old-space-size=1024',
      }
}
const babysitterDriver: CodexDriverOptions<PassResult> & { kind: 'codex' } = {
    kind: 'codex',
    capacity: host.capacity,
    // Keep the provider selection explicit for the non-interactive CLI. The
    // service runs as `agents`, so it cannot see the interactive user's
    // ~/.codex/config.toml. These variables are supplied by the service
    // environment and make Codex use the local CLIProxy pool.
    env: () => workerEnvironment(),
    model: 'gpt-6-astra',
    output: { schema: passResultSchema },
    permissions: 'allow-all',
    // Every PR pass gets a fresh checkout and a fresh provider workspace.
    // Reusing the persistent Codex thread here resurrects deleted
    // /tmp/vitehub-provider-* paths and leaves the agent without a remote.
    // The webhook snapshot is the durable PR memory; provider sessions are
    // intentionally ephemeral per invocation.
    reasoningEffort: 'medium',
  }

const agent = defineAgent({
  capabilities,
  channels: {
    github: github.channel({ activity: true }),
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
  async workload() { return (await import('../../babysitter.schedule.ts')).babysitterWorkload() },
  diagnostics() {
    const config = useServerEnv().babysitter
    const queue = pullRequestInbox.summary()
    const waiting = queue.filter(item => item.status === 'waiting').length
    const ready = queue.filter(item => item.status === 'ready').length
    const retrying = queue.filter(item => item.attempts >= 3 && item.status !== 'terminal').length
    const repositories = resolveRepositories(config.repositories, config.repository)
    return [
      { label: 'Release', status: 'ok', value: usePublicEnv().releaseRevision },
      { label: 'Repositories', status: 'ok', value: `${repositories.length} configured`, detail: repositories.join(', ') },
      { label: 'Work discovery', status: 'ok', value: 'Durable PR inbox', detail: 'Webhook intake with hourly reconciliation' },
      { label: 'PR queue', status: retrying ? 'warning' : 'ok', value: `${ready} ready · ${waiting} waiting`, detail: `${retrying} PRs with repeated unsuccessful passes` },
    ]
  },
})

// Let module initialization finish before waking: the scheduler imports this
// agent module, so an eager wake here would be lost during the circular load.
// Keep a lightweight heartbeat as a safety net for durable ready work. The
// scheduler's inbox/coalescing gates make this an admission check, not a model
// invocation; CI/review waits remain parked until a relevant webhook arrives.
setTimeout(() => {
  host.wake()
  // Wake the process host often enough to drain durable ready work. The
  // scheduler still owns admission, deduplication, and CI waiting.
  setInterval(() => host.wake(), 10_000)
  let reconciling = false
  setInterval(() => {
    if (reconciling) return
    reconciling = true
    void import('../../babysitter.schedule.ts').then(({ reconcileBabysitterWork }) =>
      reconcileBabysitterWork('timer', { track: promise => promise }),
    ).catch(error => host.error('babysitter.timer.failed', error))
      .finally(() => { reconciling = false })
  }, 15_000)
}, 5_000)

export function createBabysitterAgent(checkout: string, repository: string, onProviderPrepared?: (cwd: string, proofPath: string) => void) {
  if (!checkout) throw new Error('Babysitter requires a checkout.')
  return defineAgent({
    extends: agent,
    // Give per-PR runs their own identity so PostHog's agent_name filter can
    // distinguish worker activity from the long-lived scheduler process.
    name: 'babysitter-worker',
    driver: {
      ...babysitterDriver,
      env: () => workerEnvironment(repository),
      async launch({ cwd, command }) {
        await prepareProviderGit(checkout, cwd)
        const launch = await createProviderProofLaunch(checkout, cwd, command)
        onProviderPrepared?.(cwd, launch.proofPath)
        return { command: launch.command, args: launch.args }
      },
    },
    workspace: {
      // Repairs and pushes happen in the provider checkout with restored Git
      // metadata. Do not copy its files back into the preparation clone.
      commit: false,
      mode: 'write',
      store: { provider: 'local', root: checkout },
    },
  })
}

export default agent
