# Babysitter

Babysitter runs ViteHub's published Babysitter preset as a persistent GitHub PR repair worker. The application configures its GitHub connection, provider, concurrency, telemetry, and two preset options:

```ts
options: {
  filter: { author: { allow: ['onmax'] } },
  autoMerge: false,
}
```

Change `options` in `server/agents/babysitter/agent.ts`. `filter` uses the GitHub channel filter type, including author and label filters. The same filter controls webhook admission, discovery, and queued work. Explicit filter arrays replace inherited arrays.

`server/agents/babysitter/instructions.md` fills the preset's instruction slot with this application's media policy and task-plan preference. The model receives the completed document without generated user/preset headings.

The preset repairs actionable review feedback and failing checks. It persists PR state, releases workers while external work is pending, and resumes when new evidence arrives. The preset handles feedback from human reviewers and bots without a reviewer allowlist.

Auto-merge is disabled. Enabling `autoMerge` permits the host to request GitHub native auto-merge when the current PR meets its prerequisites. GitHub enforces repository requirements. There is no fallback to direct merging. GitHub credentials remain in the host; the worker uses scoped operations for remote writes.

## Requirements

- Node.js 24.15 or later and pnpm 10.33.
- Git and the GitHub CLI for host-side GitHub operations.
- Codex at `/usr/bin/codex`, with provider authentication available to the service.
- A GitHub connection with access to the selected repositories.
- A persistent writable `.vitehub` directory for agent state and the PR inbox.

## Configuration

| Variable | Purpose |
| --- | --- |
| `BABYSITTER_REPOS` | Comma- or whitespace-separated repositories. |
| `BABYSITTER_REPO` | Single repository fallback; defaults to `vite-hub/vitehub`. |
| `BABYSITTER_MAX_OWNERS` | Concurrent PR workers; defaults to `1`. |
| `BABYSITTER_PUBLIC_URL` | Service origin used in invocation links. |
| `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY` | GitHub App credentials. |
| `GITHUB_APP_INSTALLATIONS` | Optional JSON object mapping repository owners to installation IDs. |
| `GITHUB_TOKEN` | Optional token connection. |
| `GITHUB_WEBHOOK_SECRET` | Secret for verifying incoming webhook signatures. |
| `OPENAI_BASE_URL`, `CLIPROXY_API_KEY` | Service-specific Codex provider connection. |
| `VITEHUB_CONSOLE_URL`, `VITEHUB_CONSOLE_TOKEN` | Optional ViteHub Console delivery. |
| `POSTHOG_API_KEY`, `POSTHOG_HOST` | Optional telemetry export. |

The provider model, executable, and telemetry remain ordinary application configuration in `agent.ts`. Preset configuration does not duplicate these settings.

## Run

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm start
```

For development, use `pnpm dev`. Do not point a second process at the production inbox database or connect it to production webhook intake.

## Webhooks

Point the repository webhook at `/webhooks/github` and configure `GITHUB_WEBHOOK_SECRET`. Subscribe to:

- `pull_request`, `issue_comment`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread`
- `check_run`, `check_suite`, `workflow_run`, `status`, `push`

The receiver verifies signatures and passes deliveries to the upstream durable inbox. It wakes the process when the inbox changes. ViteHub owns the activity comment, repair loop, snapshots, cancellation, and retry behavior.

## Operations

`/api/health` reports process health and PR workload. `/api/drain` reports drain state. Before an authorized service replacement, send `SIGUSR2` to the main process, wait for the drain to complete, and then restart the service with the built release.

The application keeps the existing `.vitehub/pull-request-inbox.sqlite` location. Back up persistent state before deploying an upstream inbox schema change. The upstream runtime recovers expired claims. Restarting preserves unexpired leases, so a claimed PR can wait until its lease expires before another worker takes it.

This repository has no pnpm patches or local copies of the preset workflow. Fix shared behavior in ViteHub, then update the pinned package dependency here.
