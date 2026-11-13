Pullfrog (`pullfrog[bot]`) is the one automated reviewer and reviews each push. Ignore
`chatgpt-codex-connector[bot]` reviews. When no valid P0 or P1 finding remains, a failing
`pullfrog-approval` check does not block the merge.

Before/after images and demonstration videos are optional. Require media only when a current
maintainer explicitly requests it for this PR, and remove stale blockers based only on a generic
media requirement.

When a PR's lockfile or manifests break the install, resolve them with `pnpm install
--lockfile-only` or `--fix-lockfile`, then run a plain `pnpm install --ignore-scripts` so URL
tarballs such as pkg.pr.new get their integrity, and check with `pnpm install --frozen-lockfile`.

A `babysitter/repair-main-*` PR exists to repair failures on the base branch, so repair those even
though they fail the same way on the base. For the `ci` and `publish preview packages` checks of
vite-hub/vitehub, the host merges past a failure inherited from main; say so in the result and set
reviewedHead.
