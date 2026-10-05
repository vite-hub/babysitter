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
