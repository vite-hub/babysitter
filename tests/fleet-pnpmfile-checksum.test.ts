import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { installCommand } from '../server/fleet/ssh-box.ts'

test('a Box installs a hook-checksummed lockfile frozen, without running the hook or changing the lockfile', async t => {
  const root = await mkdtemp(join(process.cwd(), '.test-fleet-pnpm-hook-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.git'))
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'hook-fixture', packageManager: 'pnpm@10.33.0' }))
  await writeFile(join(root, '.pnpmfile.cjs'), `if (process.env.BABYSITTER_TEST_HOOK_FAILURE) throw new Error('repository hook executed');\nmodule.exports = { hooks: { readPackage: pkg => pkg } };\n`)
  const env = { ...process.env, npm_config_verify_deps_before_run: 'false' }
  execFileSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts', '--offline'], { cwd: root, env: { ...env, BABYSITTER_TEST_HOOK_FAILURE: '' }, stdio: 'pipe' })
  const lockfile = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')
  assert.match(lockfile, /^pnpmfileChecksum:/m)

  const command = await installCommand(root)
  assert.ok(command)
  // Without the fix, this exits with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH.
  execFileSync('sh', ['-c', command], { cwd: root, env: { ...env, BABYSITTER_TEST_HOOK_FAILURE: '1' }, stdio: 'pipe' })
  assert.equal(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'), lockfile)
})

test('a lockfile without a hook checksum keeps the plain frozen install', async t => {
  const root = await mkdtemp(join(process.cwd(), '.test-fleet-pnpm-plain-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  assert.equal(await installCommand(root), 'pnpm install --frozen-lockfile --prefer-offline --ignore-scripts --ignore-pnpmfile')
})
