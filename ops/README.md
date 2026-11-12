# Babysitter operations

Host files that keep the Babysitter, and any one user, from exhausting resources that
every session on Slimbook shares. Installed copies are the source of truth on the host;
keep these in sync when you change them.

## /tmp quota (`tmp-quota/`)

`/tmp` is one 15 GiB tmpfs. Every non-root user gets a 3 GiB block quota, and maxi gets 9 GiB.

| File | Installed at |
| --- | --- |
| `quota.conf` | `/etc/systemd/system/tmp.mount.d/quota.conf` |
| `tmp-quota.service` | `/etc/systemd/system/tmp-quota.service` (enabled, `WantedBy=tmp.mount`) |
| `tmpfs-user-quota` | `/usr/local/sbin/tmpfs-user-quota` |

Quotas can only be enabled when tmpfs is first mounted, and the kernel rejects them on
remount. They take effect at the next boot. `tmpfs-user-quota` sets per-user limits through
`quotactl_fd(2)`, because quota-tools 4.09 can't address tmpfs.

## Resource alerts (`resource-alerts/`)

`resource-alerts.timer` runs every 5 minutes as a `svc-cliproxy` user unit. Each run does three things:

- Writes `/srv/cliproxy-status/accounts.json`, a sanitized per-account quota summary
  without emails or tokens. The Babysitter's admission guard reads this file.
- Alerts when `/tmp` passes 85%, a proxy account is unavailable or past 80% weekly use,
  or the Babysitter reaches its token budget.
- Reports each alert once, reminds every 6 hours while it stays active, and reports when
  it resolves.

Alerts are logged to the journal at warning priority (`sudo journalctl _UID=$(id -u svc-cliproxy) -p warning`).
To also post them to Discord, put a webhook URL in
`/srv/cliproxy/.config/resource-alerts/discord-webhook` (mode 600, owner `svc-cliproxy`).

| File | Installed at |
| --- | --- |
| `resource_alerts.py` | `/srv/cliproxy/.local/share/resource-alerts/resource_alerts.py` |
| `resource-alerts.service`, `.timer` | `/srv/cliproxy/.config/systemd/user/` |

## Babysitter admission limits

The installed worker uses GPT-6.1 Sol at `xhigh` through
`model/model.conf`, installed at
`/etc/systemd/system/babysitter-vitehub.service.d/model.conf`.
After changing this override, reload systemd, drain the worker, and restart it.

To install the override during an authorized service change:

```sh
sudo install -D -m 644 ops/model/model.conf /etc/systemd/system/babysitter-vitehub.service.d/model.conf
sudo systemctl daemon-reload
sudo systemctl kill --kill-whom=main --signal=SIGUSR2 babysitter-vitehub.service
curl -fsS http://127.0.0.1:3028/api/drain
# Repeat the drain check until it reports drained, then restart.
sudo systemctl restart babysitter-vitehub.service
curl -fsS http://127.0.0.1:3028/api/health
```

The drop-in sets `BABYSITTER_MODEL` and `BABYSITTER_REASONING_EFFORT`, which
`server/agents/babysitter/agent.ts` reads. Edit those values for another model.
Keep provider credentials in the service environment, outside this file.

Set these in a `babysitter-vitehub.service.d` drop-in. The defaults are in parentheses.

- `BABYSITTER_MIN_FREE_TMP_MB` (4096): skip a pass when `os.tmpdir()` has less free space.
- `BABYSITTER_HOURLY_INPUT_TOKENS` (15M), `BABYSITTER_DAILY_INPUT_TOKENS` (200M): budgets per
  local clock hour and calendar day. A value of 0 pauses admission.
- `BABYSITTER_PROXY_MAX_WEEKLY_PERCENT` (80): pause when the provider's accounts average this
  much weekly use. Also pause when no account is usable.
- `BABYSITTER_PROXY_STATUS_FILE` (`/srv/cliproxy-status/accounts.json`) and
  `BABYSITTER_PROXY_STATUS_MAX_AGE_S` (900): if the status file is stale, the guard ignores it.

`/api/health` shows `admission` and `budget`. Skips are logged as `babysitter.admission.skipped`.

## Unpark open PRs (`unpark.mjs`)

This is a manual recovery command, not a scheduled job. It updates every open,
non-terminal PR without a lease in the `babysitter` scope. In one transaction it:

- Clears the daily pass window when at least 16 passes occurred in the last 24 hours.
- Clears the repair push window when at least 5 pushes occurred in the last 24 hours.
- Sets a future or missing `wait.retryAt` to now on waiting rows.

The scheduler re-evaluates those rows on its next tick. Review push and no-progress
budgets stay in place and are reported on stderr. This does not approve or merge a
PR. The limits match `agent.ts` and the patched preset's `repairPushCap`; check them
when updating the preset. The script uses the current Agent State table layout.

Requires Node.js 24.15 or newer. Run from the repository root as the database owner.
`BABYSITTER_STATE_DB` selects the SQLite file and defaults to
`/home/workspace/babysitter-data/.vitehub/agent-state.db` for existing host callers.
Use stdin when the service user cannot traverse the checkout:

```sh
umask 077
sudo -u svc-babysitter env BABYSITTER_STATE_DB=/path/to/.vitehub/agent-state.db \
  node --input-type=module < ops/unpark.mjs > unpark-backup.json
```

For a checkout readable by the database owner, use
`BABYSITTER_STATE_DB=/path/to/.vitehub/agent-state.db node ops/unpark.mjs > unpark-backup.json`.
Stdout contains the original changed rows and meta values as JSON after commit;
stderr contains progress. Keep the backup private and outside Git. It can contain
PR state and is not a full database backup. Existing session callers use the stdin
form above. No service or timer in this repository invokes it.

## Observe merge cadence (`merge-cadence.sh`)

Run from the repository root on a Linux host with Bash, GNU date, grep, curl,
systemd, and an authenticated GitHub CLI. The command reads the service journal,
the local health endpoint, and GitHub. It does not change PRs or the service.
`sudo journalctl` needs journal access; authenticate sudo before a long run.

```sh
sudo -v
bash ops/merge-cadence.sh 600
```

The first report appears after the interval, in seconds. Omit it for 600 seconds.
Each line reports merged PRs, model passes, input tokens, quota blocks, queue
counts, skipped merges, and failed required checks on the watched main branch.
Press Ctrl-C to stop. The GitHub reads use the current `gh` account; configure
authentication with `gh auth login` or an environment token, never in the script.

| Environment variable | Default |
| --- | --- |
| `BABYSITTER_UNIT` | `babysitter-vitehub.service` |
| `BABYSITTER_PORT` | Service `PORT`, or `3028` |
| `BABYSITTER_REPOS` | Service `BABYSITTER_REPOS`, comma-separated `owner/repo` names |
| `BABYSITTER_MAIN_REPO` | `vite-hub/vitehub` |
| `BABYSITTER_MAIN_BRANCH` | `main` |

Set the overrides to observe another installation:

```sh
BABYSITTER_UNIT=babysitter.service BABYSITTER_PORT=4000 \
  BABYSITTER_REPOS=your-org/your-repo BABYSITTER_MAIN_REPO=your-org/your-repo \
  bash ops/merge-cadence.sh 60
```

This is a foreground observation command; no service or timer in this repository
invokes it. Merge counts inspect only the 50 most recently updated closed PRs per
repository. Required-check counts inspect only the first 100 check runs and the
branch protection `contexts` list. API failures can leave incomplete counts, so
use the output as an operational summary, not a merge decision.

## Measure review convergence (`review-metrics.mjs`)

Reads merged PRs from GitHub with the current `gh` account. It changes nothing.

```sh
node ops/review-metrics.mjs vite-hub/vitehub 2026-10-31 2026-11-07
```

A round is one PR head that Pullfrog reviewed. `ownRounds` leaves out heads that only merge
the base, which makes it comparable with Anthropic's review rounds (mean 2.08 before their
convergence changes, 1.32 after; 8.9% then 1.5% of PRs at 5+ rounds). Each thread is counted
by the `vitehub-babysitter-outcome:<kind>` marker that `resolveReviewThread` posts (fixed,
disproved, declined, pre-existing, duplicate). Threads without a marker only show whether the
line changed or the thread was closed unchanged. Baseline for vite-hub/vitehub, 2026-10-31 to
2026-11-07: own rounds mean 1.97, 50.4% pass in one round, 5.5% need 5+; Codex posted 720
threads (84% P2), 210 of them on a head that only merged main. Add `--json` for the full report.

## Releases

Run `scripts/deploy.sh` from a clean `origin/main` worktree. It builds the commit, stages it as a
release directory, switches `release.conf`, drains the service and restarts onto it. Add
`--compact` to stop after the drain and compact the state DB before the new release starts.
There is no smoke boot: host-only admission would merge real PRs.

The deploy also runs `scripts/install-host-files.sh`.
It installs the files the service uses from outside its release directory, from the released commit:

| File | Installed at |
| --- | --- |
| `scripts/heavy-command-gate.cjs` | `/home/workspace/babysitter-data/bin/worker/heavy-command-gate.cjs` (root-owned) |
| `scripts/worker-bin/*` | `/home/workspace/babysitter-data/bin/worker/worker-bin/` |
| one empty lock per `BABYSITTER_HEAVY_SLOTS` | `heavy-command.lock`, `heavy-command.lock.1`, … next to the gate (root-owned, created once) |
| `scripts/main-guardian.mjs` | `/home/workspace/babysitter-data/bin/main-guardian.mjs` |
| `ops/tmp-retention.mjs` | `/home/workspace/babysitter-data/bin/tmp-retention.mjs` (root-owned) |

A rollback switches only `release.conf`; these files stay, and they work with older releases.

The build, typecheck and tests run through `heavy`, and Corepack runs the pnpm that `package.json`
pins with its hash; the release stops if Corepack would run another one. Babysitter stays on pnpm
10.33.0: pnpm 12 rejects this lockfile, because its `pkg.pr.new` URL dependencies have no
integrity field (`ERR_PNPM_MISSING_TARBALL_INTEGRITY`). Worker installs of target repos follow
each target's own `packageManager`.

## Heavy-command gate

The service's `PATH` and every worker's `PATH` start with `BABYSITTER_WORKER_BIN`, whose `node`
preloads the gate. A Node process that runs `tsc`, `vitest`, `vp`, or a dependency install
(`pnpm install|i|add`, `npm install|ci`, directly or through Corepack) first takes one of
`BABYSITTER_HEAVY_SLOTS` host-wide `flock` slots, and waits while all are held. That includes
the host installs the service runs before a pass. Child processes inherit the lease, so a gated
command that runs another one does not wait again. Both settings are in `worker-gate.conf`.
A host install that waits more than its 10-minute timeout fails, and the pass starts without
dependencies, as it does for any failed install.

## TMPDIR retention (`babysitter-tmp-retention.*`)

`babysitter-tmp-retention.timer` runs `ops/tmp-retention.mjs` daily at 04:30 as `svc-babysitter`,
at idle IO and CPU priority. In `/home/workspace/babysitter-data/tmp` only, it removes:

- Node compile-cache files older than 48 hours, then the oldest ones until the cache is under 2 GiB
  (`BABYSITTER_COMPILE_CACHE_BUDGET_MB`). Corepack's shims turn the cache on for every pnpm run.
- Pass workspaces (the names the service's startup sweep uses) untouched for 48 hours, unless the
  state DB has an unfinished, non-waiting PR with that number or a process has its cwd or an open
  file inside. If it can't read the state DB, it keeps every workspace.

It never follows symlinks and refuses any root that is not a `tmp` directory, so the state
databases, backups, `bin/` and credentials are out of its reach. Check it with
`sudo -u svc-babysitter node /home/workspace/babysitter-data/bin/tmp-retention.mjs --dry-run`
and `sudo journalctl -u babysitter-tmp-retention`.

| File | Installed at |
| --- | --- |
| `babysitter-tmp-retention.service`, `.timer` | `/etc/systemd/system/` (enable the timer) |
