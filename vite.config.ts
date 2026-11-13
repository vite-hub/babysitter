import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

const dataDir = process.env.BABYSITTER_DATA_DIR ?? '.'
// A Docker build has no .git, so the image passes the revision in BABYSITTER_RELEASE.
const release = process.env.BABYSITTER_RELEASE ? env.source('BABYSITTER_RELEASE') : env.gitSha()

export default defineConfig({
  env: {
    public: { releaseRevision: env({ mode: 'build', source: release }) },
  },
  plugins: [
    vitehub({
      preset: 'node',
      // An empty value (compose passes one when .env leaves it unset) means no public URL.
      publicUrl: process.env.BABYSITTER_PUBLIC_URL || undefined,
      agent: {
        providers: { state: { provider: 'sqlite', url: 'file:.vitehub/agent-state.db' } },
        routes: {
          aliases: { '/api/webhooks/github': { agent: 'babysitter', webhook: 'github' } },
        },
      },
      blob: false,
      console: {
        auth: false,
        authorize: './server/console-authorize.ts',
        // Keep the Console journal beside the worker's durable agent data. The path is
        // baked in at build time, so set BABYSITTER_DATA_DIR when you build for a host.
        databaseUrl: `file:${dataDir}/.vitehub/agents/babysitter/invocations.sqlite`,
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
