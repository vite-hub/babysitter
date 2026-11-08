# Fleet Corepack cache evidence

[Public report and chart](https://drop.vitehub.dev/d/j3hrmke8hqzp/babysitter-corepack-cache), kept without expiry.

Fresh fleet Boxes with a warm package store open in **2.967 s → 2.417 s**, a 550.2 ms reduction, median of five alternating trials per side. Every candidate trial is faster than the fastest baseline trial. This is a local transport result for an exactly pinned package manager.

Corepack downloads the pinned pnpm distribution into each disposable Box home on the baseline. The change gives exact `packageManager` pins a persistent Corepack cache beneath the existing fleet pnpm cache root. Unpinned projects keep private default-version state. Every Box still runs the same frozen dependency install into its own workspace, and coordinator command environments cannot replace `COREPACK_HOME`.

| Stage, ms: median [min, max] | Baseline | Candidate |
| --- | --- | --- |
| Box open | 2967.3 [2892.6, 3378.8] | 2417.2 [2371.8, 2530.2] |
| Git mirror | 38.0 [34.0, 40.0] | 38.0 [35.0, 38.0] |
| Source transfer | 55.0 [53.0, 56.0] | 55.0 [54.0, 55.0] |
| Dependency install | 2868.0 [2796.0, 3276.0] | 2318.0 [2274.0, 2435.0] |
| Remaining setup | 6.0 [6.0, 8.0] | 6.0 [6.0, 7.0] |

Full Box-open samples in milliseconds:

- Baseline: `2892.573, 2953.630, 3378.807, 2967.330, 2977.357`
- Candidate: `2371.779, 2530.235, 2417.169, 2414.399, 2479.759`

`installMs` includes dependency-input hashing and the real pnpm command. Box open includes local directory creation, Git mirror synchronization, source tar transfer, dependency installation, requirements and Home setup. Close and post-open assertions are outside the open timer. Stage medians need not add to the median total. The fixture plan declares one Git requirement and no Home files or initialize callback. Fleet setup orders directory and mirror preparation, source upload, dependency input hashing and install, then Home files and tool requirements. Provider initialization follows materialization. Remote installs have no outer install flock; pnpm manages its shared store. Existing per-Box input hashing skips unchanged refreshes, while every new Box installs its own tree.

The benchmark opens **32 Boxes with 32 successful installs and 0 failures**. Each installed tree contains **90,267 regular files and 4,179 symlinks**. It imports evlog 2.29.0 and h3 2.0.1-rc.25, checks pnpm 10.33.0, compares the lockfile byte for byte, and checks Git HEAD against the pinned source commit.

Five rounds per side also open two Boxes concurrently, ten Boxes per side. The per-Box medians are 3506.0 ms and 2605.6 ms, with ranges 3265.2–5737.0 ms and 2572.5–8413.9 ms. **Concurrency is inconclusive** because the shared-host variation exceeds the difference. The paired rounds and their load averages remain in `samples.json`.

The initial cold-store baseline takes 10.593 s. The next candidate open has a warm package store and a cold Corepack cache and takes 3.108 s. Those cache states differ, so they are diagnostic samples and support no cold-install speedup claim. Every timed workspace and Home is fresh. The same-Box refresh behavior is checked separately.

## Conditions and limiter

- Base and fixture source: `daf551151753b5ac88d96356db231a2c338d643a`. Baseline runtime is extracted directly from this commit. The base already contains merged #53; this patch does not change admission, mirrors, or overlays and has no dependency on #54.
- Candidate `server/fleet/ssh-box.ts` SHA-256: `60253992b4b3c1d8483514cac7251adfc828222446f566ce953cc81e4b0b63a7`.
- Lockfile SHA-256: `8415e7b40706e88c6a4d9d5a1ab5ce566b184bfdc618eb4c25f8ba32d5072bdb`. Package manager and dependencies come from the base manifest and lockfile.
- Node v24.21.0, pnpm 10.33.0, Corepack 0.36.0, Linux 7.0.0-31-generic, AMD Ryzen 7 255 w/ Radeon 780M Graphics, 16 logical CPUs, ext4, about 28.7 GiB RAM.
- `heavy` ran the measured installs locally. The host was shared; no unrelated processes were stopped. The final run had no profiling or verification jobs from this task overlapping it. OS page caches were warm and were not evicted. Each benchmark run starts with its own empty fleet store and Git mirror, then alternates sides against the warmed store. Registry network access stays enabled.
- Actual command: `pnpm install --frozen-lockfile --prefer-offline --ignore-scripts --ignore-pnpmfile`. Lifecycle and hook policy is the existing fleet behavior. The change adds no skipped lifecycle steps and does not cache installed dependency trees.

The separate, unreported `strace -f -c` run shows a baseline pnpm distribution download and a candidate Corepack cache hit. Both installs execute **89,307 link calls** to materialize the dependencies. Baseline has 470,713 total syscalls and candidate 340,103, including 91,680 versus 85,973 stat calls. File materialization remains substantial work, so a cache hit cannot remove the whole install. Traced thread-wait totals are not elapsed time and are not used in the latency claim. The saved 550.2 ms is below the baseline dependency stage's 2868.0 ms budget.

## Correctness

`check-fleet-dependencies.ts` runs real Corepack and pnpm with two local dependency tarballs. It checks:

- fresh Box installs version 1 offline with the cached pinned pnpm; lifecycle scripts stay disabled.
- changed lockfile replaces dependency version 1 with version 2 and preserves the exact lockfile.
- unchanged refresh keeps the installed dependency correct.
- concurrent Boxes install into separate workspaces; source changes stay in their own Box.
- a mismatched lockfile records a failed install without stale dependencies; repaired inputs install successfully.
- offline setup fails for an uncached pinned pnpm version instead of using the cached wrong version.
- retry downloads the requested pnpm version and installs successfully.
- cancellation after install removes the workspace; the next offline Box installs successfully from package caches.

The focused regression test fails on the baseline because the cache is unset and passes on the candidate. It also checks coordinator environment filtering, cache persistence across failed and cancelled opens, workspace removal, and the unpinned fallback. The existing fleet test file passes, 14 tests, as does the new one, one test. Build, package typecheck, and strict typechecking of both new scripts and the new test pass. No service, SSH host, or production worker was changed.

## Reproduce

From the repository root, with Node 24.21.0 and Corepack 0.36.0:

```sh
heavy pnpm install --frozen-lockfile
heavy pnpm build
heavy pnpm typecheck
heavy --light node --test tests/fleet.test.ts
heavy --light node --test tests/fleet-corepack.test.ts
heavy node scripts/check-fleet-dependencies.ts
BENCH_BASE=daf551151753b5ac88d96356db231a2c338d643a HEAVY_WAIT=0 heavy node scripts/bench-fleet-dependencies.ts
heavy node evidence/fleet-corepack/profile.mjs
```

The measured run used `HEAVY_WAIT=0 heavy node scripts/bench-fleet-dependencies.ts`, with `origin/main` at the exact base above and default `TRIALS=5`. Strict script verification used `heavy pnpm exec tsc --ignoreConfig --noEmit --target ESNext --module Preserve --moduleResolution Bundler --allowImportingTsExtensions --skipLibCheck --types node --strict --noUncheckedIndexedAccess scripts/bench-fleet-dependencies.ts scripts/check-fleet-dependencies.ts tests/fleet-corepack.test.ts`.

`samples.json` retains every final observation. `exploratory-samples.json` retains the initial plan-override experiment, the implementation before the pin guard, and the run that overlapped tracing. These are excluded from the primary claim. `profile.json` retains the normalized Corepack diagnostics and syscall summaries; `behavior.json` retains the real-install correctness results; `regression-before.txt` retains the sanitized baseline failure.

## Limits

This is a local fixture on a shared host. It does not reproduce the historical SSH upload or Box setup outliers, measure provider initialization or a model turn, establish fleet-wide throughput, or justify a concurrency gain. A cold Corepack cache must still download pnpm. Hosts with a standalone pnpm binary or an already shared Corepack cache may see no benefit. npm cache configuration and full dependency-tree reuse remain separate candidates. No deploy or real production PR transition was attempted.
