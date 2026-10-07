# Worker memory limits

The patched ViteHub Box puts each provider and its native commands in one delegated cgroup. The controller stays in the `controller` subgroup. Start with one repair worker. Its hard limit is 4 GiB, `memory.high` is 3 GiB, and swap is limited to 128 MiB. Each Node process uses a 2 GiB V8 heap limit; the cgroup also accounts for native memory and other processes. The service drop-in gives the whole controller and worker tree a 6 GiB high limit, an 8 GiB hard limit and 256 MiB swap.

Admission reserves 4 GiB for the host separately from a 1 GiB service reserve, plus another 4 GiB of growth for every active worker. A healthy controller below 1 GiB can admit its first worker under the 6 GiB service high limit. Keeping the host and service reserves separate avoids blocking every PR under the 8 GiB service hard limit. It checks host and cgroup pressure. A failed sample pauses admission. These settings are conservative; increase them only after recording complete worker peaks and checking host pressure while T3 is busy.

Full typechecks and builds belong in GitHub Actions. Use focused local tests and lint. An explicit local reproduction stays under the worker limit. A cgroup OOM rejects command waits with `BOX_R0158`, limit, peak bytes when available and kill count; the session cannot start another command. An ancestor or host OOM is reported separately from a session limit OOM. Reduce the workload before retrying.

## Deployment prerequisite

`memory.conf` is staged configuration. It has not been installed. It requires Linux cgroup v2 and systemd 254 or later. The production Agent refuses to boot without `BABYSITTER_WORKER_CGROUP_PARENT`; it must point to the service parent, not its controller child.

For a separately authorized deployment, install this file as `/etc/systemd/system/babysitter-vitehub.service.d/memory.conf`, reload systemd, and use the existing release procedure. Drain the current release with SIGUSR2 before its restart. Check that the main PID lives in `.../babysitter-vitehub.service/controller`, and that the service parent delegates memory. Verify the active release, health, durable queue and one real PR transition after deploying. The release smoke unit uses its own delegated parent and admits no real workers.

Checkout and dependency preparation run under the service budget before provider commands start. The per-worker limit covers Box `exec` and `spawn` and their descendants. It does not contain unrelated T3 processes. Trusted-host retains the service user's filesystem and network authority.

## Kernel proof without deployment

From this checkout, run the installed dependency check in a temporary user service:

```sh
systemd-run --user --wait --pipe --collect --quiet \
  --unit=babysitter-memory-check \
  -p Delegate=memory -p DelegateSubgroup=controller \
  -p MemoryMax=1G -p MemorySwapMax=0 \
  -p WorkingDirectory="$PWD" \
  --setenv=VITEHUB_TEST_DELEGATED_MEMORY=1 \
  node scripts/check-worker-memory.mjs
```

To check first-worker admission under the staged service budget, run the same script with `VITEHUB_TEST_ADMISSION=1`, `MemoryHigh=6G` and `MemoryMax=8G` instead of the OOM-test flag and 1 GiB cap. The host must have at least 8 GiB available. This check raises only the test's pressure thresholds to isolate memory arithmetic; normal workers keep the configured pressure gates.

The script checks unavailable delegation, a real worker OOM, sibling survival and nested cgroup cleanup. It opens no GitHub connection and uses no provider credentials. Keep the outer 1 GiB test limit.

## Retire patches

The Box patch adds memory containment. The Agent patch preserves the existing combined patch and adds host pressure, growth reservations, separate host/service reserves, preset capacity options, CI-first instructions and Box checkout integration. When the upstream PRs reach a package release, update the dependency and remove only these hunks. Keep unrelated Agent and Workspace patch fixes until their own releases are installed.
