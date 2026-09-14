import { resolve } from 'node:path'
import { getAgentFromRegistry } from 'vite-hub/agent'
import { createBabysitterRuntime } from 'vite-hub/agent/presets/babysitter/server'
import { useServerEnv } from '#vitehub/env/server'
import { consoleClient, github, host, telemetry } from './agents/babysitter/agent.ts'
import { resolveMaxOwners, resolveRepositories } from './babysitter.config.ts'

const config = useServerEnv().babysitter
const sessionConsole = consoleClient

export const runtime = createBabysitterRuntime({
  agent: await getAgentFromRegistry('babysitter'),
  github,
  inboxPath: resolve(process.cwd(), '.vitehub/pull-request-inbox.sqlite'),
  repositories: resolveRepositories(config.repositories, config.repository),
  concurrency: resolveMaxOwners(config.maxOwners),
  publicUrl: config.publicUrl,
  ...(sessionConsole ? {
    sessionUrl: (runId: string) => sessionConsole.endpoint(`/?view=sessions&session=${encodeURIComponent(runId)}`),
  } : {}),
  wake: () => host.wake(),
  event(name, properties) {
    host.event(name, properties)
    telemetry.event(name, properties)
  },
  error(name, error, properties) {
    host.error(name, error, properties)
    telemetry.exception(error, { event: name, ...properties })
  },
})
