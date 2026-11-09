# Startup performance backports

Babysitter pins ViteHub build `1ba6ed37a895e63d77e74695c7f7602fa96ffa7c`. These pnpm patches carry the applicable source fixes into that build without changing package versions or resolutions. The complete existing Agent repair patch and the provider-runtime patch remain.

| Upstream source | Installed owner | Consumer proof |
| --- | --- | --- |
| [Workspace #3763](https://github.com/vite-hub/vitehub/pull/3763), [`1faee6dc8aa0a7572e662d27e7743ed5033383f5`](https://github.com/vite-hub/vitehub/commit/1faee6dc8aa0a7572e662d27e7743ed5033383f5) | `@vite-hub/workspace/dist/metadata-target-CvgSeYiZ.js` and `dist/workspace-ClTI0QiD.js` | Both installed peer instances, with snapshot reuse on and off, read existing and absent mounted paths without scanning siblings. A reused view checks the requested owner. Another Workspace's sibling survives a point read; reading that sibling or listing the mount recovers ownership. Missing owned files recover too. |
| [Agent #3762](https://github.com/vite-hub/vitehub/pull/3762), [`5597c2657add22357fe7bc3cb3dec19be7e285fe`](https://github.com/vite-hub/vitehub/commit/5597c2657add22357fe7bc3cb3dec19be7e285fe) | `@vite-hub/agent/dist/capability-runtime-CutChxpO.js` and `dist/src-DBofpFt6.js` | Public `runAgent` preserves the schema-free input reference without traversing its nested records. Schema-backed input mutations still fail before the Driver, including after deferred preparation. The direct capability resolver still tracks mutations and resets its baseline. |
| [Provider tracing #3761](https://github.com/vite-hub/vitehub/pull/3761), [`91379e54f4e17710a986a415cb9a3d7e3ae83d1d`](https://github.com/vite-hub/vitehub/commit/91379e54f4e17710a986a415cb9a3d7e3ae83d1d) | The five bundled owners below | Each real esbuild host variant traces the entry once, retains the complete static dependency chain byte for byte, and observes changed bytes on another call. If a host variant fails, retracing still retains `worker-value.ts`; a worker bundle of the retained tree executes with the expected exports. |

The Workspace patch includes the absent-path fallback from #3763. Provider inputs enter the per-call `tracedEntries` set only when every host variant succeeds. Recording them after partial success can lose a worker dependency.

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

Rate Limit #3758 is excluded because its plugin is disabled in Babysitter. Babysitter #57 and #58 were still open at integration time; their separate performance hunks are not incorporated here. This branch starts from main `233d004ba469b2af86fbeb565097681814832a6d` and preserves its repairs.

## Verification

`tests/startup-performance.test.ts` exercises installed packages. Private helpers are exposed and esbuild calls recorded through Node module load hooks in memory. The fixtures use local files and a custom-run Driver. No provider or model calls are needed.

```sh
heavy pnpm install --frozen-lockfile --store-dir .task/performance-backports/fresh-store
heavy --light node --test tests/startup-performance.test.ts
heavy pnpm test
BABYSITTER_PUBLIC_URL=https://babysitter.invalid heavy pnpm build
heavy pnpm typecheck
```

Build before typecheck in a clean checkout because it generates `.vitehub` declarations. Verification logs live in `evidence/startup-performance`.

## Extending or retiring these patches

Read `pnpm patch --help`. Use `pnpm patch <package>@0.0.4`, keep existing patches, and compare the edit directory with a frozen installed baseline. With this pinned preview, pnpm can extract pristine Agent files despite its configured patch. Apply the checked-in Agent patch first if the comparison shows its repair hunks are missing, then verify equality before editing.

Workspace has two peer instances. Select `0.0.4` and answer **no** to pnpm 10.33.0's "Apply this patch to all versions?" prompt. Its all-versions patch commit compares against the registry release instead of this Git-hosted preview and can generate an unrelated package-wide replacement. The version-specific patch still applies to both peer instances. Generate patches and lock hashes with `pnpm patch-commit <edit-directory>`, then verify a frozen install with empty `node_modules` and an empty isolated store.

Retire the performance hunks after upgrading to a build containing all three source fixes. Keep unrelated Agent and provider-runtime repairs until their replacements are verified separately. Every consuming repository needs its own backports until it upgrades.
