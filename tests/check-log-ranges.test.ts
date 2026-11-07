import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dist } from './agent-dist.ts'

const github = await import(pathToFileURL(join(dist, 'github-C5fJH50u.js')).href)

test('readCheckLogs returns a complete requested tail or named range from a long failed-step log', () => {
  assert.equal(typeof github.L, 'function', 'log tools must support retrieving omitted lines')
  const lines = Array.from({ length: 7229 }, (_, i) => `docs\tBuild docs\t2026-11-07T06:43:10Z ${i + 1} ${'build output '.repeat(8)}`)
  lines[7135] = 'docs\tBuild docs\tBroken docs links: /docs/getting-started/ai-resources links to /mcp, which has no page or file'
  const log = lines.join('\n')
  assert.doesNotMatch(github.L(log).text, /Broken docs links/, 'the diagnostic excerpt omits the cause')
  const tail = github.L(log, 500, { tailLines: 100 })
  assert.equal(tail.text, lines.slice(-100).join('\n'))
  assert.match(tail.text, /Broken docs links: .*\/mcp/)
  assert.deepEqual(tail.includedLineRanges, [[7130, 7229]])
  const range = github.L(log, 200000, { startLine: 7133, endLine: 7140 })
  assert.equal(range.text, lines.slice(7132, 7140).join('\n'))
  assert.deepEqual(range.includedLineRanges, [[7133, 7140]])
  assert.equal(range.nextLine, 7141)
  assert.equal(range.totalLines, 7229)
  assert.throws(() => github.L(log, 200000, { startLine: 20, endLine: 10 }), /1 to 1000/)
  assert.throws(() => github.L(log, 200000, { tailLines: 100, startLine: 1 }), /Choose/)
  const server = readFileSync(join(dist, 'server-DZOuXkga.js'), 'utf8')
  assert.match(server, /return operations\.readCheckLogs\(input\.runId, input\)/)
  const source = readFileSync(join(dist, 'github-C5fJH50u.js'), 'utf8')
  assert.match(source, /return checkLogExcerpt\(logs\.stdout, 2e5, selection\)/)
  assert.match(source, /"--log-failed",\s*"--allow-escape-sequences"/)
})
