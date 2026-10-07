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

const workerCgroupParent = process.env.BABYSITTER_WORKER_CGROUP_PARENT
if (process.env.NODE_ENV === 'production' && !workerCgroupParent) {
  throw new Error('BABYSITTER_WORKER_CGROUP_PARENT must name the delegated service cgroup before production workers can start.')
}

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
    // Raise this only after measuring complete worker memory peaks on this host.
    concurrency: 1,
    capacity: {
      fallbackConcurrency: 0,
      memory: { perInvocationBytes: 4 * 1024 ** 3, reserveBytes: 4 * 1024 ** 3 },
    },
    reviewChecks: ['pullfrog'],
    noFindingsReviews: ['> ✅ No new issues found.', 'Codex usage limits have been reached'],
    // Deployment preview bots post status panels, never review findings.
    ignoreFeedbackAuthors: ['pkg-pr-new[bot]', 'vercel[bot]', 'cloudflare-workers-and-pages[bot]', 'netlify[bot]'],
    merge: { strategy: 'direct', method: 'squash' },
  },
  box: {
    runtime: {
      kind: 'trusted-host',
      ...(workerCgroupParent ? { resources: {
        cgroupParent: workerCgroupParent,
        memoryHighBytes: 3 * 1024 ** 3,
        memoryMaxBytes: 4 * 1024 ** 3,
        memorySwapMaxBytes: 128 * 1024 ** 2,
      } } : {}),
    },
  },
  capabilities: [diagnostics({ resources: nodeRuntimeResources() }), telemetry.capability],
  driver: {
    model: process.env.BABYSITTER_MODEL || 'gpt-6-astra',
    reasoningEffort: process.env.BABYSITTER_REASONING_EFFORT || 'medium',
    env: () => ({
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
      CLIPROXY_API_KEY: process.env.CLIPROXY_API_KEY,
      NODE_OPTIONS: '--max-old-space-size=2048',
      // The worker bin wraps node with the shared typecheck/test slot gate.
      ...(process.env.BABYSITTER_WORKER_BIN ? { PATH: `${process.env.BABYSITTER_WORKER_BIN}:${process.env.PATH}` } : {}),
    }),
    instructions: `
Before/after images and demonstration videos are optional. Require media only when a
current maintainer explicitly requests it for this PR. Remove stale blockers based
only on a generic media requirement.

The checkout has full Git history and network access, but no GitHub credentials. The
host installs dependencies with the frozen lockfile before you start. The PR tools are MCP tools named mcp__t3_code__pushRepair,
mcp__t3_code__readCheckLogs, mcp__t3_code__resolveReviewThread,
mcp__t3_code__commentOnPullRequest, mcp__t3_code__updatePullRequest,
mcp__t3_code__readBaseCheckEvidence and mcp__t3_code__readBaseCheckLogs; call them
directly. Push only through pushRepair. The host merges a ready PR after you report
reviewedHead; never merge it yourself.

Make at most one repair commit per pass. Run focused local tests and lint. Use
GitHub Actions for full typechecks, builds and broad validation. Run a local full
check only for a maintainer's explicit request or a focused reproduction, within
the worker memory budget. If a command hits its memory limit, stop and report the
command and failure; reduce the workload before retrying.

Do not create direction-validation markers. Preserve the PR description when
removing obsolete generated direction or blocker notes. Keep detailed evidence in
the linked invocation session and the final result.
`,
  },
})
