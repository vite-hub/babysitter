import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applicationAdmission, providerQuotaPause } from '../server/agents/babysitter/admission.ts'

const now = Date.now()
const policy = { provider: 'codex', maxWeeklyPercent: 80, maxAgeMs: 900000 }
const fresh = (accounts: unknown[]) => ({ observedAt: new Date(now).toISOString(), accounts })

test('maps configured service safeguards and keeps zero hourly smoke admission', () => {
  const defaults = applicationAdmission({})
  assert.deepEqual(defaults.inputTokens, { hourly: 15e6, daily: 200e6 })
  assert.equal(defaults.minFreeTmpMb, 4096)
  assert.equal(defaults.paused, false)
  const live = applicationAdmission({ BABYSITTER_HOURLY_INPUT_TOKENS: '1000000000', BABYSITTER_DAILY_INPUT_TOKENS: '2000000000', BABYSITTER_MIN_FREE_TMP_MB: '8192', BABYSITTER_PAUSED: '1' })
  assert.deepEqual(live.inputTokens, { hourly: 1e9, daily: 2e9 })
  assert.equal(live.minFreeTmpMb, 8192)
  assert.equal(live.paused, true)
  assert.equal(applicationAdmission({ BABYSITTER_HOURLY_INPUT_TOKENS: '0', BABYSITTER_SMOKE_ONLY: '1' }).inputTokens.hourly, 0)
  assert.equal(applicationAdmission({ BABYSITTER_HOURLY_INPUT_TOKENS: '-1', BABYSITTER_DAILY_INPUT_TOKENS: '0.5', BABYSITTER_MIN_FREE_TMP_MB: 'NaN' }).inputTokens.daily, 200e6)
})

test('pauses exhausted accounts and the measured weekly threshold', () => {
  assert.equal(providerQuotaPause(fresh([{ provider: 'codex', available: false }]), policy, now)?.reason, 'proxy-exhausted')
  assert.equal(providerQuotaPause(fresh([{ provider: 'codex', available: true, limitReached: true }]), policy, now)?.reason, 'proxy-exhausted')
  assert.equal(providerQuotaPause(fresh([{ provider: 'codex', available: true, weeklyUsedPercent: 80 }]), policy, now)?.reason, 'proxy-weekly-limit')
  assert.equal(providerQuotaPause(fresh([{ provider: 'codex', available: false }, { provider: 'codex', available: true, weeklyUsedPercent: 60 }]), policy, now)?.reason, 'proxy-weekly-limit')
  assert.equal(providerQuotaPause(fresh([{ provider: 'codex', available: true, weeklyUsedPercent: 66 }]), policy, now), undefined)
})

test('ignores disabled, foreign, missing and stale measurements', () => {
  for (const status of [undefined, {}, { observedAt: 'invalid', accounts: [] }, { observedAt: new Date(now - 900001).toISOString(), accounts: [{ provider: 'codex', available: false }] }, { observedAt: new Date(now + 1).toISOString(), accounts: [{ provider: 'codex', available: false }] }, fresh([{ provider: 'codex', available: false, disabled: true }, { provider: 'other', available: false }]), fresh([{ provider: 'codex', available: true }])]) assert.equal(providerQuotaPause(status, policy, now), undefined)
})

test('custom check reads the configured sanitized status and fails open for absent or malformed data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babysitter-admission-'))
  const file = join(root, 'quota.json')
  const admission = applicationAdmission({ BABYSITTER_PROXY_STATUS_FILE: file, BABYSITTER_PROXY_MAX_WEEKLY_PERCENT: '70' })
  try {
    assert.equal(await admission.check(), undefined)
    await writeFile(file, 'invalid json')
    assert.equal(await admission.check(), undefined)
    await writeFile(file, JSON.stringify(fresh([{ provider: 'codex', available: true, weeklyUsedPercent: 75, credential: 'never-include-this' }])))
    const pause = await admission.check()
    assert.equal(pause?.reason, 'proxy-weekly-limit')
    assert.equal(JSON.stringify(pause).includes('never-include-this'), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
