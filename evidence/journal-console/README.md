# Journal and Console consumer verification

All 12 new installed-package regressions fail on the pre-backport module sources and pass with the backports. The final full suite passes 228 tests. Build and post-build typecheck exit 0. The code was verified after rebasing onto corrected Babysitter [#64](https://github.com/vite-hub/babysitter/pull/64) at `f91aba402bc4dbab8e2b8db840702429ca5e6c24`.

[Verification output](verification.txt) retains assertion failures, the passing full suite, real SQLite query plans, build output, and types. [Install-input digests](install-inputs.sha256) match before and after a frozen install with empty `node_modules`, generated build directories, and an empty isolated store, and after all gates. [The installed-owner inventory](installed-owners.json) covers the 27 reachable ViteHub package instances and finds one implementation of each affected path.

The baseline run loads the three saved pre-backport journal/Console module sources through a Node load hook while running the unchanged test file. The remaining installed package code, including corrected provider tracing, stays in place. The failures are behavioral assertions, not missing imports or exports: excluded payload cloning, the position-only SQLite query plan, accepting the legacy cursor, and per-observation serialization.

The passing tests verify clone isolation, empty selections, additive reopening of a file-backed SQLite database, append order, and use of the expression index. Console checks cover empty and appended polls, boundaries around 32 and 64 observations, Unicode and escapes, rewritten prefixes, invalid counts, truncated histories, and a single legacy-cursor reset.

All 18 unrelated Agent patch sections and every existing SQLite repair hunk are preserved. The other stacked patches, complete override pins, package versions, and tarball resolutions are unchanged. All five provider guards come directly from #64. Source heads, installed owners, commands, and retirement instructions are in [the patches README](../../patches/README.md).

Fixtures use local files and request objects. No provider or model is called, and nothing is deployed or merged. These checks establish consumer behavior and reduced duplicate work. They do not measure memory, p95, or production latency.
