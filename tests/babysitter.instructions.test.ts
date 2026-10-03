import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workerInstructions, babysitterInstructions } from '../server/agents/babysitter/instructions.ts'

test('worker composes current source instructions with scheduler rules each pass', async () => {
  let source = 'Repository instructions at the first head.'
  const fs = { async readFile(path: string) { assert.equal(path, 'AGENTS.md'); return source } }
  assert.deepEqual(await workerInstructions(fs), [source, babysitterInstructions])
  source = 'Updated instructions at the next head.'
  assert.deepEqual(await workerInstructions(fs), [source, babysitterInstructions])
})

test('missing repository instructions are optional, unreadable instructions fail visibly', async () => {
  assert.deepEqual(await workerInstructions({ async readFile() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) } }), [babysitterInstructions])
  assert.deepEqual(await workerInstructions({ async readFile() { throw Object.assign(new Error('[vitehub] Workspace file does not exist: AGENTS.md.'), { code: 'WORKSPACE_NOT_FOUND' }) } }), [babysitterInstructions])
  assert.deepEqual(await workerInstructions({ async readFile() { throw Object.assign(new Error('[vitehub] Workspace file does not exist: AGENTS.md.'), { code: 'WORKSPACE_FAILED' }) } }), [babysitterInstructions])
  await assert.rejects(workerInstructions({ async readFile() { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } }), /denied/)
})
