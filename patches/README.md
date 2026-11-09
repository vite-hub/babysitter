# Framework performance backports

Babysitter pins ViteHub's `1ba6ed37a895e63d77e74695c7f7602fa96ffa7c` package build. Source PRs do not change those installed packages. The patches below carry the applicable fixes until Babysitter consumes a release that includes them. Other consuming repositories need their own patches until they update too.

Package versions, APIs, and the pinned build stay unchanged. The existing Agent and `@t3tools/provider-runtime` repairs remain. Remove only the performance hunks from Agent when retiring these backports, unless the new release also contains its other repairs.

## Source changes and installed owners

| Upstream PR | Installed implementation | Consumer proof |
| --- | --- | --- |
| [vitehub#3723](https://github.com/vite-hub/vitehub/pull/3723), `0884b8146a6b2c6a85d6a84bbd120ad9a2e6dbbb` | The 11 build-writer chunks below. Each package has its own pnpm patch. | Real esbuild outputs from Cloudflare, Vercel, and Netlify writers keep the selected absolute entry. Bare and reverse-resolved imported aliases, direct absolute aliases, shared defaults, and explicit opt-in still work. |
| [vitehub#3724](https://github.com/vite-hub/vitehub/pull/3724), `968e32bf9da0c4fdabcfbc775093d67868b944f1` | `@vite-hub/box/dist/remote-Dndv4ERz.js`, in `@vite-hub__box@0.0.4.patch`. | Public `resolveBox()` through the Vercel adapter overlaps at most eight uploads, copies callback bytes, deduplicates exact directories, and finishes uploads before requirements and initialization. Directory, upload, callback, and abort failures preserve their reason and finish active operations before cleanup. |
| [vitehub#3725](https://github.com/vite-hub/vitehub/pull/3725), `4d6e23306706d6070b51e1307a9e299e849919dc` | `@vite-hub/workflow/dist/vite.js`, in `@vite-hub__workflow@0.0.4.patch`. | Full discovery still rejects colliding Agent Workflow names. Standalone discovery and the public Vite plugin generate a usable standalone registry despite an Agent with the same Workflow name. |
| [vitehub#3726](https://github.com/vite-hub/vitehub/pull/3726), `c8c88030309f679a450e573ef7e8274efd922673` | `@vite-hub/agent/dist/invocations/sqlite.js`, extending `@vite-hub__agent@0.0.4.patch`. | Public libSQL store on a legacy schema uses the capability index, keeps exact matching and cursor pages, and finds legacy, appended, invalidated, and null-cache evidence. Timestamp-range queries retain the status/updated-at planner. |

Both independent reviews of #3726 passed at the pinned upstream head. The consumer tests here verify the compiled backport separately.

### Build-writer copies

Each row maps to `patches/<package-name-with-__>@0.0.4.patch`, except `vite-hub`, whose patch is `vite-hub@0.0.4.patch`.

| Installed package | Compiled owner |
| --- | --- |
| `vite-hub` | `dist/src-1_MLvzNN.js` |
| `@vite-hub/agent` | `dist/vite.js` |
| `@vite-hub/blob` | `dist/vite.js` |
| `@vite-hub/browser` | `dist/vite.js` |
| `@vite-hub/database` | `dist/vite-CdW0qAxA.js` |
| `@vite-hub/kv` | `dist/vite.js` |
| `@vite-hub/queue` | `dist/vite-CXqqIlUp.js` |
| `@vite-hub/rate-limit` | `dist/vite.js` |
| `@vite-hub/schedule` | `dist/vite-Bh0dD_Nt.js` |
| `@vite-hub/workflow` | `dist/vite.js` |
| `@vite-hub/workspace` | `dist/vite-Dis0PuLn.js` |

The private build helpers are inlined into these packages. Patching one package cannot update the others. Tests expose the installed helpers in memory, run their real writers, and import the generated outputs. No exports or files are added to installed packages for testing.

### Older package differences

- The pinned `@vite-hub/sandbox` implements named job runners. Its portable Home/session API still belongs to `@vite-hub/box`, so #3724 is backported there. No Sandbox API rename is introduced.
- `@vite-hub/email` has a copy of the alias helper, but only direct bundle callers. It has no selected-entry deployment writer. Its shared alias behavior stays unchanged, so it needs no patch for #3723.
- The Console's bundled Invocation route delegates to Agent's public libSQL store. It needs no duplicate database patch.
- Optional history normalization, overlay #54, and object sync #55 are outside these patches.

## Reproduce

```sh
heavy pnpm install --frozen-lockfile
heavy --light node --test tests/dependency-performance.test.ts
heavy pnpm test
heavy pnpm build
heavy pnpm typecheck
```

The tests use local SQLite databases and a local Vercel SDK stand-in. They make no provider requests and use no production environment files. The two older packages that inline esbuild use the matching installed `0.27.7` binary in their build fixtures.

A clean checkout needs the build before typecheck because the build generates `.vitehub` declarations. The new tests fail on the pinned packages with main's patches and pass with these patches.

## Extend a patch safely

Read `pnpm patch --help` first. Do not pass `--ignore-existing`. For the pinned tarball dependencies, pnpm 10.33.0 can extract pristine files even when an existing patch is configured. Compare the extracted files against a frozen installed baseline before editing. If the existing patch is absent, apply the checked-in patch to the edit directory first and verify that comparison again.

Use `pnpm patch-commit <edit-directory>` to generate the combined patch and refresh `pnpm-lock.yaml`. Verify a fresh frozen install afterward. Do not edit the installed package or the shared pnpm store.

## Startup performance backports

Babysitter pins ViteHub build `1ba6ed37a895e63d77e74695c7f7602fa96ffa7c`. These pnpm patches carry the applicable source fixes into that build without changing package versions or resolutions. The complete existing Agent repair patch and the provider-runtime patch remain.

| Upstream source | Installed owner | Consumer proof |
| --- | --- | --- |
| [Workspace #3763](https://github.com/vite-hub/vitehub/pull/3763), [`1faee6dc8aa0a7572e662d27e7743ed5033383f5`](https://github.com/vite-hub/vitehub/commit/1faee6dc8aa0a7572e662d27e7743ed5033383f5) | `@vite-hub/workspace/dist/metadata-target-CvgSeYiZ.js` and `dist/workspace-ClTI0QiD.js` | Both installed peer instances, with snapshot reuse on and off, read existing and absent mounted paths without scanning siblings. A reused view checks the requested owner. Another Workspace's sibling survives a point read; reading that sibling or listing the mount recovers ownership. Missing owned files recover too. |
| [Agent #3762](https://github.com/vite-hub/vitehub/pull/3762), [`5597c2657add22357fe7bc3cb3dec19be7e285fe`](https://github.com/vite-hub/vitehub/commit/5597c2657add22357fe7bc3cb3dec19be7e285fe) | `@vite-hub/agent/dist/capability-runtime-CutChxpO.js` and `dist/src-DBofpFt6.js` | Public `runAgent` preserves the schema-free input reference without traversing its nested records. Schema-backed input mutations still fail before the Driver, including after deferred preparation. The direct capability resolver still tracks mutations and resets its baseline. |
| [Provider tracing #3761](https://github.com/vite-hub/vitehub/pull/3761), [`5d5f734d8c0ab929f110b4c0612f11c17fb1a03f`](https://github.com/vite-hub/vitehub/commit/5d5f734d8c0ab929f110b4c0612f11c17fb1a03f) | The five bundled owners below | Each real esbuild host variant traces the entry once, retains the complete static dependency chain byte for byte, and observes changed bytes on another call. Failed variants and modules absent from some successful variants remain eligible for retracing. Both query and computed overlaps retain `worker-value.ts`, and worker bundles of each retained tree execute with the expected exports. |

The Workspace patch includes the absent-path fallback from #3763. Provider inputs enter the per-call `tracedEntries` set only when every host variant succeeds and every metafile contains that input. Aggregate success alone can lose a worker dependency when a query or computed import overlaps a module loaded only by Node.

## Bundled provider owners

Each package needs its own patch because the build helper is inlined.

| Package | Compiled file |
| --- | --- |
| `@vite-hub/agent` | `dist/vite.js` |
| `@vite-hub/database` | `dist/vite-CdW0qAxA.js` |
| `@vite-hub/queue` | `dist/vite-CXqqIlUp.js` |
| `@vite-hub/schedule` | `dist/vite-Bh0dD_Nt.js` |
| `@vite-hub/workflow` | `dist/vite.js` |

An inventory of every installed ViteHub package found these five copies. The other installed packages have no `traceImportedSources` implementation to patch. The older Agent build exposes `resolveAgentCapabilities`, rather than the newer `createCapabilityRuntime` entry point; the test exercises its existing default behavior. Neither change requires new installed exports or a newer dependency's compiled output.

Rate Limit #3758 is excluded because its plugin is disabled in Babysitter. These startup and journal/Console backports from main are combined with the framework performance backports above; all unrelated Agent and provider-runtime repairs remain.

## Verification

`tests/startup-performance.test.ts` exercises installed packages. Private helpers are exposed and esbuild calls recorded through Node module load hooks in memory. The fixtures use local files and a custom-run Driver. No provider or model calls are needed.

```sh
heavy pnpm install --frozen-lockfile --store-dir .vitehub/provider-safety/fresh-store
heavy --light node --test tests/startup-performance.test.ts
heavy pnpm test
heavy node evidence/startup-performance/public-consumer-bundles.mjs
BABYSITTER_PUBLIC_URL=https://babysitter.invalid heavy pnpm build
heavy pnpm typecheck
```

Build before typecheck in a clean checkout because it generates `.vitehub` declarations. Verification logs live in `evidence/startup-performance`.

## Extending or retiring these patches

Read `pnpm patch --help`. Use `pnpm patch <package>@0.0.4`, keep existing patches, and compare the edit directory with a frozen installed baseline. With this pinned preview, pnpm can extract pristine Agent files despite its configured patch. Apply the checked-in Agent patch first if the comparison shows its repair hunks are missing, then verify equality before editing.

Workspace has two peer instances. Select `0.0.4` and answer **no** to pnpm 10.33.0's "Apply this patch to all versions?" prompt. Its all-versions patch commit compares against the registry release instead of this Git-hosted preview and can generate an unrelated package-wide replacement. The version-specific patch still applies to both peer instances. Generate patches and lock hashes with `pnpm patch-commit <edit-directory>`. In a non-interactive shell, use `CI=true pnpm --config.frozen-lockfile=false patch-commit <edit-directory>` so pnpm can replace `node_modules` and regenerate patch hashes. Then verify a frozen install with empty `node_modules` and an empty isolated store.

Retire the performance hunks after upgrading to a build containing all three source fixes. Keep unrelated Agent and provider-runtime repairs until their replacements are verified separately. Every consuming repository needs its own backports until it upgrades.

## Filtered journal reads and native Console cursors

These backports extend the same pinned preview and retain the complete patches above.

| Upstream source | Installed owner | Consumer proof and retirement |
| --- | --- | --- |
| [Agent journal #3766](https://github.com/vite-hub/vitehub/pull/3766), [`d260a4c4b5a1d0475c50aceee503cbdff2ff0479`](https://github.com/vite-hub/vitehub/commit/d260a4c4b5a1d0475c50aceee503cbdff2ff0479) | `@vite-hub/agent/dist/invocations-D_U9V1-3.js` and `dist/invocations/sqlite.js` | Memory reads select observations before cloning their payloads. SQLite adds the observation-name expression index and uses filtered `ORDER BY +position`; full reads keep the position index. Consumer tests verify skipped payload clones, mutation isolation, the real query plan, append order, empty selections, and additive reopening. Remove only these hunks after a preview includes #3766 and these tests pass without them. |
| [Console #3769](https://github.com/vite-hub/vitehub/pull/3769), [`96c593e26fe2c514761c1fdc252d29907d0ede9c`](https://github.com/vite-hub/vitehub/commit/96c593e26fe2c514761c1fdc252d29907d0ede9c) | `vite-hub/dist/console/runtime/server/invocation.get.js` | Request-local SHA256 hashes JSON in batches of at most 32 observations, splitting at the requested prefix. The installed artifact predates the combined prefix/full pass, so this backport includes that pass while keeping its existing request adapter and response fields. An opaque legacy cursor resets once, then append polls resume. Remove only the Console hunks from `vite-hub@0.0.4` after a preview includes #3769 and the consumer tests pass without them; retain the deployment-writer hunks until their source fix is included too. |

An inventory of all installed ViteHub packages found one copy of each implementation above. The journal already supports `observationNames`, so both memory and SQLite changes apply. No newer journal schema, exports, types, request-context adapter, or compiled modules are copied into this older artifact. SQLite's index is additive and leaves stored records readable by the prior build.

`tests/journal-console-performance.test.ts` runs against the installed packages with a real file-backed SQLite client and the real Console detail endpoint. It covers empty and appended polls, batch boundaries, Unicode and escapes, rewritten prefixes, invalid counts, and truncated histories. Private Console installation is exposed through a Node load hook without changing package files. The same tests run against saved pre-backport module sources for the failing-before check. Logs and install checksums are retained in `evidence/journal-console`.

```sh
heavy --light node --test tests/journal-console-performance.test.ts
heavy pnpm test
BABYSITTER_PUBLIC_URL=https://babysitter.invalid heavy pnpm build
heavy pnpm typecheck
```

Extend these patches through the version-specific `pnpm patch` / `pnpm patch-commit` workflow above. Verify that the edit directory contains every existing repair before editing. Generate both Agent and `vite-hub` patches, then run a frozen install with empty `node_modules` and an empty isolated store and check that the lockfile and patch checksums do not change. Keep package pins, tarball resolutions, and all unrelated repair hunks intact. The tests establish reduced duplicate work and preserved behavior; they do not claim memory, p95, or production latency improvements.
