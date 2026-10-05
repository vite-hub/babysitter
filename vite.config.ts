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
          host: { health: '/api/health', drain: '/api/drain' },
          aliases: { '/api/webhooks/github': { agent: 'babysitter', webhook: 'github' } },
        },
      },
      blob: false,
      console: { exposure: 'host-managed' },
      database: false,
      kv: { driver: 'fs-lite' },
      schedule: false,
      workflow: false,
      workspace: false,
    }),
    nitro({ routeRules: { '/': { redirect: '/_vitehub' } }, serverDir: true }),
  ],
})
