import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createSshBoxRuntime, localTransport, type FleetBoxSession } from '../server/fleet/ssh-box.ts'

// An explicit integration check: real Corepack and pnpm, two local tarball versions, no lifecycle execution.
const output = resolve('.data/dependency-bench')
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(output, 'check-'))
const checkout = join(root, 'source')
const fleetRoot = join(root, 'fleet')
const cache = join(fleetRoot, 'pnpm-cache', 'corepack')
const checks: string[] = []
await mkdir(checkout)
await writeFile(join(checkout, 'pnpm-workspace.yaml'), "packages: ['.']\n")
const git = (...args: string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim()
const manifest = (version: number, manager = '10.33.0') => ({ name: 'fleet-fixture', private: true, packageManager: `pnpm@${manager}`, scripts: { prepare: 'node -e "require(\'fs\').writeFileSync(\'lifecycle-ran\', \'yes\')"' }, dependencies: { 'fixture-dependency': `file:dep-${version}.tgz` } })
async function setManifest(version: number, manager = '10.33.0') { await writeFile(join(checkout, 'package.json'), JSON.stringify(manifest(version, manager))) }
function lockfile() { execFileSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts', '--ignore-pnpmfile'], { cwd: checkout, env: { ...process.env, COREPACK_HOME: cache }, stdio: 'pipe' }) }
async function open(network = false) {
  const runtime = createSshBoxRuntime({ host: 'local-fixture', transport: localTransport(), root: fleetRoot, path: process.env.PATH! })
  const input = { cwd: checkout, identity: 'integration', plan: { env: { COREPACK_ENABLE_NETWORK: async () => network ? '1' : '0' }, files: {}, state: [] }, requirements: [] }
  const plan = await runtime.prepare(input)
  return { runtime, input, plan, session: await runtime.open(input, { executionAuthority: plan.executionAuthority }) as FleetBoxSession }
}
async function installed(session: FleetBoxSession, version: number, manager = '10.33.0') {
  const record = JSON.parse(Buffer.from((await session.files.read(`${session.cwd}/.git/vitehub-install.json`))!).toString())
  assert.equal(record.status, 'installed', record.reason)
  const result = await session.exec(process.execPath, ['-e', `const d=require('./node_modules/fixture-dependency'); if(d!==${version})process.exit(1); console.log(d)`])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout.trim(), String(version))
  assert.equal(await session.files.exists(`${session.cwd}/lifecycle-ran`), false)
  assert.equal(await session.files.exists(`${session.cwd}/node_modules/fixture-dependency/lifecycle-ran`), false)
  assert.equal((await session.exec('pnpm', ['--version'])).stdout.trim(), manager)
  assert.equal((await session.exec('git', ['rev-parse', 'HEAD'])).stdout.trim(), git('rev-parse', 'HEAD'))
}
async function status(session: FleetBoxSession) { return JSON.parse(Buffer.from((await session.files.read(`${session.cwd}/.git/vitehub-install.json`))!).toString()).status }

try {
  for (const version of [1, 2]) {
    const pack = join(root, `pack-${version}`)
    await mkdir(join(pack, 'package'), { recursive: true })
    await writeFile(join(pack, 'package', 'package.json'), JSON.stringify({ name: 'fixture-dependency', version: `${version}.0.0`, main: 'index.cjs', scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'lifecycle-ran\', \'yes\')"' } }))
    await writeFile(join(pack, 'package', 'index.cjs'), `module.exports=${version}\n`)
    execFileSync('tar', ['-czf', join(checkout, `dep-${version}.tgz`), '-C', pack, 'package'])
  }
  await setManifest(1)
  lockfile()
  git('init', '-q')
  git('add', '.')
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture')
  const first = await open()
  try {
    await installed(first.session, 1)
    checks.push('fresh Box installs version 1 offline with the cached pinned pnpm; lifecycle scripts stay disabled')
    await first.session.files.write(`${first.session.cwd}/private-marker`, Buffer.from('private'))
    await setManifest(2)
    lockfile()
    const changedLock = await readFile(join(checkout, 'pnpm-lock.yaml'))
    await first.session.refreshDependencies(checkout)
    await installed(first.session, 2)
    assert.deepEqual(Buffer.from((await first.session.files.read(`${first.session.cwd}/pnpm-lock.yaml`))!), changedLock)
    checks.push('changed lockfile replaces dependency version 1 with version 2 and preserves the exact lockfile')
    await first.session.refreshDependencies(checkout)
    await installed(first.session, 2)
    checks.push('unchanged refresh keeps the installed dependency correct')
  }
  finally { await first.session.close() }
  const [second, third] = await Promise.all([open(), open()])
  try {
    await Promise.all([installed(second.session, 2), installed(third.session, 2)])
    assert.notEqual(second.session.cwd, third.session.cwd)
    assert.equal(await second.session.files.exists(`${second.session.cwd}/private-marker`), false)
    await second.session.files.write(`${second.session.cwd}/private-marker`, Buffer.from('private'))
    assert.equal(await third.session.files.exists(`${third.session.cwd}/private-marker`), false)
    await installed(third.session, 2)
    checks.push('concurrent Boxes install into separate workspaces; source changes stay in their own Box')
  }
  finally { await Promise.all([second.session.close(), third.session.close()]) }

  await setManifest(1)
  const failed = await open()
  try {
    assert.equal(await status(failed.session), 'failed')
    assert.equal(await failed.session.files.exists(`${failed.session.cwd}/node_modules/fixture-dependency/index.cjs`), false)
    lockfile()
    await failed.session.refreshDependencies(checkout)
    await installed(failed.session, 1)
    checks.push('a mismatched lockfile records a failed install without stale dependencies; repaired inputs install successfully')
  }
  finally { await failed.session.close() }

  await setManifest(1, '10.34.6')
  const missing = await open()
  try {
    assert.equal(await status(missing.session), 'failed')
    assert.equal(await missing.session.files.exists(`${missing.session.cwd}/node_modules/fixture-dependency/index.cjs`), false)
    checks.push('offline setup fails for an uncached pinned pnpm version instead of using the cached wrong version')
  }
  finally { await missing.session.close() }
  const downloaded = await open(true)
  try { await installed(downloaded.session, 1, '10.34.6') }
  finally { await downloaded.session.close() }
  checks.push('retry downloads the requested pnpm version and installs successfully')

  const cancelled = await open()
  const controller = new AbortController()
  const cancelInput = { ...cancelled.input, plan: { ...cancelled.input.plan, files: { cancel: { resolve: async () => { controller.abort(); return Buffer.from('cancel') } } } } }
  await cancelled.session.close()
  await assert.rejects(cancelled.runtime.open(cancelInput, { executionAuthority: cancelled.plan.executionAuthority, signal: controller.signal }), /abort/i)
  assert.deepEqual(await readdir(join(fleetRoot, 'boxes')), [])
  const recovered = await open()
  try { await installed(recovered.session, 1, '10.34.6') }
  finally { await recovered.session.close() }
  checks.push('cancellation after install removes the workspace; the next offline Box installs successfully from package caches')
  await writeFile(join(output, 'behavior.json'), JSON.stringify({ node: process.version, packageManagers: ['10.33.0', '10.34.6'], checks, failures: 0 }, null, 2))
  console.log(JSON.stringify({ checks, failures: 0 }, null, 2))
}
finally { await rm(root, { recursive: true, force: true }) }
