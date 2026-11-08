# Fleet Corepack seed cache evidence

[Public retained evidence](https://drop.vitehub.dev/d/j3hrmke8hqzp/babysitter-corepack-cache) for Babysitter PR #56.

## Cache boundary

Each Box has a private Corepack Home and private manager artifacts. For pinned pnpm using the recognized Corepack launcher, the runtime first prepares a canonical seed by running `corepack install --global --cache-only` with the complete pin in an empty temporary Home. Successful downloads publish atomically under a per-pin lock. The key includes the integrity hash. Failed downloads publish nothing. Each install copies the seed's `v1` into the private Box Home. Worker commands write only to that copy; no symlink or hard link connects it to the seed. The runtime refreshes the private copy when preparing changed dependencies. Standalone pnpm, other managers, unpinned projects and unrecognized launchers retain their existing install path without seed reuse. Installation runs in a tracked process group. Cancellation kills that group and removes only its own staging directory before returning.

The cache uses a new `corepack-seeds-v1` namespace. It never consumes the earlier implementations' caches. Every Box still runs a frozen dependency install in its own workspace. Default-version state remains private.

Two earlier implementations are superseded. Commit `51a4c9a` shared all of Corepack Home, allowing integrity and default-version state to cross Boxes. Commit `9efac49f` separated full pins but linked worker-writable artifacts. Independent review showed that repairing a bad hash inside a Box then populated the original bad-pin bucket. Commit `7afc6b3e` removed worker writes to shared artifacts, but review then found that cancelled downloads held the pin lock and standalone pnpm unnecessarily downloaded Corepack artifacts. The current runtime also fixes those two bootstrap paths.

Current runtime SHA-256: `5a1537147c00dea654f4f13916a1b6cbfe1b4c8eb5b261cd09468d79e57ecb1e`. Baseline runtime and benchmark checkout: `daf551151753b5ac88d96356db231a2c338d643a`.

## Correctness

The real Corepack proof starts with an all-zero hash, observes the install failure, repairs only the Box's manifest and runs pnpm successfully, then opens another Box at the unchanged bad pin. That new Box still fails offline. The preceding implementation instead succeeded. The checked-in `scripts/check-corepack-isolation.ts` includes this case; see `seed-isolation.json`.

The same real check proves correct-pin offline reuse, private default-version state, private artifact mutations, warm-cache rejection of a different integrity hash, and recovery after failure. See `seed-isolation.json`. The changed focused regression fails on the preceding implementation's assertion and passes here. All three focused tests pass.

Both new deterministic bootstrap tests fail on assertions against `7afc6b3e` and pass here. Real Corepack tarball-server reproductions independently confirm that a same-pin Box completes while the cancelled response remains stalled, and standalone pnpm installs offline with Corepack present. See `bootstrap-cancellation.json` and `bootstrap-manager.json`.

The full 191-test suite, eight real dependency-install checks, build and package typecheck pass. The real dependency checks cover changed lockfiles, unchanged refreshes, concurrent workspaces, failed installs, repaired inputs, version changes, offline misses/reuse, cancellation and cleanup. Strict checks include the benchmark, both check scripts and the regression test. The current cache boundary still needs independent review.

## Measurements

The completed run opened 32 Boxes with 32 successful installs and zero failures. Every tree contains 90,267 files and 4,179 symlinks. Exact installed imports, lockfile bytes, pinned pnpm version and Git HEAD are asserted outside the open timer. Close is outside that timer too.

| Box open, ms | Baseline median [min, max] | Seed/copy median [min, max] | Samples per side |
| --- | ---: | ---: | ---: |
| Warm store, serial | 3123.1 [2940.7, 3297.9] | 2418.9 [2386.3, 2432.4] | 5 |
| Warm store, two concurrent | 3418.3 [3346.1, 5855.7] | 2789.7 [2676.1, 4784.5] | 10 |

Raw arrays, stage timings and host load are in `seed-samples.json`; exact summaries are in `seed-summary.json`. These local fixture measurements do not establish fleet throughput, provider startup or production latency. Both warm scenarios improve in this local run. Shared-host scheduling and real fleet throughput remain unverified.

Shared Slimbook, local shell transport, warm OS cache, network enabled. Fixed baseline-first ordering within each serial pair; initial stores differ for cold controls. Parent validation completed before this run. Other agents and registry load uncontrolled. Close excluded from open timer. Node 24.21.0, pnpm 10.33.0, Corepack 0.36.0, Linux. Runtime preparation now adds a private artifact copy. Actual SSH cost is unmeasured.

The files `samples.json`, `exploratory-samples.json`, `profile.json`, `behavior.json`, `regression-before.txt` all `review-fixed-*.json` and `seed-repair.json` describe superseded implementations. They establish no result for this cache boundary.

## Reproduce

From the repository root with Node 24 and Corepack 0.36.0:

```sh
heavy --light node --test tests/fleet-corepack.test.ts
heavy --light node --test tests/fleet-corepack-bootstrap.test.ts
heavy node scripts/check-corepack-isolation.ts
heavy node scripts/check-fleet-dependencies.ts
heavy pnpm test
heavy pnpm build
heavy pnpm typecheck
BENCH_BASE=daf551151753b5ac88d96356db231a2c338d643a BENCH_OUTPUT=.data/seed-reproduction TRIALS=5 HEAVY_WAIT=0 heavy node scripts/bench-fleet-dependencies.ts
```

Actual SSH, other Corepack versions and deployed performance remain unverified. No production changes or live speedup are claimed.
