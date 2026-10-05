// Regression checks for the patched @vite-hub/agent babysitter runtime.
// Each test pins a production failure from the 2026-10-05 200-session retro.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// vite-hub depends on the patched @vite-hub/agent; chunk names are content hashes.
let modules = dirname(realpathSync(fileURLToPath(import.meta.resolve('vite-hub/agent'))))
while (!modules.endsWith('/node_modules')) modules = dirname(modules)
const dist = join(modules, '@vite-hub/agent/dist')
const chunks = readdirSync(dist).filter(name => name.endsWith('.js')).map(name => ({ name, source: readFileSync(join(dist, name), 'utf8') }))
const chunk = (marker: string) => {
  const found = chunks.find(({ source }) => source.includes(marker))
  assert.ok(found, `no agent chunk contains ${marker}`)
  return found
}

test('rendered preset instructions keep the wait contract', async () => {
  const preset = chunk('function createBabysitterPreset(')
  const template = preset.source.match(/const babysitterInstructions = `([\s\S]*?)`;\n/)?.[1]
  assert.ok(template)
  const instructions = await import(pathToFileURL(join(dist, chunk('async function composeInstructionDocument').name)).href)
  const filled = await instructions.n({ template, content: 'Agent instructions.' }, {})
  const rendered: string = await instructions.i(filled, { context: {} })
  assert.match(rendered, /set wait\.kind to "checks" and wait\.headSha to the current HEAD SHA/)
  assert.match(rendered, /set reviewedHead to the current HEAD SHA/)
  assert.match(rendered, /git show HEAD:AGENTS\.md/)
  assert.doesNotMatch(rendered, /include wait: \.|use wake: \./)
})

test('unattended passes never route approvals to an absent user', () => {
  for (const { name, source } of chunks) assert.ok(!source.includes('permissions: "allow-edits"'), `${name} still uses allow-edits`)
})

test('pull request checkouts keep full history and real source files', () => {
  for (const { name, source } of chunks.filter(({ source }) => source.includes('"--no-checkout"'))) {
    assert.ok(!source.includes('--filter=blob:none'), `${name} still clones blobless`)
    assert.ok(!source.includes('generated[^/]*$'), `${name} still hides generated* source files`)
  }
})

test('CI excerpts keep the failure at the end of a noisy log', () => {
  const host = chunk('function diagnosticExcerpt(')
  const diagnosticExcerpt = new Function(`${host.source.match(/function diagnosticExcerpt[\s\S]*?\n}\n/)?.[0]}return diagnosticExcerpt`)()
  const noise = Array.from({ length: 3000 }, (_, i) => i % 7 ? `log line ${i} ${'x'.repeat(60)}` : `warn error-prone dependency ERR_${i}`)
  const { excerpt } = diagnosticExcerpt([...noise, 'AssertionError: expected 2 to be 3', 'Error: Process completed with exit code 1.'].join('\n'), 16e3)
  assert.ok(excerpt.length <= 16e3)
  assert.match(excerpt, /AssertionError: expected 2 to be 3/)
  assert.match(excerpt, /exit code 1\.$/)
})

test('PR tools keep working between a repair push and its webhook', () => {
  const inbox = chunk('function createClaimStopCheck(')
  const claimStopReason = new Function(`${inbox.source.match(/function claimStopReason[\s\S]*?\n}\n/)?.[0]}return claimStopReason`)()
  const claim = { token: 't', snapshot: { pr: { head: { sha: 'old' } } } }
  const current = (sha: string) => ({ lease: 't', leaseUntil: Date.now() + 6e4, status: 'ready', pr: { state: 'open', head: { sha } } })
  assert.equal(claimStopReason(claim, current('old'), 'pushed'), undefined)
  assert.equal(claimStopReason(claim, current('pushed'), 'pushed'), undefined)
  assert.equal(claimStopReason(claim, current('foreign'), 'pushed'), 'Pull request head changed.')
  assert.equal(claimStopReason(claim, current('foreign'), undefined), 'Pull request head changed.')
})

test('an unchanged reviewed head parks without another model pass', () => {
  assert.match(chunk('function diagnosticExcerpt(').source, /reason: "reviewed-head-unchanged"/)
})
