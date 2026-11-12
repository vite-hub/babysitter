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
- `ciRecovery` (default `true`) retries failed GitHub Actions runs once per head. Set it to
  `false` to read CI evidence and keep normal merge gates without requesting reruns.

The included configuration enables direct squash merges for PRs authored by `onmax`.
It also repairs PRs from outside contributors (`BABYSITTER_CONTRIBUTORS`, default `OrlS15`),
but merges one only after a maintainer (`BABYSITTER_MAINTAINERS`, default `onmax`) approves
its current head. A push after the approval needs a new approval. Set `merge: false` to keep repairs and disable merging. Merge checks verify the live
head, required checks, reviews, feedback and default branch. Open stack children wait
for their parent. Source branches remain intact.

The worker uses GPT-6.1 Sol at `medium` by default. It repairs and verifies the change in
one invocation; Pullfrog provides independent review. There is no second model review
stage.

`mergeOnGreen: true` merges a PR with no model pass once its required checks pass, or fail
only the way the base fails them. Automated review never holds the merge: review checks are
not awaited, and bot feedback starts a pass only when it names a P0 or P1 finding. A person's
comment or review, a merge conflict and a required check that the PR breaks still start a
pass. The Codex connector's reviews are ignored.

Tuples are supported too: `extends: ['babysitter', { concurrency: 2, merge: false }]`.
Preset defaults merge with the `babysitter` block, then tuple settings. Arrays replace.
External presets use an explicit package import.

## Run your own

Fork this repository and review `server/agents/babysitter/agent.ts`: its author list, review
checks and model instructions are ours. Then:

1. Create a GitHub App under Settings → Developer settings → GitHub Apps.
   - Webhook URL: `https://<your-host>/api/webhooks/github`, with a random webhook secret.
   - Repository permissions: Contents, Pull requests, Issues and Checks read and write; Actions,
     Commit statuses and Metadata read. Add Workflows write if repairs may touch `.github/workflows`.
   - Events: Pull request, Pull request review, Pull request review comment, Pull request review
     thread, Issue comment, Check run, Check suite, Status and Push.
   - Generate a private key and install the App on the repositories to watch.
2. `cp .env.example .env` and fill in the required values.
3. Start it and log Codex in once. The login lands in the `/data` volume.

   ```sh
   docker compose up -d --build
   docker compose exec babysitter codex login --device-auth
   # or: printenv OPENAI_API_KEY | docker compose exec -T babysitter codex login --with-api-key
   curl -fsS localhost:3000/api/health
   ```

The Console at `/_vitehub` and the health routes have no authentication. Expose only
`/api/webhooks/github` to the internet, through a reverse proxy or tunnel, and keep the rest private.

`docker compose stop` gives webhook deliveries `VITEHUB_SHUTDOWN_DRAIN_MS` (2 minutes) to finish.
A repair pass still running is interrupted, and the next start picks the PR up again. To let
running passes finish first, drain before you restart:

```sh
docker compose kill -s SIGUSR2 babysitter
until curl -s localhost:3000/api/drain | grep -q drained; do sleep 10; done
docker compose up -d --build --force-recreate
```

## Run on a host

Install Node.js 24.15 or newer, Git, GitHub CLI and an authenticated Codex CLI.
Configure a GitHub App installed on each watched repository, with Contents, Issues
and Pull requests write permissions, plus Actions, Checks and Metadata read permissions.
Set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET`.
The host discovers installations automatically. Optional `GITHUB_APP_INSTALLATIONS`
maps owner names to installation IDs as JSON. A fixed `GITHUB_APP_INSTALLATION_ID`
can be scoped to `GITHUB_APP_OWNER`.

```sh
corepack pnpm install --frozen-lockfile
BABYSITTER_PUBLIC_URL=https://your-host.example BABYSITTER_DATA_DIR=/srv/babysitter corepack pnpm build
cd /srv/babysitter && NODE_ENV=production node /path/to/checkout/.output/server/index.mjs
```

`BABYSITTER_DATA_DIR` is read at build time and sets where the Console journal lives. The agent
state goes to `.vitehub/` under the working directory, so start the server from that same directory.

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

For `vite-hub/vitehub` PRs targeting `main`, Babysitter can bypass failed `ci` and
`publish preview packages` checks when their failure output is already present on
the current `main` commit. Before requesting a merge, it refreshes the PR checks,
branch protections, reviews and conversations. PR-specific failures, other required
checks and unsupported protections still block merging. Missing logs do not prove
an inherited failure. The exact head, base and ignored check IDs are recorded in
the durable `inherited-merge-proof:<repository>#<number>` entry.

For the installed systemd service, signal admission to stop before restarting:

```sh
sudo systemctl kill --kill-whom=main --signal=SIGUSR2 babysitter-vitehub.service
curl -fsS http://127.0.0.1:3028/api/drain
# Wait for drained, then restart the authorized release.
sudo systemctl restart babysitter-vitehub.service
```

## ViteHub preview

`package.json` pins an immutable `pkg.pr.new` preview. The overrides in
`pnpm-workspace.yaml` keep ViteHub dependencies on that same commit, including
peer dependencies. Update both files together and regenerate the lockfile.

The current preview includes the installation wait fix in
[ViteHub #2004](https://github.com/vite-hub/vitehub/pull/2004) and the activity session
fix in [ViteHub #2005](https://github.com/vite-hub/vitehub/pull/2005). Installation
input errors wait for changed head or comment evidence; host and package-manager
failures retain automatic retries. Saved results share their invocation's session
row, and historical rows show a recorded duration.
`tests/github-activity.test.ts` exercises the installed package without a patch.

For a new framework bug, use `pnpm patch @vite-hub/agent@0.0.4`, verify the consumer
fix, and run `pnpm patch-commit <directory>`. Upstream the fix, then switch to its
preview and remove the patch after the installed-package test passes.
