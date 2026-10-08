# Babysitter

Configure the worker in [`server/agents/babysitter/agent.ts`](server/agents/babysitter/agent.ts).
It extends ViteHub's Babysitter preset. The preset owns webhook intake, the durable PR
inbox, exact-head Git checkouts, CI evidence, repair tools, retries and merge checks.
This project configures repositories, authors, concurrency, model and personal policy.

```ts
import { babysitter } from 'vite-hub/agent/presets/babysitter'

export default defineAgent({
  preset: 'babysitter',
  presets: { babysitter },
  options: {
    filter: {
      repository: { allow: ['your-org/your-repo'] },
      author: { allow: ['your-login'] },
    },
    concurrency: 1,
    reviewChecks: ['pullfrog'],
    merge: false,
  },
  driver: { model: 'your-model', reasoningEffort: 'medium' },
})
```

The preset keeps model passes for real repair work:

- `noFindingsReviews` and `ignoreFeedbackAuthors` mark review verdicts and preview-bot panels
  that never need a model. Feedback that a pass assessed or answered with a push stays
  assessed on later heads, so a PR with no new findings merges without another pass.
- `deferWhilePending` (default `true`) waits for running required checks and review checks
  before a pass, unless a failure or conflict already needs repair.
- `noProgressBudget` (default `3`) stops a head after that many passes without progress, until
  the head changes or a person comments.
- `install` (default `true`) installs dependencies on the host from the frozen lockfile before
  the model starts, and records the result in `.git/vitehub-install.json`.

The included configuration enables direct squash merges for PRs authored by `onmax`.
Set `merge: false` to keep repairs and disable merging. Merge checks verify the live
head, required checks, reviews, feedback and default branch. Open stack children wait
for their parent. Source branches remain intact.

Tuples are supported too: `extends: ['babysitter', { concurrency: 2, merge: false }]`.
Preset defaults merge with the `babysitter` block, then tuple settings. Arrays replace.
External presets use an explicit package import.

## Run

Install Node.js 24.15 or newer, Git, GitHub CLI and an authenticated Codex CLI.
Configure a GitHub App installed on each watched repository, with Contents, Issues
and Pull requests write permissions, plus Actions, Checks and Metadata read permissions.
Set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET`.
The host discovers installations automatically. Optional `GITHUB_APP_INSTALLATIONS`
maps owner names to installation IDs as JSON. A fixed `GITHUB_APP_INSTALLATION_ID`
can be scoped to `GITHUB_APP_OWNER`.

```sh
corepack pnpm install --frozen-lockfile
BABYSITTER_PUBLIC_URL=https://your-host.example corepack pnpm build
NODE_ENV=production corepack pnpm start
```

The development server keeps process hosts disabled. Set `VITEHUB_AGENT_PROCESS_HOSTS=1`
only when you intend to run the worker there.

The configuration accepts `BABYSITTER_REPOS`, `BABYSITTER_MAX_OWNERS`,
`BABYSITTER_MODEL` and `BABYSITTER_REASONING_EFFORT` overrides. Authentication stays
in the service environment. `OPENAI_BASE_URL` and `CLIPROXY_API_KEY` configure the
existing provider proxy. PostHog export is optional through `POSTHOG_API_KEY`.

## Persistence and operations

Agent State stores the inbox in `.vitehub/agent-state.db`. On first startup the preset
imports the previous `.vitehub/pull-request-inbox.sqlite` without overwriting newer
state. Invocation and provider state live under `.vitehub/agents/babysitter`.
The Console invocation journal is configured by `console.databaseUrl` in
`vite.config.ts`, pointing at that same durable agent directory, so the deployed
worker and Console use one source of truth without a systemd database override.
Run one process per data directory. Back up SQLite through its backup API.

GitHub delivers signed webhooks to `/api/webhooks/github`. Health is at `/api/health`
and drain state is at `/api/drain`. The standard ViteHub host routes remain available.
The Console is served at `/_vitehub`.

For the installed systemd service, signal admission to stop before restarting:

```sh
sudo systemctl kill --kill-whom=main --signal=SIGUSR2 babysitter-vitehub.service
curl -fsS http://127.0.0.1:3028/api/drain
# Wait for drained, then restart the authorized release.
sudo systemctl restart babysitter-vitehub.service
```

## Framework preview

The dependency and lockfile pin an immutable pkg.pr.new build from
[ViteHub PR #1907](https://github.com/vite-hub/vitehub/pull/1907). It includes durable
CI recovery, host repair commits and dependency installation, protected native
tool authorization, and asynchronous merges. These fixes live upstream; this
application uses no local pnpm patch.

Update the preview after validating the ViteHub source, then run the release
script against the exact application commit. The release script builds and tests
that commit, smoke-boots scratch data, verifies the systemd preflight, drains the
worker, and watches the new release for health and resource failures.
