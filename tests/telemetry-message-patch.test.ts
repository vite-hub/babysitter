import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { createMemoryAgentInvocationStore, defineAgentInvocations } from 'vite-hub/agent/server'

// Exercise the installed pnpm patch through the real invocation journal.
const dist = new URL('../../../@vite-hub/agent/dist/', import.meta.resolve('vite-hub/agent/server'))
const chunk = (await readdir(dist)).find(name => /^invocations-.*\.js$/.test(name))!
const { i: bindAgentInvocations } = await import(new URL(chunk, dist).href)

for (const attribute of ['input.messages', 'input.prompt']) {
  test(`${attribute}: oversized bodies preserve roles, types and IDs across messages`, async () => {
    const invocations = defineAgentInvocations({ content: 'content', store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, {
      memo() {}, run: { runId: attribute }, runtime: 'unknown', waitUntil() {},
    })
    const messages = [
      { id: 'first', parts: [{ text: 'x'.repeat(100_000), type: 'text' }], role: 'user' },
      { content: 'y'.repeat(100_000), role: 'assistant', id: 'second' },
      { parts: [{ text: 'last', type: 'text' }], role: 'user', id: 'third' },
    ]
    await journal.context.traceLog.append({ name: 'agent.invocation.start', type: 'run', attributes: { [attribute]: messages } })
    await journal.finish('completed')
    const record = await invocations.getByRunId(attribute)
    const observation = record?.observations.find(item => item.attributes?.[attribute])
    assert.ok(observation)
    assert.equal(observation.attributes?.['vitehub.observation.truncated'], true)
    const saved = observation.attributes![attribute] as typeof messages
    assert.deepEqual(saved.map(message => message.role), ['user', 'assistant', 'user'])
    assert.deepEqual(saved.map(message => message.id), ['first', 'second', 'third'])
    assert.equal(saved[0]!.parts![0]!.type, 'text')
    assert.equal(saved[2]!.parts![0]!.type, 'text')
    assert.ok(saved[0]!.parts![0]!.text.length > 0)
    assert.ok(saved[0]!.parts![0]!.text.length < 100_000)
    assert.ok(JSON.stringify(saved).length < 67_000)
    assert.equal(messages[0]!.parts![0]!.text.length, 100_000)
  })
}

test('short input remains unchanged and has no truncation warning', async () => {
  const invocations = defineAgentInvocations({ content: 'content', store: createMemoryAgentInvocationStore() })
  const journal = await bindAgentInvocations(invocations, {
    memo() {}, run: { runId: 'short' }, runtime: 'unknown', waitUntil() {},
  })
  const messages = [{ parts: [{ text: 'Work on PR #1392.', type: 'text' }], role: 'user' }]
  await journal.context.traceLog.append({ name: 'agent.invocation.start', type: 'run', attributes: { 'input.messages': messages } })
  await journal.finish('completed')
  const observation = (await invocations.getByRunId('short'))?.observations.find(item => item.attributes?.['input.messages'])
  assert.deepEqual(observation?.attributes?.['input.messages'], messages)
  assert.equal(observation?.attributes?.['vitehub.observation.truncated'], undefined)
})
