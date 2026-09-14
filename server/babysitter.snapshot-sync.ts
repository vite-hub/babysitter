import { createHash } from 'node:crypto'
import { isFeedback, type Claim, type Json, type PullRequestInbox, type Snapshot } from './babysitter.inbox.ts'

type Read = (path: string, projection?: string) => Promise<Json[]>
export type ReadThreads = (repository: string, number: number) => Promise<Json[]>
export type ReadGraphql = (query: string, variables: Record<string, string | number | null>) => Promise<Json>
const index = (items: Json[]) => Object.fromEntries(items.map(item => [String(item.id), item]))

// Thread resolution has no REST equivalent. Read only thread metadata and
// comment IDs here; comment text already comes from paginated REST intake.
export async function readPullRequestThreads(graphql: ReadGraphql, repository: string, number: number): Promise<Json[]> {
  const [owner, name] = repository.split('/')
  if (!owner || !name) throw new Error('Invalid repository for review threads')
  const threads: Json[] = []
  const request = async (query: string, variables: Record<string, string | number | null>) => {
    const response = await graphql(query, variables)
    if (response.errors?.length) throw new Error(`GitHub review thread query failed: ${response.errors.map((e: Json) => e.message).join('; ')}`)
    return response.data ?? response
  }
  const nextCursor = (connection: Json, seen: Set<string>): string | null => {
    if (!connection?.pageInfo || !Array.isArray(connection.nodes)) throw new Error('Incomplete review thread pagination response')
    if (!connection.pageInfo.hasNextPage) return null
    const cursor = connection.pageInfo.endCursor
    if (typeof cursor !== 'string' || !cursor || seen.has(cursor)) throw new Error('Invalid review thread pagination cursor')
    seen.add(cursor); return cursor
  }
  let after: string | null = null
  const pages = new Set<string>()
  do {
    const data = await request(`query BabysitterReviewThreads($owner:String!,$name:String!,$number:Int!,$after:String) {
      repository(owner:$owner,name:$name) { pullRequest(number:$number) { reviewThreads(first:100,after:$after) {
        nodes { id isResolved isOutdated path line originalLine startLine originalStartLine
          comments(first:100) { nodes { id databaseId } pageInfo { hasNextPage endCursor } }
        } pageInfo { hasNextPage endCursor }
      } } }
    }`, { owner, name, number, after })
    const connection = data.repository?.pullRequest?.reviewThreads
    after = nextCursor(connection, pages)
    for (const thread of connection.nodes as Json[]) {
      if (!thread?.id || typeof thread.isResolved !== 'boolean') throw new Error('Incomplete review thread metadata')
      const comments = [...(thread.comments?.nodes ?? [])]
      const commentPages = new Set<string>()
      let commentAfter = nextCursor(thread.comments, commentPages)
      while (commentAfter) {
        const more = await request(`query BabysitterThreadComments($id:ID!,$after:String!) {
          node(id:$id) { ... on PullRequestReviewThread { comments(first:100,after:$after) {
            nodes { id databaseId } pageInfo { hasNextPage endCursor }
          } } }
        }`, { id: thread.id, after: commentAfter })
        const connection = more.node?.comments
        commentAfter = nextCursor(connection, commentPages)
        comments.push(...connection.nodes)
      }
      threads.push({ ...thread, comments, resolutionSource: 'graphql' })
    }
  } while (after)
  return threads
}

/** REST snapshots fill webhook gaps without asking an LLM to poll GitHub. */
export async function readSnapshot(read: Read, repository: string, number: number, readThreads?: ReadThreads): Promise<Partial<Snapshot> & { pr: Json }> {
  const prefix = `repos/${repository}`
  const [pr] = await read(`${prefix}/pulls/${number}`, '.')
  if (!pr) throw new Error('GitHub returned no pull request.')
  if (pr.state !== 'open') return { pr }
  const [comments, reviews, reviewComments, checks, statuses, threads] = await Promise.all([
    read(`${prefix}/issues/${number}/comments?per_page=100`),
    read(`${prefix}/pulls/${number}/reviews?per_page=100`),
    read(`${prefix}/pulls/${number}/comments?per_page=100`),
    read(`${prefix}/commits/${pr.head.sha}/check-runs?per_page=100`, '.check_runs[]'),
    read(`${prefix}/commits/${pr.head.sha}/statuses?per_page=100`),
    readThreads?.(repository, number),
  ])
  return { pr, comments: index(comments.filter(isFeedback)), reviews: index(reviews),
    reviewComments: index(reviewComments),
    checks: Object.fromEntries(checks.map(c => [`check_run:${c.id}`, c])),
    statuses: Object.fromEntries([...statuses].reverse().map(s => [s.context, s])), hydrated: true,
    ...(threads ? { threads, threadsHydrated: true, feedbackRefresh: false } : {}) }
}

export async function hydrateSnapshot(inbox: PullRequestInbox, claim: Claim, read: Read, readThreads?: ReadThreads) {
  const { snapshot: current } = claim
  if (current.hydrated && !current.refresh) {
    if (!readThreads || current.threadsHydrated && !current.feedbackRefresh) return true
    const threads = await readThreads(current.repository, current.number)
    return inbox.hydrate(claim, { threads, threadsHydrated: true, feedbackRefresh: false })
  }
  const snapshot = await readSnapshot(read, current.repository, current.number, readThreads)
  // CAS keeps an event received while REST requests ran from being overwritten.
  return inbox.hydrate(claim, { ...snapshot, refresh: false })
}

export async function reconcileOneSnapshot(inbox: PullRequestInbox, read: Read, now = Date.now(), readThreads?: ReadThreads) {
  // No more than one PR per minute, and no PR more often than every 15 minutes.
  // The first probe is delayed because bootstrap/claims already hydrate state.
  const globalKey = 'snapshot-reconcile-next'
  const globalNext = inbox.meta<number>(globalKey)
  if (globalNext === undefined) { inbox.setMeta(globalKey, now + 15 * 60_000); return }
  if (globalNext > now) return
  inbox.setMeta(globalKey, now + 60_000)
  const candidates = inbox.all().filter(s => !s.lease && s.status !== 'terminal')
    .sort((a, b) => (inbox.meta<number>(`snapshot-probe:${a.repository}:${a.number}`) ?? 0) - (inbox.meta<number>(`snapshot-probe:${b.repository}:${b.number}`) ?? 0))
  const s = candidates.find(s => (inbox.meta<number>(`snapshot-probe:${s.repository}:${s.number}`) ?? 0) <= now)
  if (!s) return
  inbox.setMeta(`snapshot-probe:${s.repository}:${s.number}`, now + 15 * 60_000)
  const snapshot = await readSnapshot(read, s.repository, s.number, readThreads)
  // Apply only if no webhook or claim arrived while this targeted probe ran.
  // New resolution evidence wakes a waiting PR without repeated full queries
  // in every agent pass.
  if (snapshot.threads) inbox.refreshThreads(s, snapshot.threads)
  const ingest = (event: string, payload: Json) => {
    const full = { repository: { full_name: s.repository }, ...payload }
    const id = `reconcile:${createHash('sha256').update(JSON.stringify([event, full])).digest('hex')}`
    inbox.ingest(id, event, full)
  }
  ingest('pull_request', { action: snapshot.pr.state === 'closed' ? 'closed' : 'synchronize', pull_request: snapshot.pr })
  if (snapshot.pr.state !== 'open') return
  for (const comment of Object.values(snapshot.comments ?? {})) ingest('issue_comment', { action: 'edited', issue: { number: s.number, pull_request: {} }, comment })
  for (const review of Object.values(snapshot.reviews ?? {})) ingest('pull_request_review', { action: 'submitted', pull_request: snapshot.pr, review })
  for (const comment of Object.values(snapshot.reviewComments ?? {})) ingest('pull_request_review_comment', { action: 'edited', pull_request: snapshot.pr, comment })
  for (const check_run of Object.values(snapshot.checks ?? {})) ingest('check_run', { action: check_run.status, check_run })
  for (const status of Object.values(snapshot.statuses ?? {}) as Json[]) ingest('status', { ...status, sha: snapshot.pr.head.sha })
}
