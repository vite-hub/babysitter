import assert from 'node:assert/strict'
import test from 'node:test'
import { readWorkspaceFile, resolveSessionWorkspace } from '../server/session-workspace.ts'

const invocation = {
  annotations: {
    'github.head': 'a'.repeat(40),
    'github.pullRequest': 42,
    'github.repository': 'vite-hub/vitehub',
  },
  createdAt: '2026-08-31T00:00:00.000Z',
  id: 'invocation',
  observations: [],
  status: 'completed',
  traceId: 'trace',
  updatedAt: '2026-08-31T00:00:00.000Z',
}

test('resolves the immutable GitHub Workspace from invocation annotations', async () => {
  const calls = []
  const workspace = await resolveSessionWorkspace(invocation, async (args) => {
    calls.push(args)
    return {
      stderr: '',
      stdout: JSON.stringify({ tree: [
        { path: 'src/index.ts', type: 'blob' },
        { path: 'src', type: 'tree' },
        { path: 'AGENTS.md', type: 'blob' },
      ] }),
    }
  })

  assert.deepEqual(workspace, {
    paths: ['AGENTS.md', 'src/index.ts'],
    pullRequest: 42,
    repository: 'vite-hub/vitehub',
    revision: 'a'.repeat(40),
  })
  assert.deepEqual(calls[0], [
    'api', '--method', 'GET', '-f', 'recursive=1',
    `repos/vite-hub/vitehub/git/trees/${'a'.repeat(40)}`,
  ])
})

test('loads only a text file from the resolved Workspace revision', async () => {
  const content = 'export const restored = true\n'
  const file = await readWorkspaceFile({
    pullRequest: 42,
    repository: 'vite-hub/vitehub',
    revision: 'a'.repeat(40),
  }, 'src/index.ts', async () => ({
    stderr: '',
    stdout: JSON.stringify({
      content: Buffer.from(content).toString('base64'),
      encoding: 'base64',
      size: Buffer.byteLength(content),
      type: 'file',
    }),
  }))

  assert.deepEqual(file, {
    content,
    path: 'src/index.ts',
    revision: 'a'.repeat(40),
    size: Buffer.byteLength(content),
  })
})

test('rejects paths outside the immutable Workspace tree', async () => {
  await assert.rejects(
    readWorkspaceFile({
      paths: ['src/index.ts'],
      pullRequest: 42,
      repository: 'vite-hub/vitehub',
      revision: 'a'.repeat(40),
    }, '../secret', async () => ({ stderr: '', stdout: '{}' })),
    /Invalid Workspace path/,
  )
})
