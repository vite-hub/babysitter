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
[ViteHub PR #1989](https://github.com/vite-hub/vitehub/pull/1989), with the merged fixes from
[#1987](https://github.com/vite-hub/vitehub/pull/1987),
[#1984](https://github.com/vite-hub/vitehub/pull/1984), and
[#1907](https://github.com/vite-hub/vitehub/pull/1907). It includes durable CI recovery,
host repair commits, serialized dependency installation with a two-minute admission
timeout, private validated dependency snapshots, protected native tool authorization, and asynchronous merges.

Generated webhook routes check their selected handler before reading the request
body. The application typecheck covers these routes with checked indexed access.

Conflict preparation reads the live target branch ref. A stale PR base snapshot
cannot turn a real conflict into an empty merge. Repair commit and push guards
check that live ref again before publication.

The host fetches the exact live base before preparing that merge and binds base-CI
tools to the same commit. Copied instruction files are restored to the assigned PR
head before base preparation, then generated provider instructions are injected
after preparation, preserving tracked instruction changes. Terminal provider usage is
retained after successful, failed, and aborted turns for admission accounting.

The host preserves validated Yarn linker and layout settings while isolating
project plugins and package-manager executables. Virtual peer locators retain
validation of their nested source. Configuration changes invalidate installed dependencies. Linked package
commands contribute their contents and executable mode to the installation
fingerprint. Reused validation snapshots refresh generated commands and remove
deleted copies. Newly staged commands retain the protected index's bytes, and
staged deletions stay deleted. Descriptor-bound reads reject concurrent source
replacement.

Prepared checkout ownership is explicit. Ordinary provider launchers still
create their Workspace baseline; host-prepared repair launches retain their Git
ancestry and merge index. The checkout watcher checks the actual provider HEAD
before an older push receipt. Lease renewal and durable finish retain the
verified publication chain while synchronize webhooks are pending. Source-branch
push evidence fences unrelated SHAs and original-head rollbacks before the PR head
updates. Failed CI for a verified pending repair head still revokes publication.
Before a push, the host durably associates the validated candidate SHA with the
active claim so CI arriving before source-push and synchronize webhooks is retained.
This association does not count as a pushed commit. A synchronized candidate
retires older abandoned candidates while retaining later pending publications.
An explicit overflow flag fences a claim that cannot retain every source-push
receipt; a fresh claim clears that flag and starts with complete evidence.
Admission parking after several
pushes retains the full verified publication chain. The pass can resolve multiple
addressed review threads despite its own resolution webhooks; external reopens and
new feedback still revoke custody.
Stack retargeting checks the live child and durable claim before changing its base.
Host installation requires Git and Corepack in trusted PATH. Dynamic admission is
checked again after setup before dispatching a provider.

Repair staging includes restored tracked instructions marked skip-worktree. The
host clears that flag only for explicitly named repair paths and retains the
prepared merge ancestry and index guards. Box admission is checked immediately
before each provider dispatch, including retries after metadata creation.

The upstream package owns durable status delivery and recovery of worker failures. Saving a pass result also queues its
managed PR comment in the same SQLite transaction. GitHub delivery retries survive
restarts, find an existing comment after an uncertain response, and coalesce newer
results. Hosts claim each delivery atomically and renew the five-minute lease
until its external write settles. Deferred repair comments yield the batch to
other PRs. Up to five publications run outside scheduling, remain tracked during
drain, and request cancellation after twenty seconds. Saved statuses use their
own activity run IDs. New feedback, active claims, and replaced heads discard obsolete deliveries. If a replaced writer settles late, the host queues a corrective replay of the latest saved result with a fresh activity identity. A lease cannot revoke an HTTP write already accepted by GitHub. Posting does not require a
model invocation or native MCP approval. The host selects the GitHub App installation
for each repository owner, using configured mappings or App discovery. Concurrent
admission checks share one journal scan. Health can reuse its timestamped accounting
for at most two minutes while dispatch waits for the current scan.

Replaced writers retain durable correction for fifteen minutes after their last
delivery lease. Active writers extend this deadline with lease heartbeats. A
crashed writer's marker then retires so the outbox can drain. Observed late
settlement queues the current status again; an unobserved remote write after the
deadline can still overwrite the comment. Channels using the same GitHub host
serialize publication before resolving credentials, even when callbacks differ
or tokens rotate. Credential resolution and read stages have thirty-second bounds
combined with caller cancellation. A stalled credential or lookup callback releases
the local queue. An already-started write requests cancellation at the deadline but
retains target ordering and its durable delivery lease until its transport settles.
A custom transport that never settles can hold that target queue. Reopening
a closed PR queues the new status even while worker capacity is unavailable.
A reopen releases custody from the closed lifetime. A late saved status during a
worker pass queues a running correction bound to that worker's durable claim,
so it can publish before the pass ends.

Known worker blockers, including rejected MCP approvals, read-only Git metadata,
sparse instruction staging, and dependency guards rejected after successful
refresh, are rechecked once per application release. That wake also clears the
old Actions-permission fallback so the corrected host can run a fresh repair.
An unchanged worker failure stays
parked for that release. External dependencies retain their existing wake rules.
Idle CI recovery preserves worker blockers so deployment can retry them.
Compiled packages carry a source and dependency fingerprint. Direct-source hosts
derive the same revision when no application release is configured, so a corrected
source deployment can wake a worker blocker while an unchanged restart stays parked.
New evidence queues the current managed status even when work was already ready
or an older owner finishes after its generation was superseded.
The published provider adapter already preapproves the exact host-authorized tool
names for unattended runs.

Consumer tests verify the installed package through its public inbox and GitHub
credential APIs. ViteHub owns the detailed delivery and recovery regression tests.
The application no longer applies an Agent package patch.

Update the preview after validating the ViteHub source, then run the release
script against the exact application commit. The release script builds and tests
that commit, smoke-boots scratch data, verifies the systemd preflight, drains the
worker, and watches the new release for health and resource failures.

## Service admission policy

The app maps `BABYSITTER_HOURLY_INPUT_TOKENS`, `BABYSITTER_DAILY_INPUT_TOKENS`
and `BABYSITTER_MIN_FREE_TMP_MB` into the preset's explicit `admission` options.
Defaults are 15M hourly tokens, 200M daily tokens and 4096 MiB free temporary space.
The deployed service overrides the hourly limit to 1000M. Token thresholds use the
retained invocation journal and are best-effort admission guards. A zero token
limit stops new model passes while host merges and recorded waits continue.
`BABYSITTER_PAUSED=1` stops every claim for maintenance. The release smoke keeps
its zero hourly limit and author filter.

The app's `admission.check` reads sanitized provider counters from
`BABYSITTER_PROXY_STATUS_FILE`, defaulting to `/srv/cliproxy-status/accounts.json`.
`BABYSITTER_PROXY_PROVIDER` defaults to `codex`,
`BABYSITTER_PROXY_MAX_WEEKLY_PERCENT` to 80, and
`BABYSITTER_PROXY_STATUS_MAX_AGE_S` to 900. Fresh exhausted accounts or a spent
weekly threshold pause model passes. Missing, unreadable, stale or invalid status
does not pause admission. These are application settings; the framework reads
no provider-specific file or admission environment variables.
