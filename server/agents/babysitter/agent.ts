import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
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
import { credentialsForRepository } from '../../babysitter.github-credentials.ts'
import { pullRequestInbox } from '../../babysitter.inbox-runtime.ts'
import { createProviderProofLaunch, providerGitEnvironment } from '../../babysitter.provider-checkout.ts'
import { workerInstructions } from './instructions.ts'

if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.VITEHUB_GITHUB_TOKEN) {
  throw new Error('Babysitter must start without personal GitHub tokens; configure vitehub-bot App installations instead')
}

export const github = createGitHubHost({
  // Reuse one warm clone per active PR slot: dependencies and build output
  // survive between passes, so a pass fetches one head instead of cloning.
  checkouts: { root: process.env.BABYSITTER_CHECKOUT_ROOT || resolve('.vitehub/checkouts') },
  credentials: ({ repository }) => credentialsForRepository(
    useServerEnv().github,
    repository,
    process.env.GITHUB_APP_INSTALLATIONS,
  ),
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
  // The health probe resolves codex from the service PATH, the same lookup
  // invocations use. A hardcoded host path broke when codex moved.
  providerCommand: 'codex',
  capacity: {
    concurrency,
    fallbackConcurrency: concurrency,
    // Workers mostly wait on the model. A pass start (clone and Workspace
    // sync) raises this unit's CPU pressure above the 25% default for about
    // 25 s, which paused every admission. Pause only on severe CPU pressure.
    cpu: { pausePressure: 0.9, resumePressure: 0.6 },
    // The host always uses swap, so memory pressure rarely reaches the 1%
    // default resume level. Pause on real thrashing and resume once it eases.
    memory: { pausePressure: 0.25, resumePressure: 0.1 },
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
  skills({
    id: 'skills.code-review',
    path: 'skills/code-review',
    shellExecution: 'write',
  }),
  skills({
    id: 'skills.resolving-merge-conflicts',
    path: 'skills/resolving-merge-conflicts',
    shellExecution: 'write',
  }),
  diagnostics({ resources: nodeRuntimeResources() }), title({
  execute: ({ input }) => {
    const context = input.context as { pullRequestTitle: string }
    return context.pullRequestTitle
  },
}), ...(consoleClient ? [consoleClient.capability] : []), telemetry.capability] as const
// Caps concurrent typecheck/test processes across workers (scripts/heavy-command-gate.cjs).
const heavyCommandGate = [
  process.env.BABYSITTER_HEAVY_GATE,
  process.argv[1] ? resolve(dirname(process.argv[1]), '../../scripts/heavy-command-gate.cjs') : undefined,
].find((path): path is string => Boolean(path && existsSync(path)))
async function workerEnvironment(repository?: string) {
      if (!repository) throw new Error('Babysitter worker requires a GitHub repository')
      const githubEnv = providerGitEnvironment((await github.access({ repository })).env)
      return {
        ...githubEnv,
        ...(repository ? { GH_REPO: repository } : {}),
        // The worker wrapper routes `gh` API calls through ghx.onmax.me. Keep
        // GH_HOST unset here so Git's github.com credential helper can match
        // the checkout remote while still receiving the App token below.
        // Keep worker subprocesses aligned with the agents user's global ghx
        // wrapper. The system PATH applies the same proxy to other agents.
        PATH: [...heavyCommandGate ? [resolve(dirname(heavyCommandGate), 'worker-bin')] : [], '/home/agents/.local/worker-ghx/bin', process.env.PATH || '/usr/local/bin:/usr/bin:/bin'].join(':'),
        GHX_GH_PATH: '/usr/bin/gh',
        ...(process.env.CLIPROXY_API_KEY ? { CLIPROXY_API_KEY: process.env.CLIPROXY_API_KEY } : {}),
        ...(process.env.OPENAI_BASE_URL ? { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL } : {}),
        NODE_OPTIONS: ['--max-old-space-size=1024', ...heavyCommandGate ? ['--require', heavyCommandGate] : []].join(' '),
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
    model: 'gpt-6.1-sol',
    output: { schema: passResultSchema },
    permissions: 'allow-all',
    // Persist the provider resume cursor. The scheduler scopes the transport
    // thread to the exact PR head before each invocation, so a changed head
    // cannot resume a session created for a different checkout.
    sessionStorePath: host.providerSessionStorePath,
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
  // Declare sources once on the workspace. Discovery decorates this definition
  // again at startup, so capability-contributed sources would be added twice.
  workspace: {
    mode: 'write',
    sources: {
      'skill.code-review': {
        mount: 'skills/code-review',
        source: githubSource({
          repo: 'vite-hub/vitehub',
          ref: '724a19c68157518d1ec67b3129af44488ce7e784',
          root: 'docs/skills/code-review',
          include: ['SKILL.md', 'references/**'],
          materialize: 'build',
        }),
      },
      'skill.resolving-merge-conflicts': {
        mount: 'skills/resolving-merge-conflicts',
        source: githubSource({
          repo: 'mattpocock/skills',
          ref: '74ca5fe077456a0b3b2f5310cf9430999fd0b5fd',
          root: 'skills/engineering/resolving-merge-conflicts',
          include: ['SKILL.md', 'agents/openai.yaml'],
          materialize: 'build',
        }),
      },
    },
  },
})

export const workspace = createGitHubInvocationWorkspaceHandler({ host: github, invocations: host.invocations })
const healthRepository = resolveRepositories(useServerEnv().babysitter.repositories, useServerEnv().babysitter.repository)[0]
const healthGithub = {
  ...github,
  access: (input: Parameters<typeof github.access>[0] = {}) => github.access({
    ...input,
    fallback: false,
    repository: healthRepository,
  }),
}
export const health = createAgentHealth({
  name: 'Babysitter', agent: () => agent, process: host, github: healthGithub,
  console: () => Boolean(consoleClient),
  async workload() { return (await import('../../babysitter.schedule.ts')).babysitterWorkload() },
  diagnostics() {
    const config = useServerEnv().babysitter
    const queue = pullRequestInbox.summary()
    const waiting = queue.filter(item => item.status === 'waiting').length
    const readyItems = queue.filter(item => item.status === 'ready')
    // A stacked child is intentionally parked until its open parent advances.
    // Report that distinction so an empty worker pool is explainable instead
    // of looking like the scheduler lost the PRs.
    const blocked = readyItems.filter(item => item.baseRef && queue.some(parent =>
      parent.repository === item.repository && parent.number !== item.number
      && String(parent.state).toLowerCase() === 'open'
      && parent.headRef === item.baseRef)).length
    const ready = readyItems.length - blocked
    const retrying = queue.filter(item => item.attempts >= 3 && item.status !== 'terminal').length
    const repositories = resolveRepositories(config.repositories, config.repository)
    return [
      { label: 'Release', status: 'ok', value: usePublicEnv().releaseRevision },
      { label: 'Repositories', status: 'ok', value: `${repositories.length} configured`, detail: repositories.join(', ') },
      { label: 'Work discovery', status: 'ok', value: 'Durable PR inbox', detail: 'Webhooks and local 10s retry timer; REST recovery every 15–30m' },
      { label: 'PR queue', status: retrying || blocked ? 'warning' : 'ok', value: `${ready} ready · ${waiting} waiting`, detail: `${blocked} blocked by open stack parents · ${retrying} PRs with repeated unsuccessful passes` },
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
  // The HTTP server keeps normal operation alive; the retry timer must not
  // keep the drained process alive after graceful HTTP shutdown.
  setInterval(() => host.wake(), 10_000).unref()
}, 0)

export function createBabysitterAgent(checkout: string, repository: string, onProviderPrepared?: (cwd: string, proofPath: string) => void) {
  if (!checkout) throw new Error('Babysitter requires a checkout.')
  return defineAgent({
    extends: agent,
    // Give per-PR runs their own identity so PostHog's agent_name filter can
    // distinguish worker activity from the long-lived scheduler process.
    name: 'babysitter-worker',
    driver: {
      ...babysitterDriver,
      instructions: ({ fs }) => workerInstructions(fs),
      env: () => workerEnvironment(repository),
      // Run Codex in the prepared clone itself. It already has the PR head and
      // Git metadata, so the driver skips the copy, snapshots, and write-back.
      cwd: checkout,
      // Provision the Node and package manager that the PR's repository pins
      // instead of trusting whatever the host has on PATH.
      toolchain: { node: 'project', packageManager: 'project', fallbackNode: '24' },
      async launch({ cwd, command, purpose }) {
        // Readiness inspection only needs the executable.
        if (purpose === 'inspection') return { command }
        const launch = await createProviderProofLaunch(checkout, cwd, command)
        onProviderPrepared?.(cwd, launch.proofPath)
        return { command: launch.command, args: launch.args }
      },
    },
    workspace: {
      // The Workspace reads the same clone that Codex edits (driver.cwd).
      commit: false,
      mode: 'write',
      // Each pass owns its clone, so path locks stay in memory. Warm clones keep
      // node_modules and build output; Git-ignored paths stay out of snapshots.
      store: { provider: 'local', root: checkout, locks: 'process', ignore: 'git' },
    },
  })
}

export default agent
