# Babysitter

A ViteHub Agent that repairs pull requests, waits for checks and merges the ready ones. It extends
ViteHub's [Babysitter preset](https://vitehub.dev/docs/agents/babysitter), which owns webhook intake,
the durable PR queue, checkouts, CI evidence, repair tools, budgets and merge checks. This repository
only configures it:

| File | What it sets |
| --- | --- |
| [`server/agents/babysitter/agent.ts`](server/agents/babysitter/agent.ts) | Repositories, authors, merge policy, budgets and model |
| [`server/agents/babysitter/instructions.md`](server/agents/babysitter/instructions.md) | Our house rules, added to the preset's repair prompt |
| [`server/agents/babysitter/config.ts`](server/agents/babysitter/config.ts) | The environment variables that `agent.ts` reads |
| [`vite.config.ts`](vite.config.ts) | Node host, Agent State, observability |

Who and what to trust comes from the environment:

- `BABYSITTER_MAINTAINERS`: logins whose PRs get repaired and squash-merged. Without it, the worker
  takes PRs from the repositories' owners, members and collaborators, and ignores the two lists below.
- `BABYSITTER_CONTRIBUTORS`: outside contributors. Their PRs get the same repairs, but merge only
  after a maintainer approves the current head.
- `BABYSITTER_BOT_AUTHORS` (default `renovate,dependabot`): bots whose PRs get worked. Add your
  GitHub App's name if it opens PRs.
- `BABYSITTER_REVIEW_CHECKS` (default none): the check names an automated reviewer posts.

[`.env.example`](.env.example) lists the rest.

## Run your own

Fork this repository and edit `instructions.md` for your reviewer. Then:

1. Create a GitHub App under Settings → Developer settings → GitHub Apps.
   - Webhook URL: `https://<your-host>/api/webhooks/github`, with a random webhook secret.
   - Repository permissions: Contents, Pull requests, Issues and Checks read and write; Actions,
     Commit statuses and Metadata read. Add Workflows write if repairs may touch `.github/workflows`.
   - Events: Pull request, Pull request review, Pull request review comment, Pull request review
     thread, Issue comment, Check run, Check suite, Status, Push and Workflow run.
   - Generate a private key and install the App on the repositories to watch.
2. `cp .env.example .env` and fill in the required values.
3. Start it and log Codex in once. The login lands in the `/data` volume.

   ```sh
   docker compose up -d --build
   docker compose exec babysitter codex login --device-auth
   curl -fsS localhost:3000/api/_vitehub/host/health
   ```

Expose only `/api/webhooks/github` to the internet, through a reverse proxy or tunnel. To read the
queue and sessions in the [ViteHub Console](https://vitehub.dev/docs/development/console), link the
app there and set the `VITEHUB_CONSOLE_KEY_<NAME>` line it shows.

To restart without interrupting running passes, drain first:

```sh
docker compose kill -s SIGUSR2 babysitter
until curl -s localhost:3000/api/_vitehub/host/drain | grep -q drained; do sleep 10; done
docker compose up -d --build --force-recreate
```

## Run on a host

vite-hub's own Babysitter runs as the `babysitter-vitehub` systemd service on Slimbook. Its settings
live in drop-ins under `/etc/systemd/system/babysitter-vitehub.service.d/`. Deploy a merged commit with
`scripts/deploy.sh` from a clean `origin/main` checkout: it builds, stages a release directory, drains
the service and restarts it. Before you run it, check that no other deploy is draining
(`pgrep -af '^bash scripts/deploy.sh'`).

On any host, Agent State goes to `.vitehub/agent-state.db` under the working directory. Set
`VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` too, such as `file:/srv/babysitter/.vitehub/invocations.sqlite`:
without it, the Console journal lands in the build checkout. Run one process per data directory.

## Repair a red main

PR checks run the fast suites and main runs the full ones, so PRs that each pass can break main
together. Set `BABYSITTER_MAIN_REPAIR_REPOS` and, when a workflow in `BABYSITTER_MAIN_REPAIR_WORKFLOWS`
(default `ci`) fails on one of those repositories' default branch, the worker opens a
`babysitter/repair-main-*` PR and repairs it first. This is the preset's
[`mainRepair`](https://vitehub.dev/docs/agents/babysitter#repair-a-red-default-branch); the App needs
the Workflow run event and Actions write access.

## ViteHub version

`package.json` pins a `pkg.pr.new` build of ViteHub main, and the overrides in `pnpm-workspace.yaml`
keep every `@vite-hub/*` package on that commit. To upgrade, pick a main commit whose `ci` and
`pkg.pr.new` runs passed, replace the SHA in both files and run `pnpm install`.

Fix ViteHub bugs in ViteHub and upgrade to the commit that has the fix. Don't patch the installed
packages here.
