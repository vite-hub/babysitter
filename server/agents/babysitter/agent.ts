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
      // Logins match exactly. REST reports a bot as 'name[bot]' and GraphQL as 'name', and the
      // commit step re-checks through GraphQL, so list both. vitehub-bot opens the main-guardian
      // repair PRs (scripts/main-guardian.mjs).
      author: { allow: ['onmax', 'renovate[bot]', 'renovate', 'vitehub-bot[bot]', 'vitehub-bot'] },
      // A person working a PR by hand labels it so no pass pushes over their work.
      labels: { deny: ['babysitter:skip'] },
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
    // pullfrog-approval is Pullfrog's verdict check. Listing it lets the review push budget stop its
    // failures from waking passes; the host merges a reviewed head on the required checks.
    reviewChecks: ['pullfrog', 'pullfrog-approval'],
    // Defaults, written out because they gate most model passes (2026-10-19 pass-volume review).
    reviewPushBudget: 3,
    dailyPassBudget: 16,
    // Add this label to a PR to have it claimed first (after main repairs) without the daily cap.
    priorityLabels: ['babysitter:priority'],
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
manifests caused the failure, repair them (pnpm install --lockfile-only or --fix-lockfile to
resolve, then a plain pnpm install --ignore-scripts so URL tarballs such as pkg.pr.new get their
integrity; check with pnpm install --frozen-lockfile) and call refreshDependencies. If the cause is outside this PR, continue the repair without local
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

Converge instead of hardening forever. A finding that only reproduces with deliberately forged
or hostile runtime objects (Proxies, cross-realm values, poisoned prototypes or species,
spoofed brands or toStringTag, values copied to imitate an intrinsic) is P2, even when the
reviewer labels it P1. The host limits review-driven pushes per PR; when the prompt has a
review-push-budget block, follow it. Never park a PR to ask the maintainer to choose between
requirements; pick the option that keeps existing behavior compatible, say which in the
thread reply, and resolve it. Park with an external wait only for something outside the
repository that a retry cannot fix; the host retries every external wait after two hours.

Failing required checks come before review findings. When a required check fails in setup,
install, lint, typecheck, build or tests, that failure is the repair for this pass, even when
the PR also has open P1 findings: a broken lockfile or a duplicate declaration left by a merge
blocks the merge, and review findings do not. A failing required check that also fails on the
base is not this PR's to fix; say so and set reviewedHead.

Make at most one repair commit per pass. Run focused tests, lint and typecheck the way the
repository's CONTRIBUTING.md or AGENTS.md says. In a monorepo, run the changed package's own
scripts (pnpm --dir packages/<pkg> run typecheck, pnpm --dir packages/<pkg> exec vitest run
test/<file>); never run vitest from the repository root. When a typecheck cannot find a
workspace package, build only that dependency with the repository's documented build command
and retry. Do not run full builds or broad validation matrices; use CI logs to diagnose remote
build failures. List instruction files with git ls-files '*AGENTS.md' '*CONTRIBUTING.md', and
never search outside the checkout (find .., /, ~).

Do not create direction-validation markers. Preserve the PR description when
removing obsolete generated direction or blocker notes. Keep detailed evidence in
the linked invocation session and the final result.
`,
  },
})
