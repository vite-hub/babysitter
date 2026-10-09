import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createGitHubHost } from 'vite-hub/agent/server/github'

test('patched host ignores stale synthetic PR refs and checks out the current source fork branch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'babysitter-host-checkout-'))
  const keys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_ALLOW_PROTOCOL', 'PATH'] as const
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  t.after(async () => {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key] }
    await rm(root, { recursive: true, force: true })
  })
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const base = join(root, 'base.git'), fork = join(root, 'fork.git'), source = join(root, 'source')
  await mkdir(source)
  git(root, 'init', '--bare', base); git(root, 'init', '--bare', fork)
  git(source, 'init', '-b', 'main'); git(source, 'config', 'user.name', 'Test'); git(source, 'config', 'user.email', 'test@example.invalid')
  await writeFile(join(source, 'file'), 'base'); git(source, 'add', 'file'); git(source, 'commit', '-m', 'base')
  const baseSha = git(source, 'rev-parse', 'HEAD')
  git(source, 'push', base, 'HEAD:refs/heads/main')
  git(root, '--git-dir', base, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  git(source, 'checkout', '-b', 'fix'); await writeFile(join(source, 'file'), 'pr'); git(source, 'commit', '-am', 'pr')
  const stalePrSha = git(source, 'rev-parse', 'HEAD')
  git(source, 'push', base, 'HEAD:refs/pull/7/head')
  git(source, 'push', base, 'HEAD:refs/heads/fix')
  // GitHub's synthetic PR ref and same-named base branch can both lag
  // the actual source fork. Only the source branch contains the live head.
  await writeFile(join(source, 'file'), 'newer source head'); git(source, 'commit', '-am', 'advance fork')
  const headSha = git(source, 'rev-parse', 'HEAD')
  git(source, 'push', fork, 'HEAD:refs/heads/fix')
  const config = join(root, 'gitconfig')
  await writeFile(config, '')
  git(root, 'config', '--file', config, `url.file://${base}.insteadOf`, 'https://github.com/base/repo.git')
  git(root, 'config', '--file', config, `url.file://${fork}.insteadOf`, 'https://github.com/source/repo.git')
  await writeFile(join(root, 'gh'), '#!/bin/sh\necho "Unexpected GitHub API dependency" >&2\nexit 97\n', { mode: 0o700 })
  process.env.GIT_CONFIG_GLOBAL = config; process.env.GIT_CONFIG_NOSYSTEM = '1'; process.env.GIT_ALLOW_PROTOCOL = 'file'; process.env.PATH = `${root}:${process.env.PATH}`
  const authRepositories: Array<string | undefined> = []
  const host = createGitHubHost({ credentials: ({ repository }) => { authRepositories.push(repository); return { token: 'test-token', rateLimitKey: 'offline-test' } }, identity: { login: 'Test', email: 'test@example.invalid' } })
  const pr = { repository: 'base/repo', number: 7, headSha, headRepository: 'source/repo', headRef: 'fix' }
  let checkoutPath = ''
  await host.withPullRequestCheckout(pr, async ({ path, env, push }) => {
    checkoutPath = path
    assert.equal(git(path, 'rev-parse', 'HEAD'), headSha)
    assert.ok(authRepositories.includes('source/repo'))
    assert.equal(git(root, '--git-dir', base, 'rev-parse', 'refs/pull/7/head'), stalePrSha)
    assert.notEqual(headSha, stalePrSha)
    assert.equal(git(path, 'branch', '--show-current'), 'fix')
    assert.equal(git(path, 'config', 'remote.origin.url'), 'https://github.com/base/repo.git')
    assert.equal(git(path, 'config', 'remote.origin.pushurl'), 'https://github.com/source/repo.git')
    await writeFile(join(path, 'file'), 'repaired')
    execFileSync('git', ['commit', '-am', 'repair'], { cwd: path, env: { ...process.env, ...env }, stdio: 'pipe' })
    await push()
    assert.equal(git(root, '--git-dir', fork, 'rev-parse', 'refs/heads/fix^'), headSha)
    assert.equal(git(root, '--git-dir', base, 'rev-parse', 'refs/heads/main'), baseSha)
  })
  try {
    assert.deepEqual(await readdir(checkoutPath), [])
  } catch (error) {
    assert.equal(error?.code, 'ENOENT')
  }
  await assert.rejects(host.withPullRequestCheckout({ ...pr, headSha: baseSha }, async () => assert.fail('must reject stale head before callback')), /Pull request head changed/)
  await host.withPullRequestCheckout({ repository: pr.repository, number: pr.number, headSha: stalePrSha }, async ({ path }) => {
    assert.equal(git(path, 'rev-parse', 'HEAD'), stalePrSha)
    assert.equal(git(path, 'branch', '--show-current'), '')
    assert.match(git(path, 'config', 'remote.origin.pushurl'), /^disabled:/)
  })
})
