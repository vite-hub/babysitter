# Babysitter

Ship changes as PRs to `main`. To release, check out the merged `origin/main` detached, run `pnpm install --frozen-lockfile`, and run `scripts/deploy.sh` in the background. It drains running passes before the restart, which can take 40 minutes. Check first that no other session is deploying: `pgrep -af '^bash .*scripts/deploy\.sh'`.

To restart without a release, drain first, because a plain restart interrupts running passes:

```sh
sudo systemctl kill --kill-whom=main --signal=SIGUSR2 babysitter-vitehub.service
until curl -s localhost:3028/_vitehub/host/drain | grep -q drained; do sleep 10; done
sudo systemctl restart --no-block babysitter-vitehub.service
```

A release is done when `localhost:3028/_vitehub/host/health` reports the new `release`, the journal shows webhooks answered with 202, and a PR changes state on GitHub: a pass pushes, or the vite-hub App merges.

Stop the service before writing `agent-state.db`. A write while it runs makes every service transaction fail with `SQLITE_BUSY_SNAPSHOT` until the next restart.
