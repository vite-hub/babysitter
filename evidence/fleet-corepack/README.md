# Fleet Corepack seed cache evidence

[Public retained evidence](https://drop.vitehub.dev/d/j3hrmke8hqzp/babysitter-corepack-cache) for Babysitter PR #56.

## Cache boundary

Each Box has a private Corepack Home and private manager artifacts. For pinned pnpm with Corepack available, the runtime first prepares a canonical seed by running `corepack install --global --cache-only` with the complete pin in an empty temporary Home. Successful downloads publish atomically under a per-pin lock. The key includes the integrity hash. Failed downloads publish nothing. Each install copies the seed's `v1` into the private Box Home. Worker commands write only to that copy; no symlink or hard link connects it to the seed. The runtime refreshes the private copy when preparing changed dependencies. Other managers, unpinned projects and hosts without Corepack retain private state without seed reuse.

The cache uses a new `corepack-seeds-v1` namespace. It never consumes the earlier implementations' caches. Every Box still runs a frozen dependency install in its own workspace. Default-version state remains private.

Two earlier implementations are superseded. Commit `51a4c9a` shared all of Corepack Home, allowing integrity and default-version state to cross Boxes. Commit `9efac49f` separated full pins but linked worker-writable artifacts. Independent review showed that repairing a bad hash inside a Box then populated the original bad-pin bucket. The current runtime removes worker writes to shared artifacts entirely.

Current runtime SHA-256: `4d7a367baf7bdd3914040c3385f6949f7edf2320c2ce747820c61101c5ec01b4`. Baseline runtime and benchmark checkout: `daf551151753b5ac88d96356db231a2c338d643a`.

## Correctness

The real Corepack proof starts with an all-zero hash, observes the install failure, repairs only the Box's manifest and runs pnpm successfully, then opens another Box at the unchanged bad pin. That new Box still fails offline. The preceding implementation instead succeeded. See `seed-repair.json` and the checked-in `scripts/check-corepack-isolation.ts`.

The same real check proves correct-pin offline reuse, private default-version state, private artifact mutations, warm-cache rejection of a different integrity hash, and recovery after failure. See `seed-isolation.json`. The changed focused regression fails on the preceding implementation's assertion and passes here. All three focused tests pass.

The full 189-test suite, eight real dependency-install checks, build and package typecheck pass. The real dependency checks cover changed lockfiles, unchanged refreshes, concurrent workspaces, failed installs, repaired inputs, version changes, offline misses/reuse, cancellation and cleanup. Strict checks include the benchmark, both check scripts and the regression test. The current cache boundary still needs independent review.

## Measurements

The completed run opened 32 Boxes with 32 successful installs and zero failures. Every tree contains 90,267 files and 4,179 symlinks. Exact installed imports, lockfile bytes, pinned pnpm version and Git HEAD are asserted outside the open timer. Close is outside that timer too.

| Box open, ms | Baseline median [min, max] | Seed/copy median [min, max] | Samples per side |
| --- | ---: | ---: | ---: |
| Warm store, serial | 3323.5 [3261.2, 3639.9] | 2380.3 [2358.3, 2464.8] | 5 |
| Warm store, two concurrent | 3457.2 [3159.8, 3566.9] | 2670.3 [2629.3, 2771.1] | 10 |

Raw arrays, stage timings and host load are in `seed-samples.json`; exact summaries are in `seed-summary.json`. These local fixture measurements do not establish fleet throughput, provider startup or production latency. Both warm scenarios improve in this local run. Shared-host scheduling and real fleet throughput remain unverified.

Shared Slimbook, local shell transport, warm OS cache, network enabled. Fixed baseline-first ordering within each serial pair; initial stores differ for cold controls. Parent validation completed before this run. Other agents and registry load uncontrolled. Close excluded from open timer. Node 24.21.0, pnpm 10.33.0, Corepack 0.36.0, Linux. Runtime preparation now adds a private artifact copy. Actual SSH cost is unmeasured.

The files `samples.json`, `exploratory-samples.json`, `profile.json`, `behavior.json`, `regression-before.txt` and all `review-fixed-*.json` describe superseded implementations. They establish no result for this cache boundary.

## Reproduce

From the repository root with Node 24 and Corepack 0.36.0:

```sh
heavy --light node --test tests/fleet-corepack.test.ts
heavy node scripts/check-corepack-isolation.ts
heavy node scripts/check-fleet-dependencies.ts
heavy pnpm test
heavy pnpm build
heavy pnpm typecheck
BENCH_BASE=daf551151753b5ac88d96356db231a2c338d643a BENCH_OUTPUT=.data/seed-reproduction TRIALS=5 HEAVY_WAIT=0 heavy node scripts/bench-fleet-dependencies.ts
```

Actual SSH, cancellation during Corepack download, other Corepack versions and deployed performance remain unverified. No production changes or live speedup are claimed.
