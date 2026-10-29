#!/usr/bin/env bash
# Installs the host copies that live outside a release directory, from this checkout: the worker
# heavy-command gate and its wrappers, one lock file per heavy slot, the main guardian and the tmp
# retention script. release.mjs, deploy.sh and deploy-compact.sh call it; it needs sudo.
set -euo pipefail
cd "$(dirname "$0")/.."
unit=babysitter-vitehub.service
bin=/home/workspace/babysitter-data/bin
worker=$bin/worker
slots=$(systemctl show "$unit" -p Environment --value | grep -oP '(?:^|\s)BABYSITTER_HEAVY_SLOTS=\K\d+' || echo 1)

# Root owns the gate and the slot locks so workers, which run as the service user, can't change them.
# Workers open the locks read-only: flock needs no write access, and their sandbox can't create files.
sudo install -o root -g codex-workspace -m 0644 scripts/heavy-command-gate.cjs "$worker/heavy-command-gate.cjs"
sudo install -o svc-babysitter -g codex-workspace -m 0755 scripts/worker-bin/node scripts/worker-bin/python "$worker/worker-bin/"
for ((i = 0; i < slots; i++)); do
  lock=$worker/heavy-command.lock
  ((i)) && lock+=.$i
  sudo test -e "$lock" || sudo install -o root -g codex-workspace -m 0444 /dev/null "$lock"
done
# The main guardian timer runs this stable copy (see ops/main-guardian.*).
sudo install -o svc-babysitter -g codex-workspace -m 0755 scripts/main-guardian.mjs "$bin/main-guardian.mjs"
# The tmp retention timer runs this one (see ops/babysitter-tmp-retention.*).
sudo install -o root -g codex-workspace -m 0755 ops/tmp-retention.mjs "$bin/tmp-retention.mjs"
echo "installed host files in $bin ($slots heavy slots)"
