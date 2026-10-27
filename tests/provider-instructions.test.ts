import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let modules = dirname(realpathSync(fileURLToPath(import.meta.resolve('vite-hub/agent'))))
while (!modules.endsWith('/node_modules')) modules = dirname(modules)
const source = await readFile(join(modules, '@vite-hub/agent/dist/provider-agent.js'), 'utf8')
const section = source.split('//#region src/internal/generated-provider-git-files.ts')[1]?.split('//#endregion')[0]
assert.ok(section, 'installed package must contain the generated-file protection code')
const installed = await import(`data:text/javascript;base64,${Buffer.from(`
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
${section}
export { protectGeneratedProviderGitFiles, unmergedProviderGitFiles };
`).toString('base64')}`)
const protect: (root: string, paths: string[]) => Promise<() => Promise<void>> = installed.protectGeneratedProviderGitFiles
const unmerged: (root: string) => Promise<Set<string>> = installed.unmergedProviderGitFiles

for (const change of ['remove', 'conflict']) {
  test(`generated instruction cleanup tolerates a file that becomes ${change}`, async t => {
    const root = await mkdtemp(join(process.cwd(), '.test-provider-instructions-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' })
    git('init', '-q')
    await writeFile(join(root, 'AGENTS.md'), 'source instructions\n')
    git('add', 'AGENTS.md')
    const blob = git('rev-parse', ':AGENTS.md').trim()
    const exclude = await readFile(join(root, '.git/info/exclude'), 'utf8')
    const restore = await protect(root, [join(root, 'AGENTS.md')])
    git('update-index', '--force-remove', 'AGENTS.md')
    if (change === 'conflict') {
      execFileSync('git', ['-C', root, 'update-index', '--index-info'], {
        input: `100644 ${blob} 1\tAGENTS.md\n100644 ${blob} 2\tAGENTS.md\n100644 ${blob} 3\tAGENTS.md\n`,
      })
      assert.deepEqual(await unmerged(root), new Set(['AGENTS.md']))
      await assert.rejects(protect(root, [join(root, 'AGENTS.md')]), /Cannot overwrite conflicted generated provider files: AGENTS.md/)
    }
    const index = git('ls-files', '--stage')
    await restore()
    await restore()
    assert.equal(git('ls-files', '--stage'), index)
    assert.equal(await readFile(join(root, '.git/info/exclude'), 'utf8'), exclude)
  })
}
