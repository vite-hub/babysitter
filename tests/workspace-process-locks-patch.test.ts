import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspace, defineWorkspace } from 'vite-hub/workspace'

test('patched local store keeps path locks in memory for a process-owned root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'babysitter-process-locks-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'packages/a/src'), { recursive: true })
  await writeFile(join(root, 'packages/a/src/index.ts'), 'export {}\n')
  const workspace = await createWorkspace(defineWorkspace({ store: { provider: 'local', root, locks: 'process' } }))
  await workspace.writeFile('packages/a/README.md', 'hello')
  await Promise.all([workspace.writeFile('packages/a/one.md', '1'), workspace.writeFile('packages/a/two.md', '2')])
  const snapshot = await workspace.snapshot()
  assert.ok(snapshot.entries['packages/a/src/index.ts'])
  assert.equal(snapshot.entries['packages/a/two.md']?.size, 1)
  await assert.rejects(access(join(root, '.vitehub/locks')))
})

test('patched process locks prepare .vitehub again after a reused root loses it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'babysitter-process-locks-reuse-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = await createWorkspace(defineWorkspace({ store: { provider: 'local', root, locks: 'process' } }))
  await first.writeFile('a.md', '1')
  await rm(join(root, '.vitehub'), { recursive: true, force: true })
  await rm(`${root}.meta.json`, { force: true })
  const second = await createWorkspace(defineWorkspace({ store: { provider: 'local', root, locks: 'process' } }))
  await second.writeFile('b.md', '2')
  assert.ok((await second.snapshot()).entries['b.md'])
})

test('patched local store hides .git and Git-ignored paths from snapshots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'babysitter-git-ignore-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { execFileSync } = await import('node:child_process')
  execFileSync('git', ['init', '-q', root])
  await writeFile(join(root, '.gitignore'), 'node_modules\ndist/\n')
  await mkdir(join(root, 'node_modules/pkg'), { recursive: true }); await writeFile(join(root, 'node_modules/pkg/index.js'), 'x')
  await mkdir(join(root, 'packages/a/dist'), { recursive: true }); await writeFile(join(root, 'packages/a/dist/out.js'), 'x')
  await writeFile(join(root, 'packages/a/index.ts'), 'x')
  const workspace = await createWorkspace(defineWorkspace({ store: { provider: 'local', root, locks: 'process', ignore: 'git' } }))
  const paths = Object.keys((await workspace.snapshot()).entries)
  assert.ok(paths.includes('packages/a/index.ts'))
  assert.deepEqual(paths.filter(path => /node_modules|dist|^\.git\//.test(path)), [])
})
