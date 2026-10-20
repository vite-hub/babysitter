// Host installs validate every dependency input before a package manager reads it. These tests run
// the patched validator and snapshot with a stub in place of the package manager.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let modules = dirname(realpathSync(fileURLToPath(import.meta.resolve('vite-hub/agent'))))
while (!modules.endsWith('/node_modules')) modules = dirname(modules)
const dist = join(modules, '@vite-hub/agent/dist')
const chunk = readdirSync(dist).find(name => /^github-[\w-]+\.js$/.test(name))!
const github = await import(pathToFileURL(join(dist, chunk)).href)
const install: (target: string, signal: AbortSignal | undefined, run: (input: { cwd: string }) => Promise<object>) => Promise<void> = github.y
const hasCurrentDependencies: (target: string) => Promise<boolean> = github.v
assert.equal(install.name, 'installGitHubPullRequestWorkspace')
assert.equal(hasCurrentDependencies.name, 'hasCurrentGitHubDependencies')

const patchHash = '9c8ada908b6cc52383753474a236a662dcc5a57605d5726c9e9859e70adb16ca'
// The shape pnpm 11 and newer write: the package manager's lockfile, then the project lockfile,
// whose patchedDependencies record only a hash (nuxt-modules/better-auth#557).
const lockfile = `---
lockfileVersion: '9.0'

importers:

  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm:
        specifier: 10.33.0
        version: 10.33.0

packages:

  pnpm@10.33.0:
    resolution: {integrity: sha512-AAAA}

snapshots:

  pnpm@10.33.0: {}

---
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

patchedDependencies:
  left-pad@1.3.0: ${patchHash}

importers:

  .:
    dependencies:
      left-pad:
        specifier: 1.3.0
        version: 1.3.0(patch_hash=${patchHash})

packages:

  left-pad@1.3.0:
    resolution: {integrity: sha512-BBBB}

snapshots:

  left-pad@1.3.0(patch_hash=${patchHash}): {}
`

async function workspace(patch = true) {
  const root = await mkdtemp(join(tmpdir(), 'babysitter-host-install-'))
  await mkdir(join(root, '.git'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', packageManager: 'pnpm@10.33.0', dependencies: { 'left-pad': '1.3.0' } }))
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'patchedDependencies:\n  left-pad@1.3.0: patches/left-pad@1.3.0.patch\n')
  await writeFile(join(root, 'pnpm-lock.yaml'), lockfile)
  if (patch) {
    await mkdir(join(root, 'patches'))
    await writeFile(join(root, 'patches', 'left-pad@1.3.0.patch'), 'diff --git a/index.js b/index.js\n')
  }
  return root
}

test('a pnpm 11 lockfile with two documents and hash-only patches installs', async t => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  let runs = 0
  await install(root, undefined, async ({ cwd }) => {
    runs++
    await mkdir(join(cwd, 'node_modules', 'left-pad'), { recursive: true })
    return {}
  })
  assert.equal(runs, 1)
  assert.equal(JSON.parse(await readFile(join(root, '.git', 'vitehub-install.json'), 'utf8')).status, 'installed')
  // The fingerprint covers the lockfile and the patch file, so an unchanged checkout skips a refresh.
  assert.equal(await hasCurrentDependencies(root), true)
  await writeFile(join(root, 'patches', 'left-pad@1.3.0.patch'), 'diff --git a/other.js b/other.js\n')
  assert.equal(await hasCurrentDependencies(root), false)
})

test('a manifest that names a missing patch file fails with a clear reason', async t => {
  const root = await workspace(false)
  t.after(() => rm(root, { recursive: true, force: true }))
  await assert.rejects(
    install(root, undefined, async () => ({})),
    (error: Error & { retryable?: boolean }) => /Dependency patch patches\/left-pad@1\.3\.0\.patch does not exist in this checkout/.test(error.message) && error.retryable === false,
  )
})
