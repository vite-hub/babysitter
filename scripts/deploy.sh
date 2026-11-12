#!/usr/bin/env bash
# Builds the committed HEAD, stages it as a release, drains the running service and restarts onto it.
# Usage: scripts/deploy.sh [--compact]   (run from a clean, committed checkout; needs sudo)
# --compact stops the service after the drain, compacts the state DB (ops/compact-state-db.mjs, the
# previous DB stays next to it as a backup) and prunes the worker Codex home before it starts again.
set -euo pipefail
compact=false
[ "${1:-}" = --compact ] && compact=true
unit=babysitter-vitehub.service
dropin=/etc/systemd/system/$unit.d/release.conf
data_dir=/home/workspace/babysitter-data
data=$data_dir/.vitehub
port=$(systemctl show "$unit" -p Environment | grep -oP 'PORT=\K\d+')
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain -- patches pnpm-lock.yaml server package.json vite.config.ts)" ] || { echo "commit first: the build bakes in the git SHA" >&2; exit 1; }
sha=$(git rev-parse HEAD)
# Only the build takes the shared heavy lock; the drain below can take half an hour.
# HEAVY_REMOTE=0: an overflow host gets a mirror without .git, and the build reads the git SHA.
CI=1 BABYSITTER_PUBLIC_URL=https://babysitter.vitehub.dev BABYSITTER_DATA_DIR=$data_dir \
  HEAVY_WAIT=0 HEAVY_REMOTE=0 heavy pnpm build >/tmp/babysitter-build.log 2>&1
grep -q "$sha" .output/server/index.mjs || { echo "build does not contain $sha" >&2; exit 1; }
grep -rq "$data/agents/babysitter/invocations.sqlite" .output/server || { echo "build lost the console journal path" >&2; exit 1; }

previous=$(grep -oE '/home/workspace/babysitter-release-[^/]+' "$dropin" | head -1)
release=/home/workspace/babysitter-release-${sha:0:8}-$(date +%Y%m%d%H%M)
owner=$(sudo stat -c %U:%G "$previous")
sudo install -d -o "${owner%:*}" -g "${owner#*:}" "$release"
sudo cp -a .output "$release/"
sudo chown -R "$owner" "$release"
sudo -u "${owner%:*}" /usr/local/bin/node --check "$release/.output/server/index.mjs"
scripts/install-host-files.sh
sudo cp "$dropin" "/tmp/release.conf.$(basename "$previous")"
sed "s#$previous#$release#g" "$dropin" | sudo tee "$dropin.new" >/dev/null
sudo mv "$dropin.new" "$dropin"
sudo systemctl daemon-reload
echo "staged $release (previous: $previous)"

sudo systemctl kill --kill-whom=main --signal=SIGUSR2 "$unit"
echo "draining since $(date -u +%T)Z"
until [ "$(curl -s -m 5 "localhost:$port/api/drain")" = '{"status":"drained"}' ]; do sleep 10; done
echo "drained at $(date -u +%T)Z"

old_pid=$(systemctl show "$unit" -p MainPID --value)
if $compact; then
  sudo systemctl stop --no-block "$unit"
  for _ in $(seq 60); do [ "$(systemctl is-active "$unit")" = inactive ] && break; sleep 1; done
  if [ "$(systemctl is-active "$unit")" != inactive ]; then
    echo "stop hung after drain; sending SIGKILL" >&2
    sudo systemctl kill --signal=SIGKILL "$unit"
    for _ in $(seq 30); do [ "$(systemctl is-active "$unit")" != active ] && break; sleep 1; done
  fi
  echo "stopped at $(date -u +%T)Z"
  # A failed compaction leaves the original DB in place; start on it instead of staying down.
  trap 'echo "compaction failed; starting on the original DB" >&2; sudo systemctl start "$unit"' ERR
  backup=$data/agent-state.db.before-compact-$(date +%Y%m%d%H%M)
  sudo node ops/compact-state-db.mjs "$data/agent-state.db" "$data/agent-state.compact.db"
  sudo sh -c "mv '$data/agent-state.db' '$backup' && for s in -wal -shm; do [ -e '$data/agent-state.db'\$s ] && mv '$data/agent-state.db'\$s '$backup'\$s; done; mv '$data/agent-state.compact.db' '$data/agent-state.db'; rm -f '$data/agent-state.compact.db-wal' '$data/agent-state.compact.db-shm'"
  sudo chown svc-babysitter:codex-workspace "$data/agent-state.db"
  sudo chmod 0644 "$data/agent-state.db"
  echo "compacted at $(date -u +%T)Z: $(sudo stat -c %s "$data/agent-state.db") bytes (backup $backup)"
  sudo node ops/prune-codex-home.mjs /home/agents/.codex
  trap - ERR
  sudo systemctl start "$unit"
else
  # A drained process normally exits on SIGTERM within a second, but TimeoutStopSec=infinity
  # leaves a blocked main thread hanging forever. Nothing runs after a drain, so kill it.
  restarted() { local pid; pid=$(systemctl show "$unit" -p MainPID --value); [ "$pid" != 0 ] && [ "$pid" != "$old_pid" ]; }
  sudo systemctl restart --no-block "$unit"
  for _ in $(seq 60); do restarted && break; sleep 1; done
  if ! restarted; then
    echo "stop hung after drain; sending SIGKILL" >&2
    sudo systemctl kill --kill-whom=main --signal=SIGKILL "$unit"
  fi
fi
until curl -s -m 5 "localhost:$port/api/health" | grep -q "\"release\":\"$sha\""; do sleep 3; done
echo "live ${sha:0:8} at $(date -u +%T)Z: $(curl -s "localhost:$port/api/health" | grep -oE '"queue":\{[^}]*\}')"
