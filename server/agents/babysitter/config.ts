// Everything an operator sets per deployment. The defaults name no person, bot or check of
// any one organization; vite-hub's own values live in its systemd drop-in (ops/org/org.conf).

type Env = Record<string, string | undefined>

function list(raw: string | undefined): string[] {
  return (raw ?? '').split(/[,\s]+/).filter(Boolean)
}

function inputTokenLimit(env: Env, name: string) {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

// Logins match exactly. REST reports a bot as 'name[bot]' and GraphQL as 'name', and the
// commit step re-checks through GraphQL, so each bot is listed under both spellings.
export function botLogins(names: readonly string[]): string[] {
  return names.flatMap((name) => {
    const login = name.replace(/\[bot\]$/i, '')
    return [`${login}[bot]`, login]
  })
}

export function babysitterConfig(env: Env = process.env) {
  const maintainers = list(env.BABYSITTER_MAINTAINERS)
  const contributors = list(env.BABYSITTER_CONTRIBUTORS)
  const bots = botLogins(list(env.BABYSITTER_BOT_AUTHORS).length ? list(env.BABYSITTER_BOT_AUTHORS) : ['renovate', 'dependabot'])
  return {
    repositories: list(env.BABYSITTER_REPOS || env.BABYSITTER_REPO),
    maintainers,
    contributors,
    // Authors whose drafts the merge gate marks ready: everyone listed except outside contributors.
    trustedAuthors: maintainers.length ? [...maintainers, ...bots] : [],
    // Without a maintainer list, GitHub's roles on the repository decide whose PRs get worked.
    authorFilter: maintainers.length
      ? { author: { allow: [...maintainers, ...contributors, ...bots] } }
      : { authorAssociation: { allow: ['OWNER', 'MEMBER', 'COLLABORATOR'] } },
    reviewChecks: list(env.BABYSITTER_REVIEW_CHECKS),
    concurrency: Number(env.BABYSITTER_MAX_OWNERS || 16),
    inputTokens: {
      hourly: inputTokenLimit(env, 'BABYSITTER_HOURLY_INPUT_TOKENS'),
      daily: inputTokenLimit(env, 'BABYSITTER_DAILY_INPUT_TOKENS'),
    },
    // Medium since 2026-11-12: xhigh spent the shared Codex quota in a day. CI verifies the repairs.
    model: env.BABYSITTER_MODEL || 'gpt-6.1-sol',
    reasoningEffort: env.BABYSITTER_REASONING_EFFORT || 'medium',
  }
}
