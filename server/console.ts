import { useServerEnv } from '#vitehub/env/server'
import { createAgentConsoleDelivery } from 'vite-hub/agent/server'

export const consoleClient = createAgentConsoleDelivery(useServerEnv().console)
