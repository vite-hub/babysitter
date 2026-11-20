// Everything an operator sets per deployment. The defaults name no person, bot or check of any
// one organization; vite-hub's own values live in its host environment.

type Env = Record<string, string | undefined>

/**
 * The lists and the JSON map, parsed by the `env.server.babysitter` declarations in vite.config.ts from
 * BABYSITTER_REPOS, BABYSITTER_MAINTAINERS and the other variables of the same names.
 */
export interface BabysitterLists {
  repos: readonly string[]
  maintainers: readonly string[]
  contributors: readonly string[]
  botAuthors: readonly string[]
  reviewChecks: readonly string[]
  mainRepairRepos: readonly string[]
  mainRepairWorkflows: readonly string[]
  bypassInheritedChecks: unknown
  forkHeadBranches: unknown
}

function count(env: Env, name: string) {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

export function babysitterConfig(lists: BabysitterLists, env: Env = process.env) {
  const maintainers = [...lists.maintainers]
  const contributors = [...lists.contributors]
  // The preset matches a bot in either spelling, `renovate` or `renovate[bot]`.
  const bots = [...lists.botAuthors]
  return {
    repositories: [...lists.repos],
    maintainers,
    contributors,
    // The merge gate trusts these bot accounts. It matches a bot only in its `[bot]` spelling.
    botAuthors: bots.map(name => name.endsWith('[bot]') ? name : `${name}[bot]`),
    // Authors whose drafts the merge gate marks ready: everyone listed except outside contributors.
    trustedAuthors: maintainers.length ? [...maintainers, ...bots] : [],
    // Without a maintainer list, GitHub's roles on the repository decide whose PRs get worked.
    authorFilter: maintainers.length
      ? { author: { allow: [...maintainers, ...contributors, ...bots] } }
      : { authorAssociation: { allow: ['OWNER', 'MEMBER', 'COLLABORATOR'] } },
    reviewChecks: [...lists.reviewChecks],
    // JSON, such as {"acme/app":["ci"]}: required checks the host may merge past when they fail the
    // same way on the base branch.
    bypassInheritedChecks: lists.bypassInheritedChecks as Record<string, string[]>,
    // JSON, such as {"acme/app":"preview/pr-{number}"}: where an approved fork head goes when a required
    // check runs only on pushes to the repository. The preset validates it.
    forkHeadBranches: lists.forkHeadBranches as Record<string, string>,
    // Repositories whose default branch gets a repair PR when one of the workflows fails on it.
    mainRepair: lists.mainRepairRepos.length
      ? { repositories: [...lists.mainRepairRepos], workflows: [...lists.mainRepairWorkflows] }
      : false as const,
    concurrency: count(env, 'BABYSITTER_MAX_OWNERS') ?? 16,
    modelConcurrency: count(env, 'BABYSITTER_MODEL_CONCURRENCY'),
    inputTokens: {
      hourly: count(env, 'BABYSITTER_HOURLY_INPUT_TOKENS'),
      daily: count(env, 'BABYSITTER_DAILY_INPUT_TOKENS'),
    },
    // Medium since 2026-11-12: xhigh spent the shared Codex quota in a day. CI verifies the repairs.
    model: env.BABYSITTER_MODEL || 'gpt-6.2-sol',
    reasoningEffort: env.BABYSITTER_REASONING_EFFORT || 'high',
  }
}
