#!/bin/sh
set -eu
# Run as root. This exposes only the empty queue lock inode to provider sandboxes.
# The service receives read access; the queue owner keeps its existing write access.
fleet_lock=${1:-/home/maxi/.local/state/fleet-queue/slot.lock}
worker_directory=${2:-/home/workspace/babysitter-data/bin/worker}
service_user=${3:-svc-babysitter}
shared_lock="$worker_directory/heavy-command.lock"
test -f "$fleet_lock"
test -d "$worker_directory"
if [ -e "$shared_lock" ]; then
  test "$fleet_lock" -ef "$shared_lock"
else
  ln "$fleet_lock" "$shared_lock"
fi
setfacl -m "u:$service_user:r--" "$fleet_lock"
