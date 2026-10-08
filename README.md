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

Worker checks share the host fleet queue lock, while model passes can use all 16 owner slots. Provider sandboxes have private `/tmp` and PID namespaces, so PID files under `/tmp` do not limit host concurrency. The Node wrapper opens a persistent lock read-only and acquires a kernel `flock` on its shared inode. Set `BABYSITTER_WORKER_BIN=/home/workspace/babysitter-data/bin/worker/worker-bin`. Install the wrapper there and put the gate and lock in its parent directory:

```sh
sudo install -d /home/workspace/babysitter-data/bin/worker/worker-bin
sudo install -m 0755 scripts/worker-bin/node /home/workspace/babysitter-data/bin/worker/worker-bin/node
sudo scripts/install-worker-verification-lock.sh
sudo install -m 0644 scripts/heavy-command-gate.cjs /home/workspace/babysitter-data/bin/worker/heavy-command-gate.cjs
```

The installer links the existing fleet queue lock and grants only read access to `svc-babysitter`. It refuses an anchor that points at another inode. The gate fails closed when the anchor is missing and inherits its lease through nested commands. Do not replace the fleet queue lock file; both users must keep the same inode.

For the installed systemd service, signal admission to stop before restarting:

```sh
sudo systemctl kill --kill-whom=main --signal=SIGUSR2 babysitter-vitehub.service
curl -fsS http://127.0.0.1:3028/api/drain
# Wait for drained, then restart the authorized release.
sudo systemctl restart babysitter-vitehub.service
```

## Framework preview

The dependency and lockfile pin an immutable pkg.pr.new build from
[ViteHub PR #1989](https://github.com/vite-hub/vitehub/pull/1989), stacked on
[#1987](https://github.com/vite-hub/vitehub/pull/1987),
[#1984](https://github.com/vite-hub/vitehub/pull/1984), and
[#1907](https://github.com/vite-hub/vitehub/pull/1907). It includes durable CI recovery,
host repair commits, serialized dependency installation with a two-minute admission
timeout, private validated dependency snapshots, protected native tool authorization, and asynchronous merges.

Conflict preparation reads the live target branch ref. A stale PR base snapshot
cannot turn a real conflict into an empty merge. Repair commit and push guards
check that live ref again before publication.

The host preserves a validated Yarn linker while isolating project plugins and
package-manager executables. Linker changes invalidate installed dependencies.

The upstream package owns durable status delivery and recovery of worker failures. Saving a pass result also queues its
managed PR comment in the same SQLite transaction. GitHub delivery retries survive
restarts, find an existing comment after an uncertain response, and coalesce newer
results. Hosts claim each delivery atomically and renew the five-minute lease
until its external write settles. Deferred repair comments yield the batch to
other PRs. Up to five publications run outside scheduling, remain tracked during
drain, and request cancellation after twenty seconds. Saved statuses use their
own activity run IDs. New feedback, active claims, and replaced heads discard obsolete deliveries. If a replaced writer settles late, the host queues a corrective replay of the latest saved result with a fresh activity identity. GitHub comments are eventually consistent because a lease cannot revoke an HTTP write already accepted remotely. Posting does not require a
model invocation or native MCP approval. The host selects the GitHub App installation
for each repository owner, using configured mappings or App discovery. Concurrent
admission checks share one journal scan. Health can reuse its timestamped accounting
for at most two minutes while dispatch waits for the current scan.

Replaced writers retain durable correction until explicit settlement. Orphaned
writers keep a five-minute replay interval after their active deadline. Reopening
a closed PR queues the new status even while worker capacity is unavailable.

Known worker blockers, such as rejected MCP approvals or read-only Git metadata,
are rechecked once per application release. An unchanged worker failure stays
parked for that release. External dependencies retain their existing wake rules.
The published provider adapter already preapproves the exact host-authorized tool
names for unattended runs.

Consumer tests verify the installed package through its public inbox and GitHub
credential APIs. ViteHub owns the detailed delivery and recovery regression tests.
The application no longer applies an Agent package patch.

Update the preview after validating the ViteHub source, then run the release
script against the exact application commit. The release script builds and tests
that commit, smoke-boots scratch data, verifies the systemd preflight, drains the
worker, and watches the new release for health and resource failures.
