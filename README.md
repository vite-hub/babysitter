# Babysitter

Babysitter is a [ViteHub](https://github.com/vite-hub/vitehub) agent that converges open pull requests across configured GitHub repositories in bounded repair passes. It discovers work on startup, after an owner finishes, and through a two-minute repair scan. A shared adaptive capacity gate starts only the work that the host can support and keeps the rest as pending Agent Invocations.

## How it works

```mermaid
flowchart TD
    wake["Startup, owner completion, or repair scan"] --> discover["Read open pull requests from GitHub"]
    discover --> unchanged{"Observed state unchanged?"}
    unchanged -- Yes --> wait["Wait for the next wake"]
    unchanged -- No --> gate{"Only waiting for checks?"}
    gate -- Yes --> wait
    gate -- No --> checkout["Create a disposable exact-head checkout"]
    checkout --> pending["Create a pending Agent Invocation"]
    pending --> capacity{"Host capacity available?"}
    capacity -- No --> pending
    capacity -- Yes --> agent["Start one coding agent"]
    agent --> work["Codex (or Claude Code) uses Skills and your own instructions to work on the PR"]
    work --> outcome{"Outcome"}
    outcome -- Repaired --> review["Push one commit and request review"]
    review --> park["Record the observed pull request fingerprint"]
    outcome -- Waiting --> park
    outcome -- Ready --> merge["Merge and delete the source branch"]
    outcome -- Obsolete --> close["Close the pull request"]
    outcome -- External blocker --> block["Record the blocker"]
    block --> park
    park --> wake
    merge --> wake
    close --> wake
```

The [scheduler](server/babysitter.schedule.ts) selects changed PRs and applies the
[queue policy](server/babysitter.queue.ts). It leaves a PR waiting without a model
session when checks are pending and there is no discussion, failed check, or
conflict to handle. Package-preview comments, Codex quota notices, and timestamp-only
feedback edits do not wake a parked pass.

The [agent prompt](server/agents/babysitter/prompt.template.md) owns review and merge
policy. Each pass makes at most one repair commit, merges ready work, closes obsolete
work, or records the next gate. It returns validated `{ disposition, text }` output.

ViteHub owns GitHub snapshots, exact-head checkouts, isolated credentials, session
identity, activity comments, process capacity, invocation recovery, drain, and Console
delivery. The [host configuration](server/host.ts) uses those APIs. See
[ViteHub process-owned agents](https://github.com/vite-hub/vitehub/tree/main/packages/agent#process-owned-agents)
for lifecycle and storage behavior. The data directory must belong to one process.

Generic review and merge-conflict skills use pinned GitHub Sources from ViteHub.
They are configured in the [agent definition](server/agents/babysitter/agent.ts).

## Requirements

Before/after images and demonstration videos are optional for Babysitter, including when a watched repository's general contribution rules require them. Only a current maintainer request for media on a specific pull request makes it required. Babysitter removes blockers and pending-upload notes based only on the generic media rule. Checks and actionable review findings still control the merge gate.

> [!WARNING]
> Babysitter uses your host and credentials to edit code, push branches, change pull requests, and merge them. Read the [agent prompt](server/agents/babysitter/prompt.template.md) before running it.

- Node.js 24 or newer
- Corepack, which activates Babysitter's pinned pnpm version
- `git` and a GitHub repository you want Babysitter to watch. Babysitter launches the owner in an exact-head checkout without installing the watched project's dependencies; adapt the [agent prompt](server/agents/babysitter/prompt.template.md) if the owner needs package-manager-specific setup.
- [`gh`](https://cli.github.com/) CLI. For production, configure a GitHub App with Contents, Issues, and Pull requests read/write access plus Actions, Checks, Commit statuses, and Metadata read access. Install it on every repository Babysitter watches. Local development can fall back to `GITHUB_TOKEN` or an authenticated `gh` CLI.
- An authenticated coding-agent CLI. ViteHub [Agent Drivers](https://vitehub.dev/docs/agents/agent-drivers) support both Codex and Claude Code. [Codex](https://github.com/openai/codex) is recommended because its non-interactive `codex exec` command is designed for programmatic use; this repository uses Codex by default.
- `bubblewrap` on Linux. Codex can fall back to its bundled copy, but installing the host package removes the fallback warning and makes the sandbox prerequisite explicit.

## Start Babysitter

1. Read and adapt the [agent prompt](server/agents/babysitter/prompt.template.md) so its permissions, review policy, and merge rules match your repository.

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

   Repositories outside `GITHUB_APP_OWNER` keep using `GITHUB_TOKEN` or the host's existing `gh` login, so one Babysitter can retain queues that span accounts.

   To mirror invocation sessions and export completed OTLP traces to ViteHub Console, set its base URL and bearer token:

   ```sh
   VITEHUB_CONSOLE_URL=https://console.example \
   VITEHUB_CONSOLE_TOKEN=replace-me \
   pnpm dev
   ```

To use Claude Code instead, install `@ai-sdk/harness-claude-code`, then replace `codexDriver()` with `claudeCodeDriver()` in the [agent definition](server/agents/babysitter/agent.ts).

## Operations

`GET /api/health` reports provider availability, GitHub budget, admission, and stale
invocations. `GET /api/drain` reports the process drain status. Drain active work
before replacing a release. Build and typecheck the exact release commit, then
verify health and a completed pass or justified wait after restart.

ViteHub writes process lifecycle diagnostics. Babysitter adds `[babysitter]` JSON
batch and owner events with the PR, outcome, and duration. The diagnostics capability
records resource samples and terminal invocation events. See the
[ViteHub process host documentation](https://github.com/vite-hub/vitehub/tree/main/packages/agent#process-owned-agents)
for storage recovery and shutdown.

## Runtime ownership

Babysitter keeps PR selection, actionable-change fingerprints, review policy, and the bounded repair prompt. ViteHub owns work checkpoints and retry backoff, invocation recovery, scheduled output validation, GitHub activity comments, and immutable Workspace inspection. Thrown failures receive the same cooldown as explicit retries.

Set `BABYSITTER_PUBLIC_URL` to the public service origin so activity comments link directly to the live invocation in ViteHub Console. Enable `pull_request` events on the GitHub App and route them to `/api/_vitehub/agents/babysitter/webhooks/github`; configure the matching `GITHUB_WEBHOOK_SECRET`. The Channel claims one comment when a PR opens, showing “Waiting to start.” until execution or a known wait reason is available. One table lists current and recent session links, status, relative start times, and completed durations. Task checkboxes and the latest result appear below; previous results are collapsed. The coding agent does not edit that comment.

Passes return validated `{ disposition, text }` output. Completion records use ViteHub's versioned checkpoint schema. Upgrading from legacy fingerprints causes one fresh evaluation of previously parked open PRs; subsequent unchanged passes remain parked.
