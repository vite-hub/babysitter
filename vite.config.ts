import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

// A Docker build has no .git, so the image passes the revision in BABYSITTER_RELEASE.
const release = process.env.BABYSITTER_RELEASE ? env.source('BABYSITTER_RELEASE') : env.gitSha()

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      env: {
        public: { releaseRevision: env({ mode: 'build', source: release }) },
      },
      // An empty value (compose passes one when .env leaves it unset) means no public URL.
      publicUrl: process.env.BABYSITTER_PUBLIC_URL || undefined,
      agent: {
        // Agent State lives under the working directory. The Console journal defaults to the build
        // checkout, so a deployment sets VITEHUB_AGENT_INVOCATIONS_DATABASE_URL to a path beside it.
        providers: { state: { driver: 'sqlite', url: 'file:.vitehub/agent-state.db' } },
        routes: {
          aliases: { '/api/webhooks/github': { agent: 'babysitter', webhook: 'github' } },
        },
      },
      observability: {
        service: 'babysitter',
        posthog: {
          apiKey: env({ optional: true, secret: true, source: env.source('POSTHOG_API_KEY') }),
          host: 'https://us.i.posthog.com',
        },
      },
      blob: false,
      database: false,
      kv: { driver: 'fs-lite' },
      schedule: false,
      workflow: false,
      workspace: false,
    }),
    nitro({ serverDir: true }),
  ],
})
