import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CheckWait } from './babysitter.wait-state.ts'

// Payloads are retained verbatim in deliveries; projections are deliberately
// permissive because GitHub evolves these schemas independently of this PoC.
export type Json = Record<string, any>
export type Snapshot = {
  waitForChecks?: CheckWait
  requiredCheckEvidence?: Json
  repository: string; number: number; pr: Json | null
  generation: number; handled: number; dirtyAt: number; nextAt: number; revision?: number
  nextDirtyAt?: number
  status: 'ready' | 'working' | 'waiting' | 'attention' | 'terminal'
  lease: string | null; leaseUntil: number; attempts: number; noOpHead?: string; noOpAttempts?: number
  cancellationStreak?: number; cancellationUntil?: number
  hydrated: boolean; refresh: boolean; feedbackRefresh: boolean
  comments: Record<string, Json>; reviews: Record<string, Json>
  reviewComments: Record<string, Json>; checks: Record<string, Json>; statuses: Record<string, Json>
  threads: Json[]; threadsHydrated?: boolean; reasons: string[]; lastResult?: string
  ciEvidence?: Json[]
}
export type Claim = { token: string; generation: number; snapshot: Snapshot }
type SnapshotSummary = Pick<Snapshot, 'repository' | 'number' | 'generation' | 'handled' | 'status' | 'reasons' | 'attempts' | 'nextAt' | 'lastResult'> & {
  head?: string; baseRef?: string; headRef?: string; state?: string; dirty: boolean
  cancellationStreak: number; cancellationUntil: number
}
type QueueRow = Omit<SnapshotSummary, 'dirty'> & Pick<Snapshot, 'dirtyAt' | 'lease' | 'leaseUntil' | 'noOpHead'> & {
  noOpAttempts: number; hasPr?: number; author?: string; waitHead?: string
}
const ownBots = new Set(['vitehub-bot', 'vitehub-bot[bot]', 'pkg-pr-new[bot]', 'chatgpt-codex-connector[bot]'])
const reviewBots = /pullfrog|codex|coderabbit|copilot|greptile|cursor|claude|gemini|qodo|sourcery/i
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const stamp = (value: Json) => Date.parse(value.updated_at ?? value.updatedAt ?? value.submitted_at ?? value.completed_at ?? value.started_at ?? value.created_at ?? '') || 0
const queueFields = {
  head: '$.pr.head.sha', baseRef: '$.pr.base.ref', headRef: '$.pr.head.ref', state: '$.pr.state',
  generation: '$.generation', handled: '$.handled', status: '$.status', reasons: '$.reasons',
  attempts: '$.attempts', nextAt: '$.nextAt', cancellationStreak: '$.cancellationStreak',
  cancellationUntil: '$.cancellationUntil', lastResult: '$.lastResult', dirtyAt: '$.dirtyAt',
  lease: '$.lease', leaseUntil: '$.leaseUntil', noOpAttempts: '$.noOpAttempts',
  noOpHead: '$.noOpHead', hasPr: '$.pr.number', author: '$.pr.user.login',
  waitHead: '$.waitForChecks.headSha',
}
// REST webhooks and ViteHub's discovery response use different field names.
// Persist one shape so authored PRs and head-matched checks can be claimed.
export const normalizePullRequest = (pr: Json): Json => ({
  ...pr,
  state: String(pr.state ?? 'open').toLowerCase() === 'merged' ? 'closed' : String(pr.state ?? 'open').toLowerCase(),
  user: pr.user ?? pr.author,
  head: pr.head ?? { sha: pr.headRefOid, ref: pr.headRefName },
  base: pr.base ?? { sha: pr.baseRefOid, ref: pr.baseRefName },
  draft: pr.draft ?? pr.isDraft,
  updated_at: pr.updated_at ?? pr.updatedAt,
  created_at: pr.created_at ?? pr.createdAt,
})
export const isFeedback = (item: Json | undefined) => Boolean(item && !ownBots.has(item.user?.login)
  && !String(item.body ?? '').includes('<!-- vitehub-agent-activity:')
  // Codex publishes a mutable issue-comment summary in addition to its
  // review objects. The review webhook is the actionable evidence; this
  // status projection must not wake the repair agent on every edit.
  && !String(item.body ?? '').includes('<!-- codex-pull-request-review-summary -->')
  && !/^\s*(?:You have reached your Codex usage limits for code reviews\.|Codex usage limits have been reached for code reviews\.)/i.test(String(item.body ?? ''))
  && (item.user?.type !== 'Bot' || reviewBots.test(item.user?.login ?? '')))


export class PullRequestInbox {
  private db: DatabaseSync
  private queueMetadata?: QueueRow[]
  constructor(path: string, private repositories: string[], private clock: () => number = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS pr_snapshots (repository TEXT, number INTEGER, value TEXT NOT NULL, PRIMARY KEY(repository,number));
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, event TEXT, received INTEGER, payload TEXT, result TEXT);
      CREATE TABLE IF NOT EXISTS inbox_meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE INDEX IF NOT EXISTS pr_snapshots_open_head ON pr_snapshots(repository,json_extract(value,'$.pr.head.sha')) WHERE json_extract(value,'$.pr.state')='open';
      CREATE INDEX IF NOT EXISTS pr_snapshots_open_base ON pr_snapshots(repository,json_extract(value,'$.pr.base.ref')) WHERE json_extract(value,'$.pr.state')='open';`)
  }
  close() { this.db.close() }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = run(); this.db.exec('COMMIT'); return result }
    catch (error) { this.queueMetadata = undefined; this.db.exec('ROLLBACK'); throw error }
  }
  get(repository: string, number: number): Snapshot | undefined {
    const row = this.db.prepare('SELECT value FROM pr_snapshots WHERE repository=? AND number=?').get(repository, number)
    return row ? JSON.parse(row.value as string) : undefined
  }
  all(): Snapshot[] {
    if (!this.repositories.length) return []
    return this.db.prepare(`SELECT value FROM pr_snapshots WHERE repository IN (${this.repositories.map(() => '?').join(',')})`)
      .all(...this.repositories).map(row => JSON.parse(row.value as string))
  }
  private put(s: Snapshot) {
    this.queueMetadata = undefined
    this.db.prepare('INSERT OR REPLACE INTO pr_snapshots VALUES (?,?,?)').run(s.repository, s.number, JSON.stringify(s))
  }
  private empty(repository: string, number: number): Snapshot {
    return { repository, number, pr: null, generation: 0, handled: 0, dirtyAt: this.clock(), nextAt: 0,
      status: 'ready', lease: null, leaseUntil: 0, attempts: 0, hydrated: false, refresh: true, feedbackRefresh: true,
      comments: {}, reviews: {}, reviewComments: {}, checks: {}, statuses: {}, threads: [], reasons: [] }
  }
  meta<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM inbox_meta WHERE key=?').get(key)
    return row ? JSON.parse(row.value as string) : undefined
  }
  setMeta(key: string, value: unknown) { this.db.prepare('INSERT OR REPLACE INTO inbox_meta VALUES (?,?)').run(key, JSON.stringify(value)) }
  private dirty(s: Snapshot, reason: string) {
    if (s.generation === s.handled) s.dirtyAt = this.clock()
    if (s.lease && s.nextDirtyAt === undefined) s.nextDirtyAt = this.clock()
    s.generation++; s.nextAt = 0; s.attempts = 0
    // Bound retries for unchanged evidence, not every future task on this
    // commit. Semantic changes can need repair without changing the PR head.
    s.noOpHead = undefined; s.noOpAttempts = 0
    s.revision = (s.revision ?? 0) + 1
    if (!s.lease) s.status = 'ready'
    s.reasons = [...new Set([...s.reasons, reason])]
  }
  private updatePr(s: Snapshot, pr: Json) {
    pr = normalizePullRequest(pr)
    if (s.pr && stamp(pr) < stamp(s.pr)) return false
    const previous = s.pr
    const changed = !previous || ['state','draft','title','body','mergeable','mergeable_state'].some(k => pr[k] !== undefined && pr[k] !== previous[k])
      || pr.head?.sha !== previous.head?.sha || pr.base?.sha !== previous.base?.sha || pr.base?.ref !== previous.base?.ref
    // Retain freshness even when only timestamps changed, so a delayed
    // delivery cannot subsequently regress the current head or closed state.
    if (!changed) { s.pr = { ...previous, ...pr }; return false }
    const newHead = previous?.head?.sha !== pr.head?.sha
    s.pr = { ...previous, ...pr }
    if (newHead) {
      s.checks = Object.fromEntries(Object.entries(s.checks).filter(([, check]) => check.head_sha === pr.head?.sha))
      s.statuses = Object.fromEntries(Object.entries(s.statuses).filter(([, status]) => status.sha === pr.head?.sha))
      s.hydrated = false; s.feedbackRefresh = true
    }
    s.refresh = false
    if (pr.state === 'closed') s.status = 'terminal'
    else if (s.status === 'terminal') s.status = s.lease ? 'working' : 'ready'
    return true
  }
  seed(repository: string, pr: Json) {
    return this.transaction(() => {
      const s = this.get(repository, pr.number) ?? this.empty(repository, pr.number)
      if (this.updatePr(s, pr)) this.dirty(s, 'bootstrap')
      const author = s.pr?.user?.login
      if (s.pr?.state === 'closed' || author !== 'onmax') {
        s.status = 'terminal'; s.handled = s.generation
        s.cancellationStreak = 0; s.cancellationUntil = 0
      }
      else if (s.status === 'terminal') {
        s.status = 'ready'
        if (s.generation <= s.handled) this.dirty(s, 'bootstrap-recovery')
      }
      this.put(s); return s
    })
  }
  ingest(id: string, event: string, payload: Json) {
    return this.transaction(() => {
      if (this.db.prepare('SELECT id FROM deliveries WHERE id=?').get(id)) return { accepted: true, duplicate: true, queued: [] as number[], updated: [] as number[] }
      const repository = String(payload.repository?.full_name ?? '').toLowerCase()
      const queued: number[] = []
      const updated: number[] = []
      const finish = (reason?: string) => {
        const result = { accepted: true, queued, updated, ...(reason ? { ignored: true, reason } : {}) }
        this.db.prepare('INSERT INTO deliveries VALUES (?,?,?,?,?)').run(id, event, this.clock(), JSON.stringify(payload), JSON.stringify(result))
        return result
      }
      if (!this.repositories.includes(repository)) return finish('repository not configured')
      // Activity suppression applies to issue comments only. Actual reviews
      // and inline review comments are evidence regardless of reviewer name.
      if (event === 'issue_comment' && !isFeedback(payload.comment)) return finish('irrelevant comment')
      if (event === 'issue_comment' && !payload.issue?.pull_request) return finish('issue is not a PR')
      const supported = ['pull_request','issue_comment','pull_request_review','pull_request_review_comment','pull_request_review_thread','check_run','check_suite','workflow_run','status','push']
      if (!supported.includes(event)) return finish('irrelevant event')
      if (event === 'pull_request' && !['opened','synchronize','reopened','closed','edited','ready_for_review','converted_to_draft'].includes(payload.action)) return finish('irrelevant PR action')
      if (event === 'pull_request_review_thread' && (!['resolved', 'unresolved'].includes(payload.action) || !payload.thread?.node_id)) return finish('irrelevant review thread action')
      const check = payload.check_run ?? payload.check_suite ?? payload.workflow_run
      const sha = check?.head_sha ?? payload.sha
      const numbers = new Set<number>()
      const direct = payload.pull_request?.number ?? (payload.issue?.pull_request ? payload.issue.number : undefined)
      if (direct) numbers.add(direct)
      for (const pr of check?.pull_requests ?? []) if (pr.number) numbers.add(pr.number)
      if (sha) for (const row of this.db.prepare("SELECT number FROM pr_snapshots WHERE repository=? AND json_extract(value,'$.pr.state')='open' AND json_extract(value,'$.pr.head.sha')=?").all(repository, sha)) numbers.add(Number(row.number))
      if (event === 'push' && String(payload.ref).startsWith('refs/heads/')) {
        const branch = String(payload.ref).slice('refs/heads/'.length)
        for (const row of this.db.prepare("SELECT number FROM pr_snapshots WHERE repository=? AND json_extract(value,'$.pr.state')='open' AND json_extract(value,'$.pr.base.ref')=?").all(repository, branch)) numbers.add(Number(row.number))
      }
      for (const number of numbers) {
        const s = this.get(repository, number) ?? this.empty(repository, number)
        if (payload.pull_request?.user?.login && payload.pull_request.user.login !== 'onmax') continue
        if (s.pr && (s.pr.user?.login ?? s.pr.author?.login) !== 'onmax') continue
        if (sha && s.pr?.head?.sha && s.pr.head.sha !== sha) continue // old-head CI cannot wake current head
        let changed = false
        if (event === 'pull_request') changed = this.updatePr(s, payload.pull_request)
        if (!s.pr && payload.pull_request) changed = this.updatePr(s, payload.pull_request) || changed
        const upsert = (map: Record<string, Json>, value: Json | undefined, itemKey?: string) => {
          if (!value) return
          const key = itemKey ?? String(value.id)
          const old = map[key]
          if (old && stamp(value) < stamp(old)) return
          // Timestamp-only activity does not become another repair task.
          const semantic = (v: Json) => Object.fromEntries(Object.entries(v).filter(([k]) => !['updated_at','url','html_url'].includes(k)))
          const next = payload.action === 'deleted' ? { id: value.id, deleted: true, updated_at: value.updated_at } : value
          if (old && digest(semantic(old)) === digest(semantic(next))) { map[key] = next; return }
          map[key] = next
          changed = true
        }
        if (event === 'issue_comment') upsert(s.comments, payload.comment)
        if (event === 'pull_request_review_comment') { upsert(s.reviewComments, payload.comment); if (changed) s.feedbackRefresh = true }
        if (event === 'pull_request_review') { upsert(s.reviews, payload.review); if (changed) s.feedbackRefresh = true }
        if (event === 'pull_request_review_thread') {
          const id = String(payload.thread.node_id)
          const position = s.threads.findIndex(thread => String(thread.node_id ?? thread.id) === id)
          const previous = position < 0 ? undefined : s.threads[position]
          const incomingComments: Json[] = Array.isArray(payload.thread.comments) ? payload.thread.comments : []
          const previousComments: Json[] = Array.isArray(previous?.comments) ? previous.comments : previous?.comments?.nodes ?? []
          const comments = new Map(previousComments.map(comment => [String(comment.node_id ?? comment.id), comment]))
          for (const comment of incomingComments) {
            const key = String(comment.node_id ?? comment.id)
            const old = comments.get(key)
            if (!old || stamp(comment) >= stamp(old)) comments.set(key, comment)
            upsert(s.reviewComments, comment)
          }
          const isResolved = payload.action === 'resolved'
          if (!previous || previous.isResolved !== isResolved || digest(previousComments) !== digest([...comments.values()])) {
            const thread = { ...previous, id, node_id: id, isResolved,
              resolutionSource: 'webhook', resolutionObservedAt: new Date(this.clock()).toISOString(), comments: [...comments.values()] }
            if (position < 0) s.threads.push(thread)
            else s.threads[position] = thread
            changed = true
            // GitHub's thread payload has no ordering timestamp. A delayed
            // opposite transition can arrive last, so verify resolution with
            // one targeted thread read when this generation is claimed.
            s.feedbackRefresh = true
          }
          // REST review comments do not carry thread resolution. Only this
          // explicit event (or a targeted thread query) supplies that evidence.
          // Comments with no matching thread stay resolution-unknown.
        }
        if (check) upsert(s.checks, check, `${event}:${check.id}`)
        if (event === 'status') upsert(s.statuses, payload, payload.context)
        if (event === 'push') { s.refresh = true; s.feedbackRefresh = true; changed = true }
        // Pending CI is evidence to retain, not another repair task. Terminal
        // results still wake the PR; revision invalidates in-flight hydration
        // even when this update does not need a new agent generation.
        const pendingCi = check && check.status !== 'completed' && !check.conclusion
          && ['queued', 'in_progress', 'pending', 'waiting', 'requested', 'rerequested', 'created'].includes(check.status ?? payload.action)
          || event === 'status' && payload.state === 'pending'
        // A successful optional check is only evidence while the required CI
        // set is still running. Do not turn every matrix/check transition
        // into an agent session; a failure remains actionable immediately.
        const currentHead = s.pr?.head?.sha
        const anotherCurrentCheckPending = currentHead && Object.values(s.checks).some(item => item !== check
          && !item.deleted && item.head_sha === currentHead
          && item.status !== 'completed' && !item.conclusion)
        // Do not launch on the first completed check, including the first
        // failure. Collect the complete current-head check set and wake once
        // the remaining checks are terminal so one pass can repair all
        // failures together.
        const aggregateCheckEvent = event === 'check_suite' || event === 'workflow_run'
        const terminalCheckWhileSetPending = check && (check.status === 'completed' || aggregateCheckEvent)
          && anotherCurrentCheckPending
        const wake = (changed || !s.pr) && !pendingCi && !terminalCheckWhileSetPending
        if (wake) this.dirty(s, `${event}:${payload.action ?? check?.conclusion ?? payload.state ?? 'updated'}`)
        else if (changed) s.revision = (s.revision ?? 0) + 1
        if (s.pr?.state === 'closed') {
          s.status = 'terminal'; s.handled = s.generation
          s.cancellationStreak = 0; s.cancellationUntil = 0
        }
        this.put(s)
        if (changed || !s.pr) updated.push(number)
        if (wake && s.status !== 'terminal') queued.push(number)
      }
      return finish(numbers.size ? undefined : 'no matching PR head')
    })
  }
  claim(limit: number): Claim[] {
    return this.transaction(() => {
      const now = this.clock(), all = this.queueRows(), claims: Claim[] = []
      // A PR woken on the head it parked on after a repair usually needs only
      // verification and a merge. Serve it before older, untouched work.
      const resumed = (item: QueueRow) => item.waitHead !== undefined && item.waitHead === item.head ? 0 : 1
      for (const item of all.toSorted((a,b) => resumed(a) - resumed(b) || a.dirtyAt - b.dirtyAt || a.number - b.number)) {
        if (claims.length >= limit) break
        if (item.lease && item.leaseUntil > now || item.status === 'terminal' || item.generation <= item.handled || item.nextAt > now || item.cancellationUntil > now || item.noOpAttempts >= 3 && item.noOpHead === item.head) continue
        if (item.hasPr && item.author !== 'onmax') continue
        // Stack children remain local; a parent merge's base push wakes them.
        if (item.baseRef && all.some(parent => parent.repository === item.repository && parent.number !== item.number && String(parent.state).toLowerCase() === 'open' && parent.headRef === item.baseRef)) continue
        const s = this.get(item.repository, item.number)!
        s.nextDirtyAt = undefined
        s.lease = randomUUID(); s.leaseUntil = now + 2 * 60 * 60_000; s.status = 'working'
        this.put(s); claims.push({ token: s.lease, generation: s.generation, snapshot: structuredClone(s) })
      }
      return claims
    })
  }
  hydrate(claim: Claim, patch: Partial<Snapshot>) {
    return this.transaction(() => {
      const s = this.get(claim.snapshot.repository, claim.snapshot.number)
      if (!s || s.lease !== claim.token || s.generation !== claim.generation || (s.revision ?? 0) !== (claim.snapshot.revision ?? 0)) return false
      if (patch.pr) patch = { ...patch, pr: normalizePullRequest(patch.pr) }
      Object.assign(s, patch); this.put(s); Object.assign(claim.snapshot, patch); return true
    })
  }
  requestRefresh(claim: Claim) {
    return this.transaction(() => {
      const s = this.get(claim.snapshot.repository, claim.snapshot.number)
      if (!s || s.lease !== claim.token) return false
      s.refresh = true; s.feedbackRefresh = true; s.revision = (s.revision ?? 0) + 1
      this.put(s); return true
    })
  }
  refreshThreads(observed: Snapshot, threads: Json[]) {
    return this.transaction(() => {
      const s = this.get(observed.repository, observed.number)
      if (!s || s.lease || s.generation !== observed.generation || (s.revision ?? 0) !== (observed.revision ?? 0)) return false
      const semantic = (items: Json[]) => items.map(thread => ({
        id: thread.node_id ?? thread.id, isResolved: thread.isResolved, isOutdated: thread.isOutdated,
        comments: (Array.isArray(thread.comments) ? thread.comments : thread.comments?.nodes ?? []).map((comment: Json) => String(comment.node_id ?? comment.id)).sort(),
      })).sort((a, b) => String(a.id).localeCompare(String(b.id)))
      const changed = digest(semantic(s.threads)) !== digest(semantic(threads))
      s.threads = threads; s.threadsHydrated = true; s.feedbackRefresh = false
      if (changed && s.status !== 'terminal') this.dirty(s, 'review-threads:reconciled')
      this.put(s); return true
    })
  }
  release(claim: Claim) {
    return this.transaction(() => {
      const s = this.get(claim.snapshot.repository, claim.snapshot.number)
      if (!s || s.lease !== claim.token) return false
      s.lease = null; s.leaseUntil = 0; s.nextDirtyAt = undefined
      if (s.status !== 'terminal') s.status = 'ready'
      this.put(s); return true
    })
  }
  finish(claim: Claim, result: { text: string; retry?: boolean; terminal?: boolean; cancelled?: boolean; waitForChecks?: CheckWait; noOp?: boolean }) {
    return this.transaction(() => {
      const s = this.get(claim.snapshot.repository, claim.snapshot.number)
      if (!s || s.lease !== claim.token) return false
      s.lease = null; s.leaseUntil = 0; s.lastResult = result.text
      if (result.noOp && s.generation === claim.generation && s.pr?.head?.sha === claim.snapshot.pr?.head?.sha) { s.noOpHead = s.pr!.head.sha; s.noOpAttempts = (s.noOpAttempts ?? 0) + 1 } else if (s.pr?.head?.sha !== claim.snapshot.pr?.head?.sha) { s.noOpHead = undefined; s.noOpAttempts = 0 }
      s.waitForChecks = result.cancelled || result.terminal ? undefined : result.waitForChecks
      if (result.cancelled) {
        s.cancellationStreak = (s.cancellationStreak ?? 0) + 1
        s.cancellationUntil = this.clock() + Math.min(5 * 60_000, 60_000 * 2 ** Math.min(s.cancellationStreak - 1, 3))
      } else if (!result.retry) {
        s.cancellationStreak = 0; s.cancellationUntil = 0
      }
      if (s.status === 'terminal' || result.terminal && s.generation === claim.generation) {
        s.status = 'terminal'; s.handled = s.generation
        s.cancellationStreak = 0; s.cancellationUntil = 0
      }
      else if (s.generation !== claim.generation) { s.status = 'ready'; s.handled = Math.max(s.handled, claim.generation); s.nextAt = 0; s.dirtyAt = s.nextDirtyAt ?? s.dirtyAt }
      else if (result.cancelled) { s.status = 'ready'; s.nextAt = 0 }
      else if (result.retry) {
        s.attempts++
        if (result.noOp && (s.noOpAttempts ?? 0) >= 3) {
          s.status = 'waiting'; s.handled = s.generation; s.nextAt = 0; s.reasons = ['no-op-budget-exhausted']
        } else {
          // Escalate the delay, not a permanent dead end. A new event resets
          // this retry delay and still preempts the unchanged generation.
          s.status = 'ready'; s.nextAt = this.clock() + Math.min(30 * 60_000, 60_000 * 2 ** Math.min(s.attempts, 5))
        }
      }
      else { s.status = 'waiting'; s.handled = s.generation; s.reasons = [] }
      s.nextDirtyAt = undefined
      this.put(s); return true
    })
  }
  recoverLeases() {
    // Called once by the process owning this database, after the old process exits.
    this.transaction(() => {
      for (const s of this.all()) {
        // Older releases permanently parked retryable failures after three
        // attempts. Resume that legacy state once under bounded retries.
        const legacyRetry = s.status === 'attention'
        // Before fresh generations reset the no-op budget, a new event could
        // make a PR ready while its previous exhausted budget still barred it.
        const strandedNoOp = s.status === 'ready' && s.generation > s.handled
          && (s.noOpAttempts ?? 0) >= 3 && s.noOpHead === s.pr?.head?.sha
        if (!s.lease && !legacyRetry && !strandedNoOp) continue
        s.lease = null; s.leaseUntil = 0; s.nextDirtyAt = undefined
        if (legacyRetry) this.dirty(s, 'retry-policy-recovery')
        if (strandedNoOp) { s.noOpHead = undefined; s.noOpAttempts = 0 }
        if (s.status !== 'terminal') s.status = 'ready'
        this.put(s)
      }
    })
  }
  private queueRows(): QueueRow[] {
    if (this.queueMetadata) return this.queueMetadata
    if (!this.repositories.length) return []
    // One multi-path extraction parses each stored document once. Separate
    // JSON calls repeatedly parse large historical review/check payloads.
    const fields = Object.keys(queueFields), paths = Object.values(queueFields)
    this.queueMetadata = this.db.prepare(`SELECT repository,number,json_extract(value,${paths.map(() => '?').join(',')}) AS metadata
      FROM pr_snapshots WHERE repository IN (${this.repositories.map(() => '?').join(',')})`)
      .all(...paths, ...this.repositories).map(row => {
        const values = JSON.parse(row.metadata as string)
        const item = Object.fromEntries(fields.map((field, index) => [field, values[index]]))
        return { ...item, repository: row.repository, number: Number(row.number),
          cancellationStreak: item.cancellationStreak ?? 0, cancellationUntil: item.cancellationUntil ?? 0,
          noOpAttempts: item.noOpAttempts ?? 0 } as QueueRow
      })
    return this.queueMetadata
  }
  summary(): SnapshotSummary[] {
    return this.queueRows().map(({ dirtyAt, lease, leaseUntil, noOpAttempts, noOpHead, hasPr, author, ...item }) => ({
      ...item, head: item.head ?? undefined, baseRef: item.baseRef ?? undefined,
      headRef: item.headRef ?? undefined, state: item.state ?? undefined, lastResult: item.lastResult ?? undefined,
      reasons: [...item.reasons],
      dirty: item.generation > item.handled,
    }))
  }
}
