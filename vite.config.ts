import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      env: {
        // A Docker build has no .git, so the image passes the revision in GIT_SHA, which gitCommit() reads first.
        public: { releaseRevision: env({ mode: 'build', source: env.gitCommit() }) },
        // Each value reads BABYSITTER_<NAME>, such as BABYSITTER_REPOS. A list takes commas or line breaks.
        server: {
          babysitter: {
            repos: env.list({ default: [] }),
            maintainers: env.list({ default: [] }),
            contributors: env.list({ default: [] }),
            // The preset matches a bot in either spelling, `renovate` or `renovate[bot]`.
            botAuthors: env.list({ default: ['renovate', 'dependabot'] }),
            reviewChecks: env.list({ default: [] }),
            mainRepairRepos: env.list({ default: [] }),
            mainRepairWorkflows: env.list({ default: ['ci'] }),
            // JSON, such as {"acme/app":["ci"]}: required checks the host may merge past when they fail
            // the same way on the base branch.
            bypassInheritedChecks: env.json({ default: {} }),
            // JSON, such as {"acme/app":"preview/pr-{number}"}: the branch that gets an approved fork head
            // when a required check, like pkg.pr.new, runs only on pushes to the repository.
            forkHeadBranches: env.json({ default: {} }),
          },
        },
      },
      // An empty value (compose passes one when .env leaves it unset) means no public URL.
      publicUrl: process.env.BABYSITTER_PUBLIC_URL || undefined,
      agent: {
        // Agent State lives under the working directory. The Console journal defaults to the build
        // checkout, so a deployment sets VITEHUB_AGENT_INVOCATIONS_DATABASE_URL to a path beside it.
        providers: { state: { driver: 'sqlite', url: 'file:.vitehub/agent-state.db' } },
        routes: {
          // The GitHub App still posts to the path ViteHub served before vitehub#4923 moved it to /_vitehub.
          aliases: {
            '/api/webhooks/github': { agent: 'babysitter', webhook: 'github' },
            '/api/_vitehub/agents/babysitter/webhooks/github': { agent: 'babysitter', webhook: 'github' },
          },
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
      // The ViteHub Console signs its calls; each linked caller's public key is a VITEHUB_CONSOLE_KEY_<NAME> variable.
      console: true,
      database: false,
      kv: { driver: 'fs-lite' },
      schedule: false,
      workflow: false,
      workspace: false,
    }),
    nitro({ serverDir: true }),
  ],
})
