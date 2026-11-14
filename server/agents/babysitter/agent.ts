import { defineAgent } from 'vite-hub/agent'
import { diagnostics, nodeRuntimeResources } from 'vite-hub/agent/capabilities'
import { usePublicEnv } from 'vite-hub/env'
import { babysitter } from 'vite-hub/presets/babysitter'
import { babysitterConfig } from './config.ts'
import { maintainerApprovalForContributors } from './contributors.ts'

const config = babysitterConfig()

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
    // A vite-hub pass with its install and focused tests peaks around 2.5 GB.
    capacity: { memory: { perInvocationBytes: 2.5 * 1024 ** 3, serviceReserveBytes: 2 * 1024 ** 3 } },
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
    mainRepairBranchPrefix: 'babysitter/repair-main-',
    // PR checks run fast suites and main runs the full ones, so PRs that each pass can break main together.
    mainRepair: config.mainRepair,
    noFindingsReviews: ['> ✅ No new issues found.', 'Codex usage limits have been reached'],
    // Preview bots post status panels, never findings. Pullfrog is the one automated reviewer.
    ignoreFeedbackAuthors: ['pkg-pr-new[bot]', 'vercel[bot]', 'cloudflare-workers-and-pages[bot]', 'netlify[bot]', 'chatgpt-codex-connector[bot]'],
    merge: {
      strategy: 'direct',
      method: 'squash',
      ready: maintainerApprovalForContributors(config.contributors, config.maintainers),
      markDraftsReady: config.trustedAuthors,
      bypassInheritedChecks: config.bypassInheritedChecks,
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
