import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { dist } from './agent-dist.ts'

const { y: install, v: current } = await import(pathToFileURL(join(dist, 'github-C5fJH50u.js')).href)

test('a valid hook-checksummed lockfile installs frozen without executing hooks or changing checkout inputs', async t => {
  const root = await mkdtemp(join(process.cwd(), '.test-pnpm-hook-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.git'))
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'hook-fixture', packageManager: 'pnpm@10.33.0' }))
  await writeFile(join(root, '.pnpmfile.cjs'), `if (process.env.BABYSITTER_TEST_HOOK_FAILURE) throw new Error('repository hook executed');\nmodule.exports = { hooks: { readPackage: pkg => pkg } };\n`)
  const pnpm = ['pnpm@10.33.0', 'install', '--lockfile-only', '--ignore-scripts', '--offline', '--config.verify-deps-before-run=false']
  execFileSync('corepack', pnpm, { cwd: root, env: { ...process.env, BABYSITTER_TEST_HOOK_FAILURE: '' }, stdio: 'pipe' })
  const lockfile = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')
  assert.match(lockfile, /pnpmfileChecksum:/)
  await assert.doesNotReject(install(root, undefined, async ({ cwd, command, env }: { cwd: string, command: string[], env: NodeJS.ProcessEnv }) => {
    const [program, ...args] = command
    assert.ok(program)
    execFileSync(program, args, { cwd, env: { ...env, COREPACK_HOME: process.env.COREPACK_HOME ?? join(homedir(), '.cache/node/corepack'), BABYSITTER_TEST_HOOK_FAILURE: '1' }, stdio: 'pipe' })
    return {}
  }))
  assert.equal(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'), lockfile)
  assert.equal(JSON.parse(await readFile(join(root, '.git/vitehub-install.json'), 'utf8')).status, 'installed')
  assert.equal(await current(root), true)
})
