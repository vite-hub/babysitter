// Everything an operator sets per deployment. The defaults name no person, bot or check of any
// one organization; vite-hub's own values live in its host environment.

type Env = Record<string, string | undefined>

function list(raw: string | undefined): string[] {
  return (raw ?? '').split(/[,\s]+/).filter(Boolean)
}

function count(env: Env, name: string) {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

export function babysitterConfig(env: Env = process.env) {
  const maintainers = list(env.BABYSITTER_MAINTAINERS)
  const contributors = list(env.BABYSITTER_CONTRIBUTORS)
  // The preset matches a bot in either spelling, `renovate` or `renovate[bot]`.
  const bots = list(env.BABYSITTER_BOT_AUTHORS).length ? list(env.BABYSITTER_BOT_AUTHORS) : ['renovate', 'dependabot']
  return {
    repositories: list(env.BABYSITTER_REPOS),
    maintainers,
    contributors,
    // Authors whose drafts the merge gate marks ready: everyone listed except outside contributors.
    trustedAuthors: maintainers.length ? [...maintainers, ...bots] : [],
    // Without a maintainer list, GitHub's roles on the repository decide whose PRs get worked.
    authorFilter: maintainers.length
      ? { author: { allow: [...maintainers, ...contributors, ...bots] } }
      : { authorAssociation: { allow: ['OWNER', 'MEMBER', 'COLLABORATOR'] } },
    reviewChecks: list(env.BABYSITTER_REVIEW_CHECKS),
    // JSON, such as {"acme/app":["ci"]}: required checks the host may merge past when they fail the
    // same way on the base branch.
    bypassInheritedChecks: JSON.parse(env.BABYSITTER_BYPASS_INHERITED_CHECKS || '{}') as Record<string, string[]>,
    // Repositories whose default branch gets a repair PR when one of the workflows fails on it.
    mainRepair: list(env.BABYSITTER_MAIN_REPAIR_REPOS).length
      ? { repositories: list(env.BABYSITTER_MAIN_REPAIR_REPOS), workflows: list(env.BABYSITTER_MAIN_REPAIR_WORKFLOWS).length ? list(env.BABYSITTER_MAIN_REPAIR_WORKFLOWS) : ['ci'] }
      : false as const,
    concurrency: count(env, 'BABYSITTER_MAX_OWNERS') ?? 16,
    modelConcurrency: count(env, 'BABYSITTER_MODEL_CONCURRENCY'),
    inputTokens: {
      hourly: count(env, 'BABYSITTER_HOURLY_INPUT_TOKENS'),
      daily: count(env, 'BABYSITTER_DAILY_INPUT_TOKENS'),
    },
    // Medium since 2026-11-12: xhigh spent the shared Codex quota in a day. CI verifies the repairs.
    model: env.BABYSITTER_MODEL || 'gpt-6.1-sol',
    reasoningEffort: env.BABYSITTER_REASONING_EFFORT || 'medium',
  }
}
