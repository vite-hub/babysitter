# Fleet Corepack artifact cache evidence

[Public retained evidence](https://drop.vitehub.dev/d/j3hrmke8hqzp/babysitter-corepack-cache) for Babysitter PR #56.

## Reviewed cache boundary

Each Box keeps a private `COREPACK_HOME`, including `lastKnownGood.json`. Only its `v1` artifact directory is linked to the persistent fleet cache. The shared directory is keyed by SHA-256 of the complete `packageManager` pin, including integrity. Different pins cannot populate each other's normal project cache. Unpinned projects use a private Home with no shared artifacts. A changed manifest selects the corresponding cache on dependency refresh. Every new Box still runs its frozen install in a separate workspace.

The initial implementation at `51a4c9aec72141574bf4e4137c55f8fdf08e9893` shared all of Corepack Home. Independent reviews reproduced two defects: a warmed version bypassed a different requested hash, and one Box changed another's default version. That implementation is superseded. The files `samples.json`, `exploratory-samples.json`, `profile.json`, `behavior.json` and `regression-before.txt` describe that old implementation, not the fixed runtime.

The updated runtime source SHA-256 is `bcf58400e102b14229d4a2ac27e4ab99202ecb12de56e1523c513d434e5c10d8`. Baseline runtime and fixture source are `daf551151753b5ac88d96356db231a2c338d643a`.

## Fixed-runtime measurements

The rerun opened 32 Boxes with 32 successful installs and zero failures. Each materialized tree contained 90,267 files and 4,179 symlinks. Assertions check the installed imports, pinned pnpm version, exact lockfile bytes and Git HEAD outside the open timer. Close is also outside that timer.

| Box open, ms | Baseline median [min, max] | Fixed runtime median [min, max] | Samples per side |
| --- | ---: | ---: | ---: |
| Warm store, serial | 3242.7 [2893.9, 3292.4] | 2354.9 [2345.4, 2403.1] | 5 |
| Warm store, two concurrent | 3505.6 [3283.8, 5303.0] | 2738.4 [2540.4, 8827.5] | 10 |

Raw arrays, stage timings and load averages are in `review-fixed-samples.json`; exact summaries are in `review-fixed-summary.json`. Serial sides alternate within each pair. Concurrency is inconclusive, including a candidate outlier above eight seconds. Initial cold controls have different pnpm-store states and establish no cold speedup.

Conditions: shared Slimbook, Node 24.21.0, pnpm 10.33.0, Corepack 0.36.0, Linux, local shell transport, warm OS caches, registry network enabled, one initially empty fleet store for the run. Parent test/install validation jobs overlapped the beginning of the benchmark, so these are shared-host samples rather than isolated hardware timings. Artifact setup adds a transport command; its real SSH cost is unmeasured. The result does not establish fleet throughput, provider startup, a model turn or deployed latency.

## Correctness checks

- All three focused Corepack tests fail on assertions against the initial PR head and pass after the fix. They cover complete-pin artifact separation, private defaults, correct-pin reuse, environment filtering and failed/aborted workspace cleanup.
- The actual Corepack reproduction warms the correct integrity pin, reuses it offline, then rejects the all-zero hash with `Mismatch hashes` in both warm and cold cases. Baseline rejects it too. See `review-fixed-integrity.json`.
- Two concurrent cold opens succeed. After changing the default in one Box, the other has no `lastKnownGood.json` and selects the same unpinned version as baseline. See `review-fixed-defaults.json`.
- The checked-in `check-corepack-isolation.ts` independently proves private defaults, offline same-pin reuse, incorrect-hash rejection and recovery using real Corepack. See `review-fixed-isolation.json`.
- The full 189-test suite, eight real dependency-install checks, build and package typecheck pass. Strict checks include the benchmark, both check scripts and the regression file. Earlier independent reviews apply to the initial head; the fixed cache boundary still needs independent recheck.

## Reproduce

From the repository root with Node 24 and Corepack 0.36.0:

```sh
heavy --light node --test tests/fleet-corepack.test.ts
heavy node scripts/check-corepack-isolation.ts
heavy node scripts/check-fleet-dependencies.ts
heavy pnpm test
heavy pnpm build
heavy pnpm typecheck
BENCH_BASE=daf551151753b5ac88d96356db231a2c338d643a BENCH_OUTPUT=.data/review-fixed-reproduction TRIALS=5 HEAVY_WAIT=0 heavy node scripts/bench-fleet-dependencies.ts
```

The standalone pnpm binary case, actual fleet SSH, cancellation during the Corepack download, real provider startup and production are unverified. No dependency-tree reuse, production changes or live speedup are claimed.
