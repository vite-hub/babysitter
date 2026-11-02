// A private repository on a plan without rulesets or branch protection answers 403 for both, so
// the policy reader must tell that apart from a token that cannot read the policy.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let modules = dirname(realpathSync(fileURLToPath(import.meta.resolve('vite-hub/agent'))))
while (!modules.endsWith('/node_modules')) modules = dirname(modules)
const dist = join(modules, '@vite-hub/agent/dist')
const chunk = readdirSync(dist).find(name => /^github-[\w-]+\.js$/.test(name))!
const github = await import(pathToFileURL(join(dist, chunk)).href)
type Response = { status: number, data?: unknown, nextPage?: string | null }
const createReader: (read: (path: string) => Promise<Response>) => { read: (repository: string, branch: string) => Promise<{ status: string, required: unknown[] }> } = github.t
assert.equal(createReader.name, 'createGitHubRequiredCheckPolicyReader')

const unprotected = { protected: false, protection: { enabled: false, required_status_checks: { checks: [], contexts: [], enforcement_level: 'off' } } }

function reader(branch: Response) {
  return createReader(async path => path.includes('/rules/') || path.endsWith('/protection/required_status_checks') ? { status: 403 } : branch)
}

test('a private repository without rulesets or protection requires no checks', async () => {
  const policy = await reader({ status: 200, data: unprotected }).read('onmax/private', 'main')
  assert.equal(policy.status, 'known')
  assert.deepEqual(policy.required, [])
})

test('a 403 on a protected branch stays unknown', async () => {
  const policy = await reader({ status: 200, data: { ...unprotected, protected: true } }).read('onmax/private', 'main')
  assert.equal(policy.status, 'unknown')
})

test('a 403 without a readable branch summary stays unknown', async () => {
  const policy = await reader({ status: 403 }).read('onmax/private', 'main')
  assert.equal(policy.status, 'unknown')
})
