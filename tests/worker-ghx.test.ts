import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

test('worker gh routes inferred and explicit repositories through proxy without network', async t => {
  const root = await mkdtemp(join(tmpdir(), 'worker-ghx-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stub = join(root, 'gh-stub')
  await writeFile(stub, `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),host:process.env.GH_HOST,repo:process.env.GH_REPO,auth:process.env.GH_ENTERPRISE_TOKEN}))\n`, { mode: 0o700 })
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['remote', 'add', 'origin', 'https://placeholder-credential@github.com/onmax/example.git'], { cwd: root })
  const wrapper = resolve('scripts/worker-ghx.sh')
  const env = { PATH: process.env.PATH, GHX_GH_PATH: stub, GH_TOKEN: 'test-token' }
  const run = (args: string[], extra: Record<string, string> = {}) => JSON.parse(execFileSync('bash', [wrapper, ...args], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' }))
  const inferred = run(['pr', 'checks', '1'])
  assert.equal(inferred.host, 'ghx.onmax.me')
  assert.equal(inferred.repo, 'ghx.onmax.me/onmax/example')
  assert.equal(inferred.auth, 'test-token')
  assert.ok(!JSON.stringify(inferred).includes('placeholder-credential'))
  assert.equal(run(['pr', 'view', '1'], { GH_REPO: 'vite-hub/vitehub' }).repo, 'ghx.onmax.me/vite-hub/vitehub')
  const explicit = run(['pr', 'checks', '1', '--repo', 'https://github.com/owner/other'], { GH_REPO: 'invalid', GH_ENTERPRISE_TOKEN: 'enterprise-test-token' })
  assert.equal(explicit.repo, undefined)
  assert.equal(explicit.auth, 'enterprise-test-token')
  assert.deepEqual(explicit.args.slice(-2), ['--repo', 'ghx.onmax.me/owner/other'])
  assert.equal(run(['pr', 'view', '--repo=github.com/owner/repo']).args[2], '--repo=ghx.onmax.me/owner/repo')
  assert.equal(run(['pr', 'view', '-Rowner/repo']).args[2], '-Rghx.onmax.me/owner/repo')
  assert.deepEqual(run(['api', 'https://api.github.com/repos/owner/repo', '--hostname', 'github.com']).args, ['api', 'repos/owner/repo', '--hostname', 'ghx.onmax.me'])
  assert.equal(run(['api', 'rate_limit', '--hostname=github.com']).args[2], '--hostname=ghx.onmax.me')
  assert.deepEqual(run(['auth', 'setup-git']).args, ['auth', 'setup-git'])
  for (const option of ['--body', '-b', '--title', '-t', '--body-file', '--field', '-f', '--raw-field', '-F', '--jq', '-q', '--template', '--header', '-H', '--message', '-m']) {
    for (const payload of ['-Rfoobar', '--repo=untrusted/input', '--hostname', 'https://github.com/owner/repo/pull/123']) {
      const args = ['pr', 'comment', '1', option, payload]
      assert.deepEqual(run(args).args, args)
    }
  }
  const literal = ['pr', 'view', '--', '--repo=untrusted/input', '-Rfoobar', 'https://github.com/owner/repo/pull/123']
  assert.deepEqual(run(literal).args, literal)
  assert.deepEqual(run(['pr', 'view', 'https://github.com/owner/repo/pull/123']).args, ['pr', 'view', 'https://ghx.onmax.me/owner/repo/pull/123'])
  assert.deepEqual(run(['issue', 'view', 'https://github.com/owner/repo/issues/456']).args, ['issue', 'view', 'https://ghx.onmax.me/owner/repo/issues/456'])
  const rejected = spawnSync('bash', [wrapper, 'pr', 'view', '--repo', 'https://token@example.org/owner/repo'], { cwd: root, env, encoding: 'utf8' })
  assert.equal(rejected.status, 2)
  assert.ok(!rejected.stderr.includes('token'))
})
