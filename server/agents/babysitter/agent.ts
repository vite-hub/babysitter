import { defineAgent } from 'vite-hub/agent'
import { diagnostics, nodeRuntimeResources } from 'vite-hub/agent/capabilities'
import { usePublicEnv, useServerEnv } from 'vite-hub/env'
import { babysitter } from 'vite-hub/presets/babysitter'
import { passCgroupFromEnvironment } from './cgroup.ts'
import { babysitterConfig } from './config.ts'
import { placementFromEnvironment } from './placement/index.ts'

const config = babysitterConfig(useServerEnv().babysitter)
// A vite-hub pass with its install and focused tests peaks around 2.5 GB.
// Slimbook runs about 20 other agents, so host memory pressure idles at 2–3% and CPU near 10%. The
// defaults (pause 5%/25%, resume 1%/10%) paused admission at that baseline and never resumed it.
// A failed sample (the main thread stuck on disk) keeps two slots instead of one.
const perPassBytes = 2.5 * 1024 ** 3
const capacity = {
  memory: { perInvocationBytes: perPassBytes, serviceReserveBytes: 2 * 1024 ** 3, pausePressure: 0.1, resumePressure: 0.05 },
  cpu: { pausePressure: 0.5, resumePressure: 0.3 },
  fallbackConcurrency: 2,
}
// With BABYSITTER_REMOTE_HOSTS (user@host:slots), passes that this host's memory cannot take run there.
const placement = placementFromEnvironment({ capacity, concurrency: config.concurrency, perPassBytes })
// With BABYSITTER_PASS_CGROUP (and systemd's Delegate=yes, DelegateSubgroup=main), passes run in their own cgroup.
passCgroupFromEnvironment()

export default defineAgent({
  extends: babysitter,
  name: 'babysitter',
  version: usePublicEnv().releaseRevision,
  options: {
    filter: {
      repository: { allow: config.repositories },
      ...config.authorFilter,
      // A person working a PR by hand labels it so no pass pushes over their work.
      labels: { deny: ['babysitter:skip'] },
    },
    concurrency: config.concurrency,
    modelConcurrency: config.modelConcurrency,
    capacity,
    placement,
    admission: { inputTokens: config.inputTokens },
    warmWorkspaces: { resumeThreads: true },
    // Read CI evidence, but never ask GitHub Actions to rerun a failed run.
    ciRecovery: false,
    reviewChecks: config.reviewChecks,
    // Automated review never holds a merge: bot threads stop blocking once a pass assessed them,
    // and two heads in a row with nothing above P2 settle the review.
    ignoreAssessedBotThreads: true,
    minorReviewRounds: 2,
    dailyPassBudget: 16,
    // Add this label to a PR to have it claimed first (after main repairs) without the daily cap.
    priorityLabels: ['babysitter:priority'],
    // Stacked PRs get their own passes in parallel with the parent, so a ready child folds into the
    // parent's branch and the whole stack lands with one CI run of the root.
    repairStackChildren: true,
    mainRepairBranchPrefix: 'babysitter/repair-main-',
    // PR checks run fast suites and main runs the full ones, so PRs that each pass can break main together.
    mainRepair: config.mainRepair,
    noFindingsReviews: ['> ✅ No new issues found.', 'Codex usage limits have been reached'],
    // Pullfrog is the one automated reviewer. The preset already ignores the preview bots.
    ignoreFeedbackAuthors: [...babysitter.options.ignoreFeedbackAuthors, 'chatgpt-codex-connector[bot]'],
    merge: {
      strategy: 'direct',
      method: 'squash',
      // Other authors without write access, such as BABYSITTER_CONTRIBUTORS, wait for a write-access reviewer to approve their head.
      trustedAuthors: config.botAuthors,
      markDraftsReady: config.trustedAuthors,
      bypassInheritedChecks: config.bypassInheritedChecks,
      forkHeadBranches: config.forkHeadBranches,
    },
  },
  capabilities: [diagnostics({ resources: nodeRuntimeResources() })],
  driver: {
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    env: () => ({
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
      CLIPROXY_API_KEY: process.env.CLIPROXY_API_KEY,
      NODE_OPTIONS: '--max-old-space-size=4096',
    }),
  },
})
