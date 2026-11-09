# Startup consumer verification

The final installation passes 20 startup probes and all 216 consumer tests. Build and post-build typecheck exit 0. Node 24.21.0, Linux, pnpm 10.33.0.

The original ten probes fail on main's saved package sources. The provider safety follow-up adds ten cases, query and computed overlap for each of Agent, Database, Queue, Schedule, and Workflow. All ten fail on the previous #64 head `af10c994ab9203d2eeade0c75b939c6bdbfa7059` because the retained tree lacks `worker-value.ts`. Before that assertion, each confirms that all five initial host builds succeeded and some metafiles omitted the shared module. With upstream provider head `5d5f734d8c0ab929f110b4c0612f11c17fb1a03f` backported, all ten retain identical target bytes and execute a worker bundle with `value = "worker"`.

[Verification output](verification.txt) keeps the original integration results and the provider safety comparison separately. [Install input digests](install-inputs.sha256) match before and after the final frozen install with empty `node_modules` and an empty isolated store. Package versions, tarball resolutions, Workspace and provider-runtime patches/hashes, and existing Agent repairs remain unchanged. The five provider patches differ from the prior #64 head only by the per-module guard and generated index hashes. The lockfile differs only by generated patch and peer hashes.

[The public-entry bundle check](public-consumer-bundles.mjs) builds all five installed Vite exports and preserves their plugin exports, with package dependencies external. Each output also passes `node --check`. The consumer probes separately use real esbuild builds and execute the retained worker output. The application build covers Babysitter's enabled configuration.

The earlier load-hook checks removing the absent-path fallback or the aggregate-success guard remain in the historical output. Both Workspace peer instances, schema-backed mutation validation, direct capability tracking, static trace de-duplication, byte retention across calls, and failed-variant retries still pass in the final suite.

Fixtures use local files and a custom-run Driver. Private compiled helpers and the esbuild recorder are exposed in memory. No production service, provider, or model is called, and nothing is deployed or merged. These checks establish consumer behavior; they do not measure production latency.

Source heads and installed owners are mapped in [the patches README](../../patches/README.md), with commands to reproduce the checks.
