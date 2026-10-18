import { defineAgent } from 'vite-hub/agent'
import { babysitter } from 'vite-hub/agent/presets/babysitter'
import { diagnostics } from 'vite-hub/agent/capabilities'
import { createAgentEvlog } from 'vite-hub/agent/evlog'
import { posthogAgentExporter } from 'vite-hub/agent/evlog/posthog'
import { nodeRuntimeResources } from 'vite-hub/runtime/node'
import { usePublicEnv } from '#vitehub/env/public'
import { registerFleetFromEnvironment } from '../../fleet/fleet.ts'

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

// Passes beyond BABYSITTER_FLEET_LOCAL_SLOTS run in remote Boxes on BABYSITTER_FLEET_HOSTS.
registerFleetFromEnvironment()

function inputTokenLimit(name: string) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

const admissionInputTokens = {
  hourly: inputTokenLimit('BABYSITTER_HOURLY_INPUT_TOKENS'),
  daily: inputTokenLimit('BABYSITTER_DAILY_INPUT_TOKENS'),
}

export default defineAgent({
  preset: 'babysitter',
  presets: { babysitter },
  name: 'babysitter',
  version: usePublicEnv().releaseRevision,
  options: {
    filter: {
      repository: {
        allow: (process.env.BABYSITTER_REPOS || process.env.BABYSITTER_REPO || 'vite-hub/vitehub')
          .split(/[,\s]+/).filter(Boolean),
      },
      // Logins match exactly, so bots need their REST login. vitehub-bot opens the main-guardian
      // repair PRs (scripts/main-guardian.mjs).
      author: { allow: ['onmax', 'renovate[bot]', 'vitehub-bot[bot]'] },
    },
    // Keep the scheduler ceiling high enough to use the available PR lanes. The
    // host's admission guard and worker gate still pause work when resources are tight.
    concurrency: Number(process.env.BABYSITTER_MAX_OWNERS || 16),
    // A worker's Codex tree peaks around 250-520 MB; reserving the 1 GiB default per worker
    // capped the host at a handful of workers. Host installs and the two heavy
    // typecheck/test slots share the larger service reserve instead.
    capacity: { memory: { perInvocationBytes: 512 * 1024 ** 2, serviceReserveBytes: 2 * 1024 ** 3 } },
    admission: { inputTokens: admissionInputTokens },
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
    reviewChecks: ['pullfrog'],
    noFindingsReviews: ['> ✅ No new issues found.', 'Codex usage limits have been reached'],
    // Deployment preview bots post status panels, never review findings.
    ignoreFeedbackAuthors: ['pkg-pr-new[bot]', 'vercel[bot]', 'cloudflare-workers-and-pages[bot]', 'netlify[bot]'],
    merge: { strategy: 'direct', method: 'squash' },
  },
  workspace: {},
  capabilities: [diagnostics({ resources: nodeRuntimeResources() }), telemetry.capability],
  driver: {
    model: process.env.BABYSITTER_MODEL || 'gpt-6-astra',
    reasoningEffort: process.env.BABYSITTER_REASONING_EFFORT || 'medium',
    env: () => ({
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
      CLIPROXY_API_KEY: process.env.CLIPROXY_API_KEY,
      NODE_OPTIONS: '--max-old-space-size=4096',
      // The worker bin wraps node with the shared typecheck/test slot gate.
      ...(process.env.BABYSITTER_WORKER_BIN ? { PATH: `${process.env.BABYSITTER_WORKER_BIN}:${process.env.PATH}` } : {}),
    }),
    instructions: `
Before/after images and demonstration videos are optional. Require media only when a
current maintainer explicitly requests it for this PR. Remove stale blockers based
only on a generic media requirement.

The checkout has full Git history and network access, but no GitHub credentials. The
host installs dependencies with the frozen lockfile before you start. Installation is
optional: when .git/vitehub-install.json has "status": "failed" (or the prompt has a
dependency-install-failure block), you start without dependencies. If the PR's lockfile or
manifests caused the failure, repair them (try pnpm install --lockfile-only, then --fix-lockfile)
and call refreshDependencies. If the cause is outside this PR, continue the repair without local
dependencies, rely on hosted CI, and name the install failure in your result so a maintainer can fix it. The PR tools are MCP tools named mcp__t3_code__pushRepair,
mcp__t3_code__readCheckLogs, mcp__t3_code__resolveReviewThread,
mcp__t3_code__commentOnPullRequest, mcp__t3_code__updatePullRequest,
mcp__t3_code__readBaseCheckEvidence and mcp__t3_code__readBaseCheckLogs; call them
directly. Push only through pushRepair. The host merges a ready PR after you report
reviewedHead; never merge it yourself.

Automated review findings (pullfrog[bot] and chatgpt-codex-connector[bot]): both review
every push, so fixing every new finding never converges. Verify each finding in their most
recent reviews and inline comments against the current code, then classify each valid
finding as P0 (security hole, data loss or a broken main path), P1 (a real bug on a
supported path or a broken documented contract), P2 (an edge case, a missing test or a docs
gap) or P3 (style or a nit). A fixed or false finding has no class. Repair P0 and P1
findings, and P2 findings only when the fix is small and inside this PR's scope. Do not push
for P2 or P3 findings alone, and do not widen the PR for findings about code it did not
change: reply on the thread with one sentence of rationale and resolve it with
resolveReviewThread. When no valid P0 or P1 finding remains, a failing pullfrog-approval
check does not block the merge: resolve the remaining threads and set reviewedHead to the
current HEAD. Name the class of each finding in the final text, for example "Pullfrog: P2
watcher cleanup race".

Make at most one repair commit per pass. Run focused tests, lint and typecheck. Do
not run local builds or broad validation matrices; use CI logs to diagnose remote
build failures.

Do not create direction-validation markers. Preserve the PR description when
removing obsolete generated direction or blocker notes. Keep detailed evidence in
the linked invocation session and the final result.
`,
  },
})
