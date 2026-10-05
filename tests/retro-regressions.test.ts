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

test('new events during a pass do not abort PR tool calls', () => {
  assert.doesNotMatch(chunk('function diagnosticExcerpt(').source, /Pull request evidence changed/)
})

// 2026-10-05: three full-clone passes filled the shared /tmp, and unbudgeted passes
// exhausted the proxy accounts that interactive sessions share.
const admissionChunk = chunk('function babysitterAdmissionDecision(')
const admissionFunction = (name: string, ...scope: string[]) => {
  const source = admissionChunk.source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}\\n`))?.[0]
  assert.ok(source, `no ${name} in ${admissionChunk.name}`)
  return (...values: unknown[]) => new Function(...scope, `${source}return ${name}`)(...values)
}
const isRecord = (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value)
const readLimits = admissionFunction('readBabysitterAdmissionLimits')()
const budgetWindows = admissionFunction('babysitterBudgetWindows')()
const summarizeProxy = admissionFunction('summarizeProxyAccounts', 'isRuntimeRecord')(isRecord)
const decide = admissionFunction('babysitterAdmissionDecision')()
const now = new Date(2026, 9, 5, 19, 13).getTime()
const roomy = (overrides: Record<string, unknown> = {}) => ({ windows: budgetWindows(now), tmpDir: '/scratch', freeTmpBytes: 64 * 2 ** 30, hourlyInputTokens: 0, dailyInputTokens: 0, proxy: { state: 'unknown' }, ...overrides })

test('admission limits come from the environment with safe defaults', () => {
  const defaults = readLimits({})
  assert.equal(defaults.minFreeTmpBytes, 4096 * 2 ** 20)
  assert.equal(defaults.hourlyInputTokens, 15e6)
  assert.equal(defaults.dailyInputTokens, 200e6)
  assert.equal(defaults.proxyMaxWeeklyPercent, 80)
  assert.equal(defaults.proxyProvider, 'codex')
  const forced = readLimits({ BABYSITTER_HOURLY_INPUT_TOKENS: '0', BABYSITTER_DAILY_INPUT_TOKENS: 'lots', BABYSITTER_MIN_FREE_TMP_MB: '512' }, 'claude')
  assert.equal(forced.hourlyInputTokens, 0)
  assert.equal(forced.dailyInputTokens, 200e6)
  assert.equal(forced.minFreeTmpBytes, 512 * 2 ** 20)
  assert.equal(forced.proxyProvider, 'claude')
})

test('a pass is skipped while the temporary directory is low on space', () => {
  const limits = readLimits({})
  assert.deepEqual(decide(roomy(), limits), { accepting: true })
  const low = decide(roomy({ freeTmpBytes: 3 * 2 ** 30 }), limits)
  assert.equal(low.accepting, false)
  assert.equal(low.reason, 'tmp-space-low')
  assert.match(low.detail, /3072 MiB free in \/scratch/)
})

test('a spent token budget pauses admission until the next window', () => {
  const limits = readLimits({ BABYSITTER_HOURLY_INPUT_TOKENS: '1' })
  const windows = budgetWindows(now)
  assert.equal(windows.hourEnd, new Date(2026, 9, 5, 20).getTime())
  assert.equal(windows.dayEnd, new Date(2026, 9, 6).getTime())
  const hourly = decide(roomy({ hourlyInputTokens: 1 }), limits)
  assert.deepEqual([hourly.accepting, hourly.reason, hourly.retryAt], [false, 'token-budget-hourly', windows.hourEnd])
  assert.equal(decide(roomy({ windows: budgetWindows(windows.hourEnd), hourlyInputTokens: 0 }), limits).accepting, true)
  const daily = decide(roomy({ dailyInputTokens: 200e6 }), readLimits({}))
  assert.deepEqual([daily.accepting, daily.reason, daily.retryAt], [false, 'token-budget-daily', windows.dayEnd])
})

test('exhausted or mostly used proxy accounts pause admission; stale status does not', () => {
  const limits = readLimits({})
  const status = (accounts: unknown[], observedAt = new Date(now).toISOString()) => summarizeProxy({ observedAt, accounts }, 'codex', now, limits.proxyStatusMaxAgeMs)
  const account = (weeklyUsedPercent: number | undefined, extra = {}) => ({ provider: 'codex', available: true, limitReached: false, weeklyUsedPercent, ...extra })
  const incident = status([account(100, { limitReached: true }), account(100, { limitReached: true }), account(21), account(undefined), { provider: 'claude', available: false }])
  assert.deepEqual([incident.accounts, incident.usable, incident.weeklyUsedPercent], [4, 2, 74])
  assert.equal(decide(roomy({ proxy: incident }), limits).accepting, true)
  const weekly = decide(roomy({ proxy: status([account(100, { limitReached: true }), account(85), account(60)]) }), limits)
  assert.deepEqual([weekly.accepting, weekly.reason], [false, 'proxy-weekly-limit'])
  const exhausted = decide(roomy({ proxy: status([account(10, { available: false }), account(100, { limitReached: true })]) }), limits)
  assert.deepEqual([exhausted.accepting, exhausted.reason], [false, 'proxy-exhausted'])
  const stale = status([account(100, { limitReached: true })], new Date(now - 3_600_000).toISOString())
  assert.equal(stale.state, 'stale')
  assert.equal(decide(roomy({ proxy: stale }), limits).accepting, true)
})

test('token usage counts each invocation once at its cumulative maximum and refreshes incrementally', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const directory = mkdtempSync(join(tmpdir(), 'babysitter-admission-'))
  try {
    const file = join(directory, 'invocations.sqlite')
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE vitehub_agent_invocations (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, updated_at TEXT NOT NULL, record TEXT NOT NULL)')
    const insert = db.prepare('INSERT INTO vitehub_agent_invocations (id, status, updated_at, record) VALUES (?, ?, ?, ?)')
    const record = (...tokens: number[]) => JSON.stringify({ observations: [{ attributes: {} }, ...tokens.map(value => ({ attributes: { 'usage.inputTokens': value, 'usage.provider': 'codex' } }))] })
    insert.run('old', 'completed', '2026-10-05T16:59:00.000Z', record(900_000))
    insert.run('a', 'completed', '2026-10-05T17:10:00.000Z', record(27_241, 55_163, 85_835))
    insert.run('b', 'running', '2026-10-05T17:20:00.000Z', record(40_000))
    insert.run('c', 'completed', '2026-10-05T17:21:00.000Z', record())
    db.close()
    const read = admissionFunction('readInvocationInputTokens')()
    const sum = admissionFunction('sumInvocationInputTokens')()
    const usage = new Map((await read(file, Date.parse('2026-10-05T00:00:00.000Z'))).map((entry: { id: string }) => [entry.id, entry]))
    assert.equal(sum(usage, Date.parse('2026-10-05T17:00:00.000Z')), 125_835)
    assert.equal(sum(usage, Date.parse('2026-10-05T00:00:00.000Z')), 1_025_835)
    // A refresh reads only recently updated rows and replaces the running pass's total.
    const writer = new DatabaseSync(file)
    writer.prepare('UPDATE vitehub_agent_invocations SET updated_at = ?, record = ? WHERE id = ?').run('2026-10-05T17:40:00.000Z', record(40_000, 70_000), 'b')
    writer.close()
    const fresh = await read(file, Date.parse('2026-10-05T17:30:00.000Z'))
    assert.deepEqual(fresh.map((entry: { id: string }) => entry.id), ['b'])
    for (const entry of fresh) usage.set(entry.id, entry)
    assert.equal(sum(usage, Date.parse('2026-10-05T17:00:00.000Z')), 155_835)
  }
  finally {
    rmSync(directory, { force: true, recursive: true })
  }
})

test('the scheduler checks admission before claiming and records the skip', () => {
  const host = chunk('function createBabysitterProcessHost(')
  const reconcile = host.source.match(/async function reconcile\([\s\S]*?const jobs = modelAdmission \? await pullRequestInbox\.claim\(/)?.[0]
  assert.ok(reconcile)
  // A paused admission stops model passes; host-only claims still merge and wait.
  assert.match(reconcile, /const admission = await options\.admission\(\);\s*if \(!admission\.accepting\) \{\s*modelAdmission = false;/)
  assert.match(reconcile, /schedulerEvent\("babysitter\.admission\.skipped"/)
  assert.match(reconcile, /setMeta\("admission-skipped"/)
  assert.match(host.source, /admission: \{\s*accepting: !quotaBlocked && guard\.accepting,/)
  assert.match(host.source, /budget: \{\s*hourly: \{/)
  // The 20:00 rollback: a full-day synchronous scan per refresh stalled health, and a busy
  // store blanked the budget.
  const check = host.source.match(/function createBabysitterAdmission\([\s\S]*?\n}\n/)?.[0]
  assert.ok(check)
  assert.match(check, /cursor === void 0 \? windows\.dayStart : Math\.max\(windows\.dayStart, cursor - 6e4\)/)
  assert.doesNotMatch(check, /usage = void 0/)
  assert.match(host.source, /new Worker\(`[\s\S]*?readOnly: true, timeout: 500/)
})
