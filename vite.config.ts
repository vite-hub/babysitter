import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  env: {
    public: { releaseRevision: env({ mode: 'build', source: env.gitSha() }) },
  },
  plugins: [
    vitehub({
      preset: 'node',
      publicUrl: process.env.BABYSITTER_PUBLIC_URL,
      agent: {
        providers: { state: { provider: 'sqlite', url: 'file:.vitehub/agent-state.db' } },
        routes: {
          aliases: { '/api/webhooks/github': { agent: 'babysitter', webhook: 'github' } },
        },
      },
      blob: false,
      console: {
        exposure: 'host-managed',
        authorize: './server/console-authorize.ts',
        // Keep the Console journal beside the worker's durable agent data. This
        // is part of the project configuration so production does not depend on
        // a systemd environment override for the active invocation database.
        databaseUrl: 'file:/home/workspace/babysitter-data/.vitehub/agents/babysitter/invocations.sqlite',
      },
      database: false,
      kv: { driver: 'fs-lite' },
      schedule: false,
      workflow: false,
      workspace: false,
    }),
    nitro({ routeRules: { '/': { redirect: '/_vitehub' } }, serverDir: true }),
  ],
})
