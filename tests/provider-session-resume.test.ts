// A pass resumes the previous pass's Codex thread only on a warm PR workspace, after a pass that
// pushed or recorded a wait, on the same base commit and release. These tests run the patched rule,
// the provider session store and prompt selection, and check the Babysitter wiring.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dist } from './agent-dist.ts'

const pool = await import(pathToFileURL(join(dist, 'pr-workspaces.js')).href)
const provider = readFileSync(join(dist, 'provider-agent.js'), 'utf8')
const server = readFileSync(join(dist, 'server-DZOuXkga.js'), 'utf8')

/** Loads top-level declarations from the installed provider bundle. */
async function extract(names: string[], prelude = '') {
  const parts = names.map(name => {
    const match = provider.match(new RegExp(`\\n((?:async )?function ${name}\\([^]*?\\n\\}|const ${name} = [^\\n]*;)`))
    assert.ok(match, `provider bundle must define ${name}`)
    return match[1]
  })
  return await import(`data:text/javascript;base64,${Buffer.from(`${prelude}\n${parts.join('\n')}\nexport { ${names.join(', ')} };`).toString('base64')}`)
}

const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const finished = { head, base, ok: true, resumable: true, release: 'r1' }

test('the resume rule: warm workspace, a pass that pushed or waited, same base and release', () => {
  const decide = (previous: object | undefined, workspace: string | undefined, current = { base, release: 'r1' }) => pool.providerSessionDecision(previous, workspace, current)
  assert.deepEqual(decide(finished, 'warm'), { resume: true, reason: 'resumed' })
  // Every reason the workspace was reset starts a fresh thread: foreign head, failed pass, dirty tree.
  for (const reason of ['cold', 'foreign-head', 'failed-pass', 'dirty', 'missing-metadata']) assert.deepEqual(decide(finished, reason), { resume: false, reason: `workspace-${reason}` })
  assert.deepEqual(decide(finished, undefined), { resume: false, reason: 'workspace-unprepared' })
  // A pass that completed without a push or a recorded wait is not resumed.
  assert.deepEqual(decide({ ...finished, resumable: false }, 'warm'), { resume: false, reason: 'unfinished-pass' })
  assert.deepEqual(decide({ ...finished, resumable: undefined }, 'warm'), { resume: false, reason: 'unfinished-pass' })
  assert.deepEqual(decide(finished, 'warm', { base: 'c'.repeat(40), release: 'r1' }), { resume: false, reason: 'base-moved' })
  assert.deepEqual(decide(finished, 'warm', { base: undefined as unknown as string, release: 'r1' }), { resume: false, reason: 'base-moved' })
  assert.deepEqual(decide(finished, 'warm', { base, release: 'r2' }), { resume: false, reason: 'new-release' })
  // The head rule comes from the workspace decision: a foreign head is never warm.
  assert.deepEqual(pool.workspaceDecision(finished, 'c'.repeat(40)), { reuse: false, reason: 'foreign-head' })
  assert.deepEqual(pool.workspaceDecision({ ...finished, ok: false }, head), { reuse: false, reason: 'failed-pass' })
  assert.deepEqual(pool.workspaceDecision(finished, head), { reuse: true, reason: 'warm' })
})

test('a fresh pass drops the stored cursor, and a resumed pass reads it once', async () => {
  const { partitionProviderSessionStore } = await extract([
    'invalidatedProviderSessions', 'providerSessionCursorRecordKey', 'providerSessionCursorRecord', 'isProviderSessionCursorRecord', 'partitionProviderSessionStore',
  ], 'const isRuntimeRecord = value => typeof value === "object" && value !== null && !Array.isArray(value);')
  const rows = new Map<string, unknown>()
  const store = { get: async (key: string) => rows.get(key), set: async (key: string, value: unknown) => { rows.set(key, value) }, delete: async (key: string) => { rows.delete(key) } }
  const key = JSON.stringify(['unknown', 'anonymous', 'anonymous:unknown', 'github:o/r:pull-request:7'])
  // Pass 1 completes and commits its cursor under the stable key.
  await partitionProviderSessionStore(store, key).commit({ threadId: 'codex-1' })
  // Pass 2 resumes it; consume removes it so a crash cannot resume it twice.
  assert.deepEqual(await partitionProviderSessionStore(store, key).consume(), { threadId: 'codex-1' })
  assert.equal(await partitionProviderSessionStore(store, key).consume(), undefined)
  // Pass 2 commits again, then ends badly: the Babysitter invalidates the key at once.
  await partitionProviderSessionStore(store, key).commit({ threadId: 'codex-1' })
  await partitionProviderSessionStore(store, key).invalidate()
  assert.equal(rows.size, 0)
  // A fresh pass invalidates before it starts, whatever an earlier pass left.
  await partitionProviderSessionStore(store, key).commit({ threadId: 'codex-old' })
  await partitionProviderSessionStore(store, key).invalidate()
  assert.equal(await partitionProviderSessionStore(store, key).consume(), undefined)
})

test('runProvider honors run.providerSession: a fresh run invalidates instead of consuming and reports back', () => {
  assert.match(provider, /const freshProviderSession = providerSession\?\.resume === false;/)
  assert.match(provider, /let pendingResumeCursor = preservesProviderSession && sessionKey && !freshProviderSession \? resumeCursors\.get\(sessionKey\) : void 0;/)
  assert.match(provider, /freshProviderSession \? await waitForProviderOperation\(sessionStore\.invalidate\(\), effectiveSignal\)\.then\(\(\) => void 0\) : await waitForProviderOperation\(sessionStore\.consume\(\)/)
  assert.match(provider, /providerSession\.resumed = resumeCursor !== void 0;/)
  assert.match(provider, /providerSession\.invalidate = async \(\) => \{\n\t+resumeCursors\.delete\(sessionKey\);\n\t+await partition\.invalidate\(\);/)
  // Still committed only after a run that completed without error.
  assert.match(provider, /if \(completed && caught === void 0 && cleanupErrors\.length === 0 && !deferredCleanup && pendingResumeCursor !== void 0\) try \{\n\t+await sessionStore\?\.commit\(pendingResumeCursor\);/)
})

test('a resumed thread still receives the full current PR snapshot', async () => {
  const { providerPrompt } = await extract(['latestUserMessages', 'providerMessageContent', 'providerPrompt'], 'const isAttachmentPart = () => false;')
  const snapshot = 'Repair PR #7 in o/r.\n\n<resumed-pass>...</resumed-pass>\n\n<pull-request>new comment from onmax; ci failed</pull-request>'
  const messages = [{ role: 'user', parts: [{ type: 'text', text: snapshot }] }]
  assert.equal(providerPrompt(messages, true), snapshot)
  assert.equal(providerPrompt(messages, false), snapshot)
  // The Babysitter sends one user message per pass, built from the claim's current snapshot.
  assert.match(server, /const userMessage = `\$\{prompt\}\$\{resumeContext\}\\n\\n\$\{snapshotContext\}\$\{installContext\}/)
  assert.match(server, /messages: \[createMessage\(\{\n\t+role: "user",\n\t+text: userMessage\n\t+\}\)\]/)
  assert.match(server, /const snapshotContext = snapshotPrompt\(webhookSnapshot\);/)
})

test('the Babysitter keeps the stable thread id in a PR workspace and records what may be resumed', () => {
  assert.match(server, /workspaceRun\.session = workspaceEntry && !workerSettings\.box \? providerSessionDecision\(workspaceEntry\.previous, workspaceRun\.reason, \{\n\t+base: pullRequest\.baseRefOid,\n\t+release: baseAgent\.version/)
  assert.match(server, /if \(workspaceRun\.session\) \{\n\t+workspaceRun\.providerSession = \{ resume: workspaceRun\.session\.resume \};\n\t+githubRun\.providerSession = workspaceRun\.providerSession;\n\t+\} else githubRun\.threadId = `\$\{githubRun\.threadId\}:\$\{runId\}`;/)
  // A pass that failed, aborted, timed out or pushed nothing cannot be resumed.
  assert.match(server, /const resumable = workspaceRun\.ok && outcome === "waiting";\n\t+if \(!resumable\) await workspaceRun\.providerSession\?\.invalidate\?\.\(\);/)
  assert.match(server, /resumable,\n\t+release: baseAgent\.version,\n\t+outcome/)
  // Telemetry splits passes for the before/after comparison.
  assert.match(server, /resumed: workspaceRun\.providerSession\?\.resumed === true,/)
  assert.match(server, /workspace: workspaceRun\.reason === "warm" \? "warm" : "reset",\n\t+workspace_reason: workspaceRun\.reason,/)
})

test('a real provider run reads run.providerSession: it resumes a stored cursor, or drops it when fresh', async t => {
  const { existsSync } = await import('node:fs')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const agentModule = await import(pathToFileURL(join(dist, 'index.js')).href)
  // The provider runtime is ESM only; find the copy the agent bundle resolves.
  let modules = join(dist, '..')
  while (!existsSync(join(modules, 'node_modules', '@t3tools', 'provider-runtime', 'package.json'))) {
    assert.notEqual(modules, join(modules, '..'), 'provider runtime not found')
    modules = join(modules, '..')
  }
  const runtimeEntry = join(modules, 'node_modules', '@t3tools', 'provider-runtime', 'dist', 'index.mjs')
  const { createSqliteProviderRuntimeSessionStore } = await import(pathToFileURL(runtimeEntry).href)
  const directory = await mkdtemp(join(tmpdir(), 'babysitter-provider-session-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const sessionStorePath = join(directory, 'provider-sessions.sqlite')
  const threadId = 'github:o/r:pull-request:7'
  const key = JSON.stringify(['unknown', 'anonymous', 'anonymous:unknown', threadId])
  const store = await createSqliteProviderRuntimeSessionStore(sessionStorePath)
  // The launch resolver runs after the session store step and stops the run before Codex starts.
  const agent = agentModule.defineAgent({ name: 'probe', driver: { kind: 'codex', model: 'm', sessionStorePath, launch: () => { throw new Error('stop-before-codex') } } })
  const run = async (providerSession: { resume: boolean, resumed?: boolean, invalidate?: () => Promise<void> }) => {
    await assert.rejects(agentModule.runAgent(agent, { runtime: 'vite', run: { runId: `run-${providerSession.resume}`, threadId, providerSession }, memo: (_key: string, create: () => unknown) => create(), waitUntil: () => {} }, { messages: [agentModule.createMessage({ role: 'user', text: 'snapshot' })] }, { output: 'drained' }), /stop-before-codex/)
    return providerSession
  }
  await store.set(key, { __vitehubProviderSessionCursor: 'ready', value: { threadId: 'codex-1' } })
  const resumed = await run({ resume: true })
  assert.equal(resumed.resumed, true)
  assert.equal(typeof resumed.invalidate, 'function')
  await store.set(key, { __vitehubProviderSessionCursor: 'ready', value: { threadId: 'codex-1' } })
  const fresh = await run({ resume: false })
  assert.equal(fresh.resumed, false)
  assert.equal(await store.get(key), undefined)
  // The handle drops a cursor a later commit wrote.
  await store.set(key, { __vitehubProviderSessionCursor: 'ready', value: { threadId: 'codex-2' } })
  await fresh.invalidate!()
  assert.equal(await store.get(key), undefined)
})
