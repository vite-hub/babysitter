#!/usr/bin/env bash
# Builds the committed HEAD, stages it as a release, drains the running service and restarts onto it.
# Usage: scripts/deploy.sh   (run from a clean, committed checkout of origin/main; needs sudo)
set -euo pipefail
unit=babysitter-vitehub.service
dropin=/etc/systemd/system/$unit.d/release.conf
port=$(systemctl show "$unit" -p Environment | grep -oP 'PORT=\K\d+')
api=localhost:$port/api/_vitehub/host
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain -- pnpm-lock.yaml server package.json vite.config.ts)" ] || { echo "commit first: the build bakes in the git SHA" >&2; exit 1; }
sha=$(git rev-parse HEAD)
# GIT_SHA, because an overflow host builds from a mirror without .git.
CI=1 GIT_SHA=$sha BABYSITTER_PUBLIC_URL=https://babysitter.vitehub.dev HEAVY_WAIT=0 heavy pnpm build >/tmp/babysitter-build.log 2>&1
grep -rq "$sha" .output/server || { echo "build does not contain $sha" >&2; exit 1; }

previous=$(grep -oE '/home/workspace/babysitter-release-[^/]+' "$dropin" | head -1)
release=/home/workspace/babysitter-release-${sha:0:8}-$(date +%Y%m%d%H%M)
owner=$(sudo stat -c %U:%G "$previous")
sudo install -d -o "${owner%:*}" -g "${owner#*:}" "$release"
sudo cp -a .output "$release/"
sudo chown -R "$owner" "$release"
sudo -u "${owner%:*}" /usr/local/bin/node --check "$release/.output/server/index.mjs"
# The main guardian timer runs this stable copy.
sudo install -o "${owner%:*}" -g "${owner#*:}" -m 0755 scripts/main-guardian.mjs /home/workspace/babysitter-data/bin/main-guardian.mjs
sudo cp "$dropin" "/tmp/release.conf.$(basename "$previous")"
sed "s#$previous#$release#g" "$dropin" | sudo tee "$dropin.new" >/dev/null
sudo mv "$dropin.new" "$dropin"
sudo systemctl daemon-reload
echo "staged $release (previous: $previous)"

# SIGUSR2 stops new claims and lets running passes finish; SIGTERM would interrupt them.
sudo systemctl kill --kill-whom=main --signal=SIGUSR2 "$unit"
echo "draining since $(date -u +%T)Z"
until curl -s -m 5 "$api/drain" | grep -q '"drained"'; do sleep 10; done
echo "drained at $(date -u +%T)Z"

old_pid=$(systemctl show "$unit" -p MainPID --value)
restarted() { local pid; pid=$(systemctl show "$unit" -p MainPID --value); [ "$pid" != 0 ] && [ "$pid" != "$old_pid" ]; }
sudo systemctl restart --no-block "$unit"
for _ in $(seq 60); do restarted && break; sleep 1; done
# TimeoutStopSec=infinity leaves a blocked main thread hanging forever; nothing runs after a drain.
restarted || { echo "stop hung after drain; sending SIGKILL" >&2; sudo systemctl kill --kill-whom=main --signal=SIGKILL "$unit"; }
until curl -s -m 5 "$api/health" | grep -q '"status":"ok"'; do sleep 3; done
pid=$(systemctl show "$unit" -p MainPID --value)
sudo grep -q "$release" "/proc/$pid/cmdline" || { echo "running process is not $release" >&2; exit 1; }
echo "live ${sha:0:8} at $(date -u +%T)Z"
