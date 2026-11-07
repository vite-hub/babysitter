import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dist } from './agent-dist.ts'

const github = await import(pathToFileURL(join(dist, 'github-C5fJH50u.js')).href)
const server = readFileSync(join(dist, 'server-DZOuXkga.js'), 'utf8')

test('dependency preflight names changed inputs before validation and refresh preserves pending repairs', async t => {
  assert.equal(typeof github.D, 'function', 'host must expose dependency drift before commitRepair')
  const root = await mkdtemp(join(process.cwd(), '.test-dependency-preflight-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' })
  git('init', '-q')
  assert.deepEqual(await github.D(root), { current: true, changedInputs: [] })
  const manifest = JSON.stringify({ name: 'fixture', packageManager: 'pnpm@10.33.0' })
  await writeFile(join(root, 'package.json'), manifest)
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
  await writeFile(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n")
  await writeFile(join(root, 'repair.txt'), 'original\n')
  git('add', '.')
  const install = (run: (cwd: string) => Promise<void>) => github.y(root, undefined, async ({ cwd }: { cwd: string }) => {
    await run(cwd)
    return {}
  })
  const outputs = (cwd: string) => mkdir(join(cwd, 'node_modules'), { recursive: true }).then(() => {})
  await install(outputs)
  assert.equal((await github.D(root)).current, true)
  await writeFile(join(root, 'package.json'), `${manifest}\n`)
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n# changed\n')
  await writeFile(join(root, 'repair.txt'), 'validated repair\n')
  git('add', 'repair.txt')
  const index = git('ls-files', '--stage')
  const drift = await github.D(root)
  assert.equal(drift.current, false)
  assert.deepEqual(drift.changedInputs, ['package.json', 'pnpm-workspace.yaml'])
  assert.match(drift.reason, /Call refreshDependencies before validation/)
  await assert.rejects(install(async () => { throw new Error('ECONNRESET') }), /ECONNRESET/)
  assert.equal(await readFile(join(root, 'repair.txt'), 'utf8'), 'validated repair\n')
  assert.equal(git('ls-files', '--stage'), index)
  await install(outputs)
  assert.equal((await github.D(root)).current, true)
  assert.equal(await readFile(join(root, 'repair.txt'), 'utf8'), 'validated repair\n')
  assert.equal(git('ls-files', '--stage'), index)
  await writeFile(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n# changed\n")
  await assert.rejects(github._(root), /Dependency inputs changed or installation failed/)
  const instructions = readFileSync(join(dist, 'babysitter-ZENI2mzg.js'), 'utf8')
  assert.match(instructions, /Before running local validation, call checkDependencies/)
})

test('overlapping refresh retries share one install and a transport failure releases the refresh allowance', async () => {
  const section = server.split('//#region src/presets/babysitter/repair.ts')[1]?.split('//#endregion')[0]
  assert.ok(section)
  const { repairCapability } = await import(`data:text/javascript;base64,${Buffer.from(`
    const defineCapability = value => value;
    const normalizeGitHubMentionAllowlist = () => [];
    const lockfileDefect = error => /ERR_PNPM_.*LOCKFILE/.test(error.message);
    ${section}
    export { repairCapability };
  `).toString('base64')}`)
  let installs = 0
  let charges = 0
  let finish: () => void = () => {}
  const pending = new Promise<void>(resolve => { finish = resolve })
  const tools = repairCapability({ refreshDependencies: async () => { installs++; await pending } }, false, [], undefined, {
    beforeRepair: async () => {}, afterRefresh: async () => {},
    admitRefresh: () => { charges++; return () => { charges-- } },
  }).tools({ context: {} })
  const first = tools.refreshDependencies.execute({})
  const retry = tools.refreshDependencies.execute({})
  finish()
  await Promise.all([first, retry])
  assert.equal(installs, 1, 'a retry must join the in-flight refresh')
  const failing = repairCapability({ refreshDependencies: async () => { throw new Error('transport ECONNRESET') } }, false, [], undefined, {
    beforeRepair: async () => {}, afterRefresh: async () => {},
    admitRefresh: () => { charges++; return () => { charges-- } },
  }).tools({ context: {} })
  await assert.rejects(failing.refreshDependencies.execute({}), /ECONNRESET/)
  assert.equal(charges, 1, 'only the successful refresh consumes the allowance')
  const rejected = repairCapability({ refreshDependencies: async () => { throw new Error('Unsupported project pnpm configuration') } }, false, [], undefined, {
    beforeRepair: async () => {}, afterRefresh: async () => {},
    admitRefresh: () => { charges++; return () => { charges-- } },
  }).tools({ context: {} })
  await assert.rejects(rejected.refreshDependencies.execute({}), /Unsupported/)
  assert.equal(charges, 2, 'invalid inputs still consume the bounded allowance')
})
