import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createGitHubHost } from 'vite-hub/agent/server/github'

test('patched host reuses a pooled checkout, keeps ignored files, and resets the rest', async t => {
  const root = await mkdtemp(join(tmpdir(), 'babysitter-checkout-pool-'))
  const keys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_ALLOW_PROTOCOL', 'PATH'] as const
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  t.after(async () => {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key] }
    await rm(root, { recursive: true, force: true })
  })
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const base = join(root, 'base.git'), source = join(root, 'source'), pool = join(root, 'checkouts')
  await mkdir(source)
  git(root, 'init', '--bare', base)
  git(source, 'init', '-b', 'main'); git(source, 'config', 'user.name', 'Test'); git(source, 'config', 'user.email', 'test@example.invalid')
  await writeFile(join(source, '.gitignore'), 'node_modules\n'); await writeFile(join(source, 'file'), 'base')
  git(source, 'add', '.'); git(source, 'commit', '-m', 'base')
  git(source, 'push', base, 'HEAD:refs/heads/main')
  git(root, '--git-dir', base, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  git(source, 'checkout', '-b', 'one'); await writeFile(join(source, 'file'), 'one'); git(source, 'commit', '-am', 'one')
  const oneSha = git(source, 'rev-parse', 'HEAD'); git(source, 'push', base, 'HEAD:refs/heads/one')
  git(source, 'checkout', '-b', 'two', 'main'); await writeFile(join(source, 'file'), 'two'); git(source, 'commit', '-am', 'two')
  const twoSha = git(source, 'rev-parse', 'HEAD'); git(source, 'push', base, 'HEAD:refs/heads/two')
  const config = join(root, 'gitconfig')
  await writeFile(config, '')
  git(root, 'config', '--file', config, `url.file://${base}.insteadOf`, 'https://github.com/base/repo.git')
  process.env.GIT_CONFIG_GLOBAL = config; process.env.GIT_CONFIG_NOSYSTEM = '1'; process.env.GIT_ALLOW_PROTOCOL = 'file'
  const credentials = () => ({ token: 'test-token', rateLimitKey: 'offline-test' })
  const host = createGitHubHost({ checkouts: { root: pool }, credentials, identity: { login: 'Test', email: 'test@example.invalid' } })

  let firstPath = ''
  await host.withPullRequestCheckout({ repository: 'base/repo', number: 1, headSha: oneSha, headRepository: 'base/repo', headRef: 'one' }, async ({ path }) => {
    firstPath = path
    assert.equal(git(path, 'rev-parse', 'HEAD'), oneSha)
    await mkdir(join(path, 'node_modules'), { recursive: true }); await writeFile(join(path, 'node_modules/marker'), 'warm')
    await writeFile(join(path, 'file'), 'dirty'); await writeFile(join(path, 'untracked'), 'x')
    await writeFile(join(path, '.git/hooks/post-checkout'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    await mkdir(join(path, '.vitehub'), { recursive: true })
    git(path, 'config', 'core.fsmonitor', 'touch /tmp/should-not-run')
  })
  await access(firstPath)

  // A restarted process adopts the checkout that the previous process left in the pool.
  const restarted = createGitHubHost({ checkouts: { root: pool }, credentials, identity: { login: 'Test', email: 'test@example.invalid' } })
  await restarted.withPullRequestCheckout({ repository: 'base/repo', number: 2, headSha: twoSha, headRepository: 'base/repo', headRef: 'two' }, async ({ path }) => {
    assert.equal(path, firstPath)
    assert.equal(git(path, 'rev-parse', 'HEAD'), twoSha)
    assert.equal(git(path, 'branch', '--show-current'), 'two')
    assert.equal(await readFile(join(path, 'file'), 'utf8'), 'two')
    assert.equal(await readFile(join(path, 'node_modules/marker'), 'utf8'), 'warm')
    await assert.rejects(access(join(path, 'untracked')))
    await assert.rejects(access(join(path, '.git/hooks/post-checkout')))
    await assert.rejects(access(join(path, '.vitehub')))
    assert.throws(() => git(path, 'config', 'core.fsmonitor'))
    assert.equal(git(path, 'config', 'remote.origin.pushurl'), 'https://github.com/base/repo.git')
  })
  await restarted.withPullRequestCheckout({ repository: 'base/repo', number: 3, headSha: oneSha }, async ({ path }) => {
    assert.equal(path, firstPath)
    assert.equal(git(path, 'rev-parse', 'HEAD'), oneSha)
    assert.match(git(path, 'config', 'remote.origin.pushurl'), /^disabled:/)
    assert.throws(() => git(path, 'config', 'remote.origin.push'))
  })
})
