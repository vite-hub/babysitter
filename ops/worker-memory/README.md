# Worker memory limits

The published ViteHub Box API can put each provider and its native commands in one delegated cgroup. Set `BABYSITTER_WORKER_CGROUP_PARENT` to enable application containment. Without this setting, the app keeps its existing Workspace provider. No local package patch is required.

Each contained worker has a 4 GiB hard limit, a 3 GiB high threshold and 128 MiB swap. Admission reserves 4 GiB of growth per active worker, 4 GiB for other host work and 1 GiB for the service controller. Failed resource samples pause admission. The configured owner ceiling remains 16; resource admission can reduce the number of simultaneous contained workers to fit the available service and host memory. This option does not promise 16 workers under a 12 GiB service budget.

Worker verification uses the existing shared fleet lock. Use focused validation and hosted CI for broad suites. After an OOM, reduce the command workload before retrying. The Box rejects pending waits with `BOX_R0158`, records its limit and peak usage when available, and prevents further commands in the failed session. Closing the session cleans its cgroup and descendants.

## Deployment prerequisite

`memory.conf` is staged configuration and has not been installed. It preserves the current 11 GiB high, 12 GiB hard and 2 GiB swap service limits, adds memory delegation and moves the controller into its own subgroup. It does not override `BABYSITTER_MAX_OWNERS`.

Install the drop-in at `/etc/systemd/system/babysitter-vitehub.service.d/memory.conf` only as part of an authorized release. Reload systemd, drain the running service with SIGUSR2, wait for `/api/drain` to report `drained`, and restart. Confirm the controller is in its subgroup, health shows the intended release and owner ceiling, the durable queue has no stale owners, and a real PR advances. The release smoke uses its own delegated cgroup and no eligible authors.

Checkout and dependency preparation remain under the overall service budget. Per-worker containment covers Box `exec`, `spawn` and descendants. It does not contain unrelated T3 processes or reduce trusted-host filesystem and network authority.

## Kernel verification

The installed-package script opens no GitHub connection and uses no provider credentials. Run it in a temporary delegated service with a 1 GiB outer cap:

```sh
systemd-run --user --wait --pipe --collect --quiet \
  --unit=babysitter-memory-check \
  -p Delegate=memory -p DelegateSubgroup=controller \
  -p MemoryMax=1G -p MemorySwapMax=0 \
  -p WorkingDirectory="$PWD" \
  --setenv=VITEHUB_TEST_DELEGATED_MEMORY=1 \
  node scripts/check-worker-memory.mjs
```

The script verifies missing delegation fails closed, a real worker OOM is contained, the sibling and controller survive, and nested cgroups are removed. To isolate first-worker admission arithmetic, run it with `VITEHUB_TEST_ADMISSION=1`, `MemoryHigh=11G` and `MemoryMax=12G` instead of the OOM flag and 1 GiB cap. Only this arithmetic check relaxes its pressure thresholds.
