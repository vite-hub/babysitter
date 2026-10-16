#!/usr/bin/env bash
# Builds the committed HEAD, stages it as a release, drains the running service and restarts onto it.
# Usage: scripts/deploy.sh   (run from a clean, committed checkout; needs sudo)
# The smoke boot in scripts/release.mjs is skipped on purpose: host-only admission merges real PRs.
set -euo pipefail
unit=babysitter-vitehub.service
dropin=/etc/systemd/system/$unit.d/release.conf
port=$(systemctl show "$unit" -p Environment | grep -oP 'PORT=\K\d+')
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain -- patches pnpm-lock.yaml server package.json)" ] || { echo "commit first: the build bakes in the git SHA" >&2; exit 1; }
sha=$(git rev-parse HEAD)
CI=1 BABYSITTER_PUBLIC_URL=https://babysitter.vitehub.dev pnpm build >/tmp/babysitter-build.log 2>&1
grep -q "$sha" .output/server/index.mjs || { echo "build does not contain $sha" >&2; exit 1; }

previous=$(grep -oE '/home/workspace/babysitter-release-[^/]+' "$dropin" | head -1)
release=/home/workspace/babysitter-release-${sha:0:8}-$(date +%Y%m%d%H%M)
owner=$(sudo stat -c %U:%G "$previous")
sudo install -d -o "${owner%:*}" -g "${owner#*:}" "$release"
sudo cp -a .output "$release/"
sudo chown -R "$owner" "$release"
sudo -u "${owner%:*}" /usr/local/bin/node --check "$release/.output/server/index.mjs"
sudo cp "$dropin" "/tmp/release.conf.$(basename "$previous")"
sed "s#$previous#$release#g" "$dropin" | sudo tee "$dropin.new" >/dev/null
sudo mv "$dropin.new" "$dropin"
sudo systemctl daemon-reload
echo "staged $release (previous: $previous)"

sudo systemctl kill --kill-whom=main --signal=SIGUSR2 "$unit"
echo "draining since $(date -u +%T)Z"
until [ "$(curl -s -m 5 "localhost:$port/api/drain")" = '{"status":"drained"}' ]; do sleep 10; done
echo "drained at $(date -u +%T)Z"

# A drained process normally exits on SIGTERM within a second, but TimeoutStopSec=infinity
# leaves a blocked main thread hanging forever. Nothing runs after a drain, so kill it.
old_pid=$(systemctl show "$unit" -p MainPID --value)
restarted() { local pid; pid=$(systemctl show "$unit" -p MainPID --value); [ "$pid" != 0 ] && [ "$pid" != "$old_pid" ]; }
sudo systemctl restart --no-block "$unit"
for _ in $(seq 60); do restarted && break; sleep 1; done
if ! restarted; then
  echo "stop hung after drain; sending SIGKILL" >&2
  sudo systemctl kill --kill-whom=main --signal=SIGKILL "$unit"
fi
until curl -s -m 5 "localhost:$port/api/health" | grep -q "\"release\":\"$sha\""; do sleep 3; done
echo "live ${sha:0:8} at $(date -u +%T)Z: $(curl -s "localhost:$port/api/health" | grep -oE '"queue":\{[^}]*\}')"
