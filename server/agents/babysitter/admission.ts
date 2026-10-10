import { readFile } from 'node:fs/promises'

const nonnegative = (value: string | undefined, fallback: number, integer = false) => {
  const parsed = value === undefined || value === '' ? Number.NaN : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && (!integer || Number.isSafeInteger(parsed)) ? parsed : fallback
}

// Service policy belongs in this application, expressed through the preset's public options.
export function applicationAdmission(env: NodeJS.ProcessEnv = process.env) {
  const provider = env.BABYSITTER_PROXY_PROVIDER || 'codex'
  const statusFile = env.BABYSITTER_PROXY_STATUS_FILE || '/srv/cliproxy-status/accounts.json'
  const maxWeeklyPercent = nonnegative(env.BABYSITTER_PROXY_MAX_WEEKLY_PERCENT, 80)
  const maxAgeMs = nonnegative(env.BABYSITTER_PROXY_STATUS_MAX_AGE_S, 900) * 1000
  return {
    inputTokens: {
      hourly: nonnegative(env.BABYSITTER_HOURLY_INPUT_TOKENS, 15e6, true),
      daily: nonnegative(env.BABYSITTER_DAILY_INPUT_TOKENS, 200e6, true),
    },
    minFreeTmpMb: nonnegative(env.BABYSITTER_MIN_FREE_TMP_MB, 4096),
    paused: env.BABYSITTER_PAUSED === '1',
    async check() {
      let status: unknown
      try { status = JSON.parse(await readFile(statusFile, 'utf8')) }
      catch { return undefined }
      return providerQuotaPause(status, { provider, maxWeeklyPercent, maxAgeMs }, Date.now())
    },
  }
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Read only quota counters from the sanitized service status file. */
export function providerQuotaPause(status: unknown, policy: { provider: string; maxWeeklyPercent: number; maxAgeMs: number }, now: number) {
  if (!record(status) || !Array.isArray(status.accounts) || typeof status.observedAt !== 'string') return
  const observedAt = Date.parse(status.observedAt)
  if (!Number.isFinite(observedAt) || observedAt > now || now - observedAt > policy.maxAgeMs) return
  const accounts = status.accounts.filter(record).filter(account => account.provider === policy.provider && account.disabled !== true)
  if (!accounts.length) return
  const exhausted = (account: Record<string, unknown>) => account.available !== true || account.limitReached === true
  if (accounts.every(exhausted)) return { reason: 'proxy-exhausted', detail: `No usable ${policy.provider} account of ${accounts.length}` }
  const measured = accounts.filter(account => exhausted(account) || typeof account.weeklyUsedPercent === 'number' && Number.isFinite(account.weeklyUsedPercent))
  if (!measured.length) return
  const weeklyUsedPercent = Math.round(measured.reduce((sum, account) => sum + (exhausted(account) ? 100 : Number(account.weeklyUsedPercent)), 0) / measured.length)
  if (weeklyUsedPercent >= policy.maxWeeklyPercent) return { reason: 'proxy-weekly-limit', detail: `${policy.provider} accounts at ${weeklyUsedPercent}% of their weekly limit; admission stops at ${policy.maxWeeklyPercent}%` }
}
