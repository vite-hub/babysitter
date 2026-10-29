# Slimbook shared-resource guards

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

Set these in a `babysitter-vitehub.service.d` drop-in. The defaults are in parentheses.

- `BABYSITTER_MIN_FREE_TMP_MB` (4096): skip a pass when `os.tmpdir()` has less free space.
- `BABYSITTER_HOURLY_INPUT_TOKENS` (15M), `BABYSITTER_DAILY_INPUT_TOKENS` (200M): budgets per
  local clock hour and calendar day. A value of 0 pauses admission.
- `BABYSITTER_PROXY_MAX_WEEKLY_PERCENT` (80): pause when the provider's accounts average this
  much weekly use. Also pause when no account is usable.
- `BABYSITTER_PROXY_STATUS_FILE` (`/srv/cliproxy-status/accounts.json`) and
  `BABYSITTER_PROXY_STATUS_MAX_AGE_S` (900): if the status file is stale, the guard ignores it.

`/api/health` shows `admission` and `budget`. Skips are logged as `babysitter.admission.skipped`.

## Releases

`pnpm release <sha>` builds, tests, stages, smoke-boots, switches `release.conf`, drains,
restarts, and watches for 15 minutes before it finishes. `--smoke-only` stops before it
touches the live service.

The release also runs `scripts/install-host-files.sh` (`deploy.sh` and `deploy-compact.sh` do too).
It installs the files the service uses from outside its release directory, from the released commit:

| File | Installed at |
| --- | --- |
| `scripts/heavy-command-gate.cjs` | `/home/workspace/babysitter-data/bin/worker/heavy-command-gate.cjs` (root-owned) |
| `scripts/worker-bin/*` | `/home/workspace/babysitter-data/bin/worker/worker-bin/` |
| one empty lock per `BABYSITTER_HEAVY_SLOTS` | `heavy-command.lock`, `heavy-command.lock.1`, … next to the gate (root-owned, created once) |
| `scripts/main-guardian.mjs` | `/home/workspace/babysitter-data/bin/main-guardian.mjs` |
| `ops/tmp-retention.mjs` | `/home/workspace/babysitter-data/bin/tmp-retention.mjs` (root-owned) |

A rollback switches only `release.conf`; these files stay, and they work with older releases.

The build, typecheck and tests run through `heavy`.

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
