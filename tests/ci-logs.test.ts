// 2026-11-01: vitehub #2998 and #3084 spent days asking for CI logs. readCheckLogs returned the first
// 200,000 characters (successful builds) or failed on a 43 MB log, and gh 2.103 refused every colored
// job log in the preload, so the model never saw the failure.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let modules = dirname(realpathSync(fileURLToPath(import.meta.resolve('vite-hub/agent'))))
while (!modules.endsWith('/node_modules')) modules = dirname(modules)
const dist = join(modules, '@vite-hub/agent/dist')
const chunk = readdirSync(dist).find(name => /^github-.*\.js$/.test(name) && readFileSync(join(dist, name), 'utf8').includes('function compactCiLog('))
assert.ok(chunk, 'compactCiLog is missing from the patched GitHub chunk')
const { S: compactCiLog, T: diagnosticExcerpt } = await import(join(dist, chunk))
const source = readdirSync(dist).filter(name => name.endsWith('.js')).map(name => readFileSync(join(dist, name), 'utf8')).join('\n')

const build = (count: number) => Array.from({ length: count }, (_, n) => `package tests\tbuild\t2026-11-01T00:00:00Z ✓ built chunk ${n}`).join('\n')

test('compacting strips color codes and branch listings', () => {
  const log = [
    'package tests\tcheckout\t2026-11-01T00:00:00Z  * [new branch]          fix/agent-error -> origin/fix/agent-error',
    'package tests\ttest\t2026-11-01T00:00:01Z \u001b[31mFAIL\u001b[39m test/a.test.ts',
    'package tests\ttest\t2026-11-01T00:00:02Z ^[[41m^[[1m FAIL ^[[22m^[[49m test/b.test.ts',
  ].join('\n')
  assert.equal(compactCiLog(log), [
    'package tests\ttest\t2026-11-01T00:00:01Z FAIL test/a.test.ts',
    'package tests\ttest\t2026-11-01T00:00:02Z  FAIL  test/b.test.ts',
  ].join('\n'))
})

test('compacting keeps the tail of an oversized log', () => {
  const log = `${build(1000)}\nERR_PNPM_PEER_DEP_ISSUES Unmet peer dependencies`
  const compact = compactCiLog(log, 2000)
  assert.ok(compact.length < 2100)
  assert.match(compact, /^\[\d+ earlier log lines omitted\]\n/)
  assert.ok(compact.endsWith('ERR_PNPM_PEER_DEP_ISSUES Unmet peer dependencies'))
})

test('the excerpt shows a failure after a long successful build', () => {
  const failure = 'package tests\ttest\t2026-11-01T00:10:00Z TypeCheckError: \'details\' does not exist in type'
  const excerpt = diagnosticExcerpt(compactCiLog(`${build(20000)}\n${failure}\n Errors  1 error`), 16e3)
  assert.equal(excerpt.complete, false)
  assert.ok(excerpt.excerpt.includes(failure))
})

test('log readers use the large buffer and the failure excerpt', () => {
  assert.match(source, /maxBuffer: input\.maxBuffer \?\? maxBuffer,/)
  assert.match(source, /"api",\n\t+"--allow-escape-sequences",\n\t+path\n\t+\], \{\n\t+repository,\n\t+timeout: 6e4,\n\t+maxBuffer: CI_LOG_MAX_BUFFER,/)
  assert.equal(source.match(/"--log-failed"\n\t+\], \{\n\t+\.\.\.commandOptions,\n\t+maxBuffer: CI_LOG_MAX_BUFFER\n\t+\}\);/g)?.length, 2)
  assert.doesNotMatch(source, /text: logs\.stdout\.slice\(0, limit\)/)
})
