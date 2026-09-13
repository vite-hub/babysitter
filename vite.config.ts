import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { processAgentHost, agentHostRoutes } from 'vite-hub/agent/vite'
import { env } from 'vite-hub/env'
import { defaultMaxOwners } from './server/babysitter.config.ts'

export default defineConfig({
  env: {
    public: {
      releaseRevision: env({ mode: 'build', source: env.gitSha() }),
    },
    server: {
      babysitter: {
        publicUrl: env({ default: '', source: env.source('BABYSITTER_PUBLIC_URL') }),
        maxOwners: env({ default: defaultMaxOwners, source: env.source('BABYSITTER_MAX_OWNERS') }),
        repositories: env({ default: '', source: env.source('BABYSITTER_REPOS') }),
        repository: env({ default: 'vite-hub/vitehub', source: env.source('BABYSITTER_REPO') }),
      },
      github: {
        installations: env({ default: '', source: env.source('GITHUB_APP_INSTALLATIONS') }),
        appId: env({ default: '', source: env.source('GITHUB_APP_ID') }),
        installationId: env({ default: '', source: env.source('GITHUB_APP_INSTALLATION_ID') }),
        owner: env({ default: 'vite-hub', source: env.source('GITHUB_APP_OWNER') }),
        privateKey: env({ optional: true, secret: true, source: env.source('GITHUB_APP_PRIVATE_KEY') }),
        webhookSecret: env({ optional: true, secret: true, source: env.source('GITHUB_WEBHOOK_SECRET') }),
        token: env({ optional: true, secret: true, source: env.source('GITHUB_TOKEN') }),
      },
      console: {
        url: env({ optional: true, source: env.source('VITEHUB_CONSOLE_URL') }),
        token: env({ optional: true, secret: true, source: env.source('VITEHUB_CONSOLE_TOKEN') }),
      },
      observability: {
        posthogApiKey: env({ optional: true, secret: true, source: env.source('POSTHOG_API_KEY') }),
        posthogHost: env({ default: 'https://us.i.posthog.com', source: env.source('POSTHOG_HOST') }),
        environment: env({ default: 'production', source: env.source('NODE_ENV') }),
      },
    },
  },
  plugins: [
    vitehub({
      preset: 'node',
      agent: { providers: { state: { provider: 'sqlite', url: 'file:.vitehub/agent-state.db' } } },
      blob: false,
      console: { exposure: 'host-managed' },
      database: false,
      kv: { driver: 'fs-lite' },
      schedule: false,
      workflow: false,
      workspace: false,
    }),
    processAgentHost({ entry: './server/agents/babysitter/agent.ts', exportName: 'host' }),
    agentHostRoutes({ entry: './server/agents/babysitter/agent.ts', health: 'health', workspace: 'workspace' }),
    nitro({
      routeRules: { '/': { redirect: '/_vitehub' } },
      serverDir: true,
    }),
  ],
})
