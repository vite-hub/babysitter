# Startup consumer verification

The ten installed-package regressions fail on main's package sources and pass with these backports. The full suite passes 206 tests; build and post-build typecheck exit 0. Node 24.21.0, Linux, pnpm 10.33.0.

[Verification output](verification.txt) retains the assertion failures and final command results. [Install input digests](install-inputs.sha256) match before and after a frozen install with empty `node_modules` and an empty isolated store. Package versions, tarball resolutions, and the provider-runtime patch/hash are unchanged. Every pre-existing Agent patch section is byte-identical.

The baseline run loads the saved frozen main package sources through a Node load hook while running the unchanged new test file. This keeps the comparison inside the isolated task checkout. All ten fail on their behavioral assertions: sibling reads or listings, traversal of schema-free data, or duplicate esbuild entries. It does not depend on missing exports or imports.

Two further load-hook checks remove one change at a time. Removing only the final missing-path fallback makes all four Workspace cases fail on sibling access. Removing only the all-variants guard makes all five provider cases fail because `worker-value.ts` is missing from the retained tree. The final code passes both scenarios, and each retained worker bundle runs with `host = "node"` and `value = "worker"`.

Fixtures use local files, real esbuild builds, and a custom-run Driver. Private compiled helpers and the esbuild call recorder are exposed in memory. Installed files remain untouched. No production service, provider, or model is called, and nothing is deployed or merged. These checks establish consumer behavior and reduced duplicate work; they do not measure production latency.

Source heads and installed owners are mapped in [the patches README](../../patches/README.md). Reproduce the final checks with its commands.
