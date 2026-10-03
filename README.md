# Babysitter

Babysitter uses ViteHub agents to repair and squash-merge pull requests authored by `onmax`. GitHub webhooks update a durable SQLite inbox. Events for each PR coalesce before a worker starts. Babysitter never closes pull requests.

## How it works

```mermaid
flowchart TD
    webhook[GitHub webhook] --> inbox[Save delivery and update PR snapshot]
    inbox --> eligible{Actionable change?}
    eligible -- Pending CI only --> wait[Keep state without starting an agent]
    eligible -- Feedback or completed check --> queue[Claim oldest eligible PR generation]
    queue --> checkout[Prepare exact-head checkout with Git]
    checkout --> capacity[ViteHub capacity admission]
    capacity --> agent[Agent receives short PR task]
    agent --> repair[Repair and push]
    agent --> merge[Verify live merge gate and squash merge]
    agent --> retry[Persist retry or external wait]
    repair --> webhook
    merge --> webhook
    retry --> queue
```

The [inbox](server/babysitter.inbox.ts) stores deliveries, snapshots, generations,
leases and retry times in `.vitehub/pull-request-inbox.sqlite`. The
[scheduler](server/babysitter.schedule.ts) checks local eligibility every ten seconds.
A missed-event recovery reads at most one PR per minute, at most once per PR every
15 minutes; open-PR bootstrap repeats every 30 minutes. Stack children wait for their
open parents. New-head or closed-PR events cancel the old worker.

Initial hydration reads paginated REST feedback and targeted GraphQL thread metadata.
Resolution is cached and updated by thread webhooks, with targeted verification after
changes. Queued/running CI is retained without starting another pass. Check failures,
completion and relevant feedback wake work. Activity comments do not wake their own agent.

The agent receives a short [task prompt](server/agents/babysitter/prompt.template.md)
identifying the PR, branch and prepared commit, with instructions to address feedback,
make CI green and resolve conflicts. It reads current feedback and CI details from
GitHub as needed. Snapshot history stays in the durable inbox instead of the prompt.

The [worker instructions](server/agents/babysitter/instructions.ts) define permissions,
merge gates and the result format. Each pass reads the prepared repository's current
`AGENTS.md` and composes it with those instructions.
A pass pushes a repair, merges eligible work, retries unfinished work, or records a
reproducible external wait. It returns validated `{ disposition, text }` output.

ViteHub owns process capacity, invocation persistence/recovery, GitHub authentication,
activity comments and Console delivery. The Node-specific inbox currently owns PR
snapshots, eligibility and leases; it is not yet a provider for ViteHub's generic Queue
module. Babysitter consumes the latest ViteHub `main` preview from `pkg.pr.new`, so
upstream fixes are used without local dependency patches. One process owns the data
directory.

Generic review and merge-conflict skills use pinned GitHub Sources from ViteHub.
They are configured in the [agent definition](server/agents/babysitter/agent.ts).

## Requirements

Before/after images and demonstration videos are optional for Babysitter, including when a watched repository's general contribution rules require them. Only a current maintainer request for media on a specific pull request makes it required. Babysitter removes blockers and pending-upload notes based only on the generic media rule. Checks and actionable review findings still control the merge gate.

> [!WARNING]
> Babysitter uses your host and credentials to edit code, push branches, change pull requests, and merge them. Read the [worker instructions](server/agents/babysitter/instructions.ts) before running it.

- Node.js 24 or newer
- Corepack, which activates Babysitter's pinned pnpm version
- `git` and a GitHub repository you want Babysitter to watch. Babysitter launches the owner in an exact-head checkout without installing the watched project's dependencies; adapt the [agent prompt](server/agents/babysitter/prompt.template.md) if the owner needs package-manager-specific setup.
- [`gh`](https://cli.github.com/) CLI. Configure the `vitehub-bot` GitHub App with Contents, Issues, and Pull requests read/write access plus Actions, Checks, Commit statuses, and Metadata read access. Install it on every repository Babysitter watches and every source fork it needs to push.
- An authenticated coding-agent CLI. ViteHub [Agent Drivers](https://vitehub.dev/docs/agents/agent-drivers) support both Codex and Claude Code. [Codex](https://github.com/openai/codex) is recommended because its non-interactive `codex exec` command is designed for programmatic use; this repository uses Codex by default.
- `bubblewrap` on Linux. Codex can fall back to its bundled copy, but installing the host package removes the fallback warning and makes the sandbox prerequisite explicit.

## Start Babysitter

1. Read and adapt the [worker instructions](server/agents/babysitter/instructions.ts) so its permissions, review policy, and merge rules match your repository.

2. Install the dependencies and start Babysitter with repository names. `BABYSITTER_REPOS` accepts comma- or space-separated `OWNER/REPOSITORY` values. `BABYSITTER_MAX_OWNERS` sets the global hard ceiling and defaults to `1`. Adaptive admission can run fewer owners, but never more. The singular `BABYSITTER_REPO` remains supported and defaults to `vite-hub/vitehub` when the plural setting is empty.

   ```sh
   corepack enable
   pnpm install
   BABYSITTER_REPOS=OWNER/REPOSITORY,OWNER/ANOTHER_REPOSITORY \
   pnpm dev
   ```

   A long-running Babysitter should use GitHub App credentials. The server mints renewable installation tokens and projects only the active token plus the `vitehub-bot[bot]` commit identity into each agent process:

   ```sh
   GITHUB_APP_ID=4698907 \
   GITHUB_APP_INSTALLATION_ID=156121915 \
   GITHUB_APP_OWNER=vite-hub \
   GITHUB_APP_PRIVATE_KEY='-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----' \
   pnpm dev
   ```

   For repositories owned by another account or organization, install the same App there and provide the owner-to-installation mapping:

   ```sh
   GITHUB_APP_INSTALLATIONS='{"vite-hub":156121915,"nuxt-modules":159985432}'
   ```

   Babysitter uses the matching installation for each repository, including GitHub activity comments and worker commands. Repositories without an App installation remain waiting with a recorded blocker. The service rejects personal GitHub tokens at startup.

   To mirror invocation sessions and export completed OTLP traces to ViteHub Console, set its base URL and bearer token:

   ```sh
   VITEHUB_CONSOLE_URL=https://console.example \
   VITEHUB_CONSOLE_TOKEN=replace-me \
   pnpm dev
   ```

To use Claude Code instead, install and authenticate its CLI. In the [agent definition](server/agents/babysitter/agent.ts), set `driver.kind` to `claude-code`, choose a Claude model, and set the process host's `providerCommand` to `claude`.

## Operations

`GET /api/health` reports provider availability, GitHub budget, admission, and stale
invocations through ViteHub's `createAgentHealth`. Its Release diagnostic and each
Agent Invocation identify the application commit embedded at build time.
The Agent module exports health
and Workspace inspection; `agentHostRoutes` generates their HTTP routes. `GET /api/drain` reports the process drain status. Before an authorized restart, send `SIGUSR2` to the service main process to use ViteHub's built-in drain. Poll `/api/drain` until `status` is `drained`, then replace the release. This stops new claims while existing owners finish. Build and typecheck the exact release commit, then
verify health and a completed pass or justified wait after restart.

ViteHub writes process lifecycle diagnostics. Babysitter adds `[babysitter]` JSON
batch and owner events with the PR, outcome, and duration. The diagnostics capability
records resource samples and terminal invocation events. See the
[ViteHub process host documentation](https://github.com/vite-hub/vitehub/tree/main/packages/agent#process-owned-agents)
for storage recovery and shutdown.

## Webhook and proxy configuration

Set `BABYSITTER_PUBLIC_URL` to the service origin and configure
`GITHUB_WEBHOOK_SECRET`. Point the repository webhook at `/webhooks/github` with:

- `pull_request`, `issue_comment`, `pull_request_review`, `pull_request_review_comment`
- `pull_request_review_thread`
- `check_run`, `check_suite`, `workflow_run`, `status`, `push`

The receiver verifies signatures and persists delivery IDs to ignore duplicate deliveries.
ViteHub owns the compact activity comment; agents do not edit it directly.

Pullfrog dispatches its workflow on the default branch. Use the PR head's
`pullfrog` check to detect an active review and `pullfrog-approval`, when enabled,
to read the verdict for the reviewed commit. Do not match the workflow SHA to the
PR SHA or use an eyes reaction as a running signal. Automatic incremental review
and incorporating new commits into an active review are Pullfrog settings, not a
second GitHub Actions trigger owned by Babysitter.

A mechanical follow-up can preserve prior review evidence, but an active review
of the current head still must finish. The agent parks while only checks or review
are pending; webhook updates resume the durable queue. It does not run `gh watch`.
A successful repair push can finish resolving addressed threads before its claim
ends. The scheduler verifies that head against the actual provider checkout;
another head or a closed PR still cancels the pass.

The worker environment removes source-checkout Git directory/index overrides after
restoring the provider Git metadata. The model and cancellation watcher must use
the same physical Git repository; authentication settings remain available.
The provider launcher records its final Git HEAD outside the disposable workspace
before that workspace is removed. The cancellation watcher can use this proof
when cleanup has already started. Temporary Git verification failures receive
three retries at ten-second intervals; a verified different head still cancels.
Cancelled PRs receive a durable cooldown of one, two, four, then five minutes.
New webhook events remain queued and cannot bypass that cooldown. Successful
passes reset it. Cancellation logs retain the specific reason.

Before launching a provider, the scheduler evaluates cached branch rules and classic
required-check protection to decide whether repair or a continued wait is needed.
The worker retrieves failed-job logs when diagnosing CI, rather than receiving them
and the full review history inline on every pass.

Agents can return `waitForChecksHead` when no independent repair remains. The
scheduler retains that checkpoint and coalesces intermediate CI updates without
another invocation. New feedback, failures, conflicts, intent, base or head changes
resume repair. Passing required checks resume the merge pass, unless the current
head's Pullfrog check remains active. Cached evidence never authorizes a merge;
the final merge gate still verifies live state. A required context missing from
`gh pr checks --required` remains pending until it appears or authoritative branch
policy proves the requirement was removed.

Production GitHub CLI traffic uses `ghx.onmax.me`. Install
[scripts/worker-ghx.sh](scripts/worker-ghx.sh) at both
`/home/agents/.local/bin/gh` and `/home/agents/.local/worker-ghx/bin/gh`.
Login shells may select the first path even when the driver prepends the second.
The wrapper sets the proxy host and normalizes repository selection. The driver also
sets `GH_REPO` per worker. Git fetch/push use the repository's Git remote.

Run the regression suite with:

```sh
node --experimental-transform-types --test tests/*.test.ts
pnpm typecheck
pnpm build
```
