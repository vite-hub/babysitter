import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createSshBoxRuntime, localTransport } from '../server/fleet/ssh-box.ts'

const output = resolve('.data/corepack-isolation')
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(output, 'fixture-'))
const checkout = join(root, 'source')
const valid = 'pnpm@10.33.0+sha512.10568bb4a6afb58c9eb3630da90cc9516417abebd3fabbe6739f0ae795728da1491e9db5a544c76ad8eb7570f5c4bb3d6c637b2cb41bfdcdb47fa823c8649319'
const setPin = (pin: string) => writeFile(join(checkout, 'package.json'), JSON.stringify({ name: 'corepack-isolation', private: true, packageManager: pin }))
const runtime = createSshBoxRuntime({ host: 'local-isolation', transport: localTransport(), root: join(root, 'fleet'), path: process.env.PATH! })
const results: object[] = []

async function open(network: boolean) {
  const input = { cwd: checkout, identity: 'isolation-check', plan: { env: { COREPACK_DEFAULT_TO_LATEST: async () => '0', COREPACK_ENABLE_NETWORK: async () => network ? '1' : '0' }, files: {}, state: [] }, requirements: [] }
  const plan = await runtime.prepare(input)
  return runtime.open(input, { executionAuthority: plan.executionAuthority })
}

async function record(session: Awaited<ReturnType<typeof open>>) {
  const value: unknown = JSON.parse(Buffer.from((await session.files.read(`${session.cwd}/.git/vitehub-install.json`))!).toString())
  assert.ok(value !== null && typeof value === 'object' && 'status' in value)
  return value
}

try {
  await mkdir(checkout)
  await setPin(valid)
  await writeFile(join(checkout, 'pnpm-workspace.yaml'), "packages: ['.']\n")
  await writeFile(join(checkout, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n")
  execFileSync('git', ['init', '-q', checkout])
  execFileSync('git', ['-C', checkout, 'add', '.'])
  execFileSync('git', ['-C', checkout, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'])
  const first = await open(true)
  try {
    const firstHome = (await first.exec('sh', ['-c', 'printf %s "$COREPACK_HOME"'])).stdout
    await first.files.write(`${firstHome}/v1/pnpm/10.33.0/worker-marker`, Buffer.from('private artifact changes'))
    const second = await open(false)
    try {
      assert.equal((await record(first)).status, 'installed')
      assert.equal((await record(second)).status, 'installed')
      const secondHome = (await second.exec('sh', ['-c', 'printf %s "$COREPACK_HOME"'])).stdout
      assert.equal(await second.files.exists(`${secondHome}/v1/pnpm/10.33.0/worker-marker`), false)
      assert.equal(await second.files.exists(`${secondHome}/lastKnownGood.json`), false)
      const activate = await first.exec('corepack', ['install', '--global', 'pnpm@10.33.0'])
      assert.equal(activate.code, 0, activate.stderr)
      assert.equal(await first.files.exists(`${firstHome}/lastKnownGood.json`), true)
      assert.equal(await second.files.exists(`${secondHome}/lastKnownGood.json`), false)
      results.push({ check: 'same full pin reuses downloaded artifacts offline with private default state', passed: true })
    }
    finally { await second.close() }
  }
  finally { await first.close() }

  await setPin('pnpm@10.33.0+sha512.' + '0'.repeat(128))
  const invalid = await open(true)
  try {
    const failed = await record(invalid)
    assert.equal(failed.status, 'failed')
    assert.ok('reason' in failed && typeof failed.reason === 'string')
    assert.match(failed.reason, /Mismatch hashes/)
    results.push({ check: 'a different integrity pin is rejected after the valid version warms its cache', passed: true })
    await invalid.files.write(`${invalid.cwd}/package.json`, Buffer.from(JSON.stringify({ name: 'corepack-isolation', private: true, packageManager: valid })))
    const repair = await invalid.exec('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile'])
    assert.equal(repair.code, 0, repair.stderr)
    const unchangedBadPin = await open(false)
    try {
      assert.equal((await record(unchangedBadPin)).status, 'failed')
      results.push({ check: 'repairing the manifest inside a failed Box cannot populate the original bad-pin cache', passed: true })
    }
    finally { await unchangedBadPin.close() }
  }
  finally { await invalid.close() }
  await setPin(valid)
  const recovered = await open(false)
  try {
    assert.equal((await record(recovered)).status, 'installed')
    results.push({ check: 'an integrity failure does not damage the valid pin cache', passed: true })
  }
  finally { await recovered.close() }
  const report = { node: process.version, results, failures: 0 }
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
finally { await rm(root, { recursive: true, force: true }) }
