import { defineAgent } from 'vite-hub/agent'
import { babysitter } from 'vite-hub/agent/presets/babysitter'
import { diagnostics } from 'vite-hub/agent/capabilities'
import { createAgentEvlog } from 'vite-hub/agent/evlog'
import { posthogAgentExporter } from 'vite-hub/agent/evlog/posthog'
import { nodeRuntimeResources } from 'vite-hub/runtime/node'
import { usePublicEnv } from '#vitehub/env/public'
import { registerFleetFromEnvironment } from '../../fleet/fleet.ts'
import { babysitterConfig } from './config.ts'
// Not instructions.md: ViteHub copies a colocated instructions.md into every PR checkout as AGENTS.md.
import instructions from './repair-instructions.md?raw'
import { maintainerApprovalForContributors, ownDraftsReady } from './contributors.ts'

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

// The worker bin wraps node with the shared heavy-command gate (scripts/heavy-command-gate.cjs).
// Host dependency installs that this server starts resolve node on PATH too, so they queue on
// the same slots as the workers' typecheck, test and install commands.
const workerBin = process.env.BABYSITTER_WORKER_BIN
if (workerBin && !process.env.PATH?.split(':').includes(workerBin)) process.env.PATH = `${workerBin}:${process.env.PATH ?? ''}`

// Passes beyond BABYSITTER_FLEET_LOCAL_SLOTS run in remote Boxes on BABYSITTER_FLEET_HOSTS.
registerFleetFromEnvironment()

const config = babysitterConfig()

export default defineAgent({
  preset: 'babysitter',
  presets: { babysitter },
  name: 'babysitter',
  version: usePublicEnv().releaseRevision,
  options: {
    filter: {
      repository: { allow: config.repositories },
      // Contributors' PRs get the same repairs; merge.ready below holds their merge for a maintainer.
      ...config.authorFilter,
      // A person working a PR by hand labels it so no pass pushes over their work.
      labels: { deny: ['babysitter:skip'] },
    },
    // Keep the scheduler ceiling high enough to use the available PR lanes. The
    // host's admission guard and worker gate still pause work when resources are tight.
    concurrency: config.concurrency,
    // A worker's Codex tree peaks around 250-520 MB; reserving the 1 GiB default per worker
    // capped the host at a handful of workers. Host installs and the two heavy
    // typecheck/test slots share the larger service reserve instead.
    capacity: { memory: { perInvocationBytes: 512 * 1024 ** 2, serviceReserveBytes: 2 * 1024 ** 3 } },
    admission: { inputTokens: config.inputTokens },
    // The install cache copies whole node_modules trees, and ext4 has no reflinks. Since the
    // 2026-10-17 reboot, a plain install with pnpm's warm store took 16 s, but a cached pass took
    // 81-125 s, and 28 of 50 restored trees failed verification. The copies also stalled the server.
    install: { cache: false },
    // Wait for running checks and the automated reviews before a repair pass. With this off
    // (c3996ff7), passes started mid-CI and were discarded when the review landed: on
    // 2026-10-18 #2156 took 24 passes in 2.5 h while merging 4 PRs an hour overall.
    deferWhilePending: true,
    // Overnight mode reads CI evidence but never asks GitHub Actions to rerun a failed run.
    ciRecovery: false,
    // Automated reviewers' checks. Their failures don't wake passes once the review push budget is spent.
    reviewChecks: config.reviewChecks,
    // Defaults, written out because they gate most model passes (2026-10-19 pass-volume review).
    reviewPushBudget: 3,
    // Merge on green (2026-11-12): a PR whose required checks pass, or fail only the way main fails
    // them, merges with no model pass. Automated review never holds the merge; bot feedback starts a
    // pass only when it names a P0 or P1 finding. A red main is fixed afterwards, never a blocker.
    mergeOnGreen: true,
    dailyPassBudget: 16,
    // Add this label to a PR to have it claimed first (after main repairs) without the daily cap.
    priorityLabels: ['babysitter:priority'],
    noFindingsReviews: ['> ✅ No new issues found.', 'Codex usage limits have been reached'],
    // Deployment preview bots post status panels, never review findings.
    // Pullfrog is the one automated reviewer; the Codex connector's reviews (mostly P2) are ignored.
    ignoreFeedbackAuthors: ['pkg-pr-new[bot]', 'vercel[bot]', 'cloudflare-workers-and-pages[bot]', 'netlify[bot]', 'chatgpt-codex-connector[bot]', 'chatgpt-codex-connector'],
    // Maintainers' agents open PRs as drafts; the merge gate marks those ready instead of waiting forever.
    merge: {
      strategy: 'direct',
      method: 'squash',
      ready: maintainerApprovalForContributors(config.contributors, config.maintainers),
      markDraftsReady: ownDraftsReady(config.trustedAuthors),
    },
  },
  workspace: {},
  capabilities: [diagnostics({ resources: nodeRuntimeResources() }), telemetry.capability],
  driver: {
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    env: () => ({
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
      CLIPROXY_API_KEY: process.env.CLIPROXY_API_KEY,
      NODE_OPTIONS: '--max-old-space-size=4096',
      // PATH starts with the worker bin (see above).
      ...(workerBin ? { PATH: process.env.PATH } : {}),
    }),
    instructions,
  },
})
