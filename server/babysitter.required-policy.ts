import type { Snapshot } from './babysitter.inbox.ts'

export type RequiredCheck = { context: string; appId: number | null }
export type RequiredPolicy = {
  repository: string; branch: string; status: 'known' | 'unknown'
  source: 'github-rest-rules-and-protection'; fetchedAt: string
  required: RequiredCheck[]; reason?: string
  classicSource?: 'protection-endpoint' | 'branch-summary' | 'unprotected-branch'
}
export type PolicyResponse = { status: number; data?: unknown }
export type ReadPolicy = (path: string) => Promise<PolicyResponse>
type RecordValue = Record<string, any>
const record = (value: unknown): RecordValue | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined
const appId = (value: unknown): number | null => {
  if (value === undefined || value === null || value === -1) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error('Invalid required-check integration ID')
  return value
}
function check(value: unknown, source: 'rule' | 'classic'): RequiredCheck {
  const item = record(value)
  if (!item || typeof item.context !== 'string' || !item.context.trim()) throw new Error('Incomplete required-check context')
  return { context: item.context, appId: appId(source === 'rule' ? item.integration_id : item.app_id) }
}
function rulesChecks(data: unknown): RequiredCheck[] {
  if (!Array.isArray(data)) throw new Error('Incomplete active branch rules response')
  return data.flatMap(value => {
    const rule = record(value)
    if (!rule || typeof rule.type !== 'string') throw new Error('Incomplete active branch rule')
    if (rule.type === 'workflows' || rule.type === 'required_workflows') throw new Error('Required workflow rules cannot be reduced to check contexts')
    if (rule.type !== 'required_status_checks') return []
    if (!Array.isArray(rule.parameters?.required_status_checks)) throw new Error('Incomplete ruleset required-check parameters')
    return rule.parameters.required_status_checks.map((item: unknown) => check(item, 'rule'))
  })
}
function classicChecks(data: unknown): RequiredCheck[] {
  const policy = record(data)
  if (!policy || !Array.isArray(policy.contexts) || policy.checks !== undefined && !Array.isArray(policy.checks)) throw new Error('Incomplete classic status-check protection')
  const bound: RequiredCheck[] = (policy.checks ?? []).map((item: unknown) => check(item, 'classic'))
  for (const context of policy.contexts) {
    if (typeof context !== 'string' || !context.trim()) throw new Error('Incomplete classic required-check context')
    // contexts repeats the check names but loses their app binding.
    if (!bound.some(item => item.context === context)) bound.push({ context, appId: null })
  }
  return bound
}

/** Cache authoritative policy, including explicit unknown results; never infer CI requirements from names. */
export function createRequiredPolicyReader(read: ReadPolicy, options: { clock?: () => number; ttlMs?: number; failureTtlMs?: number } = {}) {
  const clock = options.clock ?? Date.now
  const cache = new Map<string, { expires: number; value: RequiredPolicy }>()
  const active = new Map<string, Promise<RequiredPolicy>>()
  const request = async (path: string): Promise<PolicyResponse> => { try { return await read(path) } catch { return { status: 0 } } }
  async function fetch(repository: string, branch: string): Promise<RequiredPolicy> {
    const base: RequiredPolicy = { repository, branch, status: 'unknown', source: 'github-rest-rules-and-protection', fetchedAt: new Date(clock()).toISOString(), required: [] }
    const prefix = `repos/${repository}`, encodedBranch = encodeURIComponent(branch)
    const [rules, classic] = await Promise.all([
      request(`${prefix}/rules/branches/${encodedBranch}`),
      request(`${prefix}/branches/${encodedBranch}/protection/required_status_checks`),
    ])
    try {
      if (rules.status !== 200) throw new Error(`Active branch rules unavailable (HTTP ${rules.status})`)
      const required = rulesChecks(rules.data)
      let classicSource: RequiredPolicy['classicSource'] = 'protection-endpoint'
      if (classic.status === 200) required.push(...classicChecks(classic.data))
      else if (classic.status === 403 || classic.status === 404) {
        // Get-a-branch is documented with the complete required-status-check
        // summary (contexts + checks/app IDs) and only needs Contents:read.
        // This avoids demanding Administration:read from the worker App.
        const branchState = await request(`${prefix}/branches/${encodedBranch}`)
        const branch = record(branchState.data)
        if (branchState.status !== 200) throw new Error('Branch protection summary unavailable')
        if (branch?.protected === false) classicSource = 'unprotected-branch'
        else {
          const summary = record(branch?.protection?.required_status_checks)
          if (branch?.protected !== true || branch.protection?.enabled !== true || !summary
            || !Array.isArray(summary.contexts) || !Array.isArray(summary.checks)
            || !['everyone', 'non_admins', 'off'].includes(summary.enforcement_level)) throw new Error('Classic protection response is ambiguous; branch summary is incomplete')
          if (summary.enforcement_level === 'off' && (summary.contexts.length || summary.checks.length)) throw new Error('Disabled status-check summary contains ambiguous requirements')
          if (summary.contexts.some((context: unknown) => !summary.checks.some((item: RecordValue) => item?.context === context))) throw new Error('Branch summary omits required-check integration bindings')
          required.push(...classicChecks(summary))
          classicSource = 'branch-summary'
        }
      } else throw new Error(`Classic protection unavailable (HTTP ${classic.status})`)
      return { ...base, status: 'known', classicSource, required: [...new Map(required.map(item => [`${item.context}\0${item.appId ?? '*'}`, item])).values()] }
    } catch (error) { return { ...base, reason: error instanceof Error ? error.message : 'Required-check policy unavailable' } }
  }
  return async (repository: string, branch: string): Promise<RequiredPolicy> => {
    const key = `${repository.toLowerCase()}\0${branch}`
    const cached = cache.get(key)
    if (cached && cached.expires > clock()) return structuredClone(cached.value)
    let pending = active.get(key)
    if (!pending) {
      pending = fetch(repository, branch).then(value => {
        cache.set(key, { value, expires: clock() + (value.status === 'known' ? options.ttlMs ?? 300_000 : options.failureTtlMs ?? 120_000) })
        return value
      }).finally(() => active.delete(key))
      active.set(key, pending)
    }
    return structuredClone(await pending)
  }
}

type CheckState = 'pending' | 'failed' | 'passed' | 'unknown'
const stamp = (value: RecordValue) => Date.parse(value.started_at ?? value.created_at ?? value.updated_at ?? '') || 0
const stateOfCheck = (value: RecordValue): CheckState => {
  if (['queued', 'in_progress', 'pending', 'waiting', 'requested'].includes(String(value.status).toLowerCase())) return 'pending'
  if (String(value.status).toLowerCase() !== 'completed') return 'unknown'
  if (['success', 'neutral', 'skipped'].includes(String(value.conclusion).toLowerCase())) return 'passed'
  return ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(String(value.conclusion).toLowerCase()) ? 'failed' : 'unknown'
}

/** Startup scheduling context only. Cached policy/snapshots never authorize a merge. */
export function classifyRequiredChecks(snapshot: Snapshot, policy: RequiredPolicy): { state: CheckState; checks: Array<RequiredCheck & { state: CheckState }>; missing: string[] } {
  if (policy.status !== 'known' || policy.repository.toLowerCase() !== snapshot.repository.toLowerCase() || policy.branch !== snapshot.pr?.base?.ref || !snapshot.pr?.head?.sha) return { state: 'unknown', checks: [], missing: [] }
  const head = snapshot.pr.head.sha
  const missing: string[] = []
  const checks = policy.required.map(required => {
    const runs = Object.values(snapshot.checks).filter(value => !value.deleted && value.head_sha === head && value.name === required.context && (required.appId === null || value.app?.id === required.appId))
      .sort((a, b) => stamp(b) - stamp(a) || Number(b.id ?? 0) - Number(a.id ?? 0))
    const status = Object.values(snapshot.statuses).filter(value => !value.deleted && value.sha === head && value.context === required.context && required.appId === null)
      .sort((a, b) => stamp(b) - stamp(a) || Number(b.id ?? 0) - Number(a.id ?? 0))[0]
    const states: CheckState[] = []
    if (runs[0]) states.push(stateOfCheck(runs[0]))
    // A check and commit status with the same context both have to pass.
    if (status) states.push(status.state === 'pending' ? 'pending' : status.state === 'success' ? 'passed' : ['failure', 'error'].includes(status.state) ? 'failed' : 'unknown')
    if (!states.length) missing.push(required.context)
    return { ...required, state: states.length ? combine(states) : 'pending' as CheckState }
  })
  return { state: policy.required.length ? combine(checks.map(item => item.state)) : 'passed', checks, missing }
}
function combine(states: CheckState[]): CheckState {
  if (states.includes('failed')) return 'failed'
  if (!states.length || states.includes('unknown')) return 'unknown'
  return states.includes('pending') ? 'pending' : 'passed'
}
