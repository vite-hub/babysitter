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
