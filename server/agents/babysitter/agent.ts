import { defineAgent } from 'vite-hub/agent'
import { diagnostics } from 'vite-hub/agent/capabilities'
import { createAgentEvlog } from 'vite-hub/agent/evlog'
import { posthogAgentExporter } from 'vite-hub/agent/evlog/posthog'
import { nodeRuntimeResources } from 'vite-hub/runtime/node'
import { usePublicEnv } from '#vitehub/env/public'

const telemetry = createAgentEvlog({
  service: 'babysitter',
  environment: process.env.NODE_ENV ?? 'production',
  metadata: { agent_family: 'babysitter' },
  level: 'standard',
  ...(process.env.POSTHOG_API_KEY ? {
    exporter: posthogAgentExporter({
      apiKey: process.env.POSTHOG_API_KEY,
      host: process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com',
      service: 'babysitter',
    }),
  } : {}),
})

export default defineAgent({
  extends: 'babysitter',
  name: 'babysitter',
  version: usePublicEnv().releaseRevision,
  babysitter: {
    filter: {
      repository: {
        allow: (process.env.BABYSITTER_REPOS || process.env.BABYSITTER_REPO || 'vite-hub/vitehub')
          .split(/[,\s]+/).filter(Boolean),
      },
      author: { allow: ['onmax'] },
    },
    concurrency: Number(process.env.BABYSITTER_MAX_OWNERS || 1),
    reviewChecks: ['pullfrog'],
    noFindingsReviews: ['> ✅ No new issues found.'],
    merge: { strategy: 'direct', method: 'squash' },
  },
  capabilities: [diagnostics({ resources: nodeRuntimeResources() }), telemetry.capability],
  driver: {
    model: process.env.BABYSITTER_MODEL || 'gpt-6-astra',
    reasoningEffort: process.env.BABYSITTER_REASONING_EFFORT || 'medium',
    env: () => ({
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
      CLIPROXY_API_KEY: process.env.CLIPROXY_API_KEY,
      NODE_OPTIONS: '--max-old-space-size=1024',
    }),
    instructions: `
Before/after images and demonstration videos are optional. Require media only when a
current maintainer explicitly requests it for this PR. Remove stale blockers based
only on a generic media requirement.

Keep a short task plan with the harness plan tool. Make at most one repair commit
per pass. Run focused tests, lint and typecheck. Do not run local builds or broad
validation matrices; use CI logs to diagnose remote build failures.

Do not create direction-validation markers. Preserve the PR description when
removing obsolete generated direction or blocker notes. Keep detailed evidence in
the linked invocation session and the final result.
`,
  },
})
