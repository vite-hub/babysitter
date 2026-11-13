// Contributors are people outside the organization whose PRs the Babysitter repairs like a
// maintainer's. It merges one only after a maintainer approves its current head, so a maintainer
// reads every outside change before it lands. Pushes after that approval, including the
// Babysitter's own repairs, need a new approval.

interface Actor { login?: string | null }
interface Review {
  state?: string | null
  user?: Actor | null
  author?: Actor | null
  commit_id?: string | null
  commit?: { oid: string } | null
  submitted_at?: string | null
  submittedAt?: string | null
  deleted?: boolean
}
interface MergeInput {
  head: string
  snapshot: { pr?: { user?: Actor | null, author?: Actor | null } | null, reviews?: Record<string, Review> }
}

const login = (actor: Actor | null | undefined) => String(actor?.login ?? '').trim().toLowerCase()

/** Returns a `merge.ready` predicate: `true` merges, a string is the reason the PR waits. */
export function maintainerApprovalForContributors(contributors: readonly string[], maintainers: readonly string[]) {
  const outside = new Set(contributors.map(name => name.toLowerCase()))
  const approvers = new Set(maintainers.map(name => name.toLowerCase()))
  return ({ head, snapshot }: MergeInput): true | string => {
    if (!outside.has(login(snapshot.pr?.user ?? snapshot.pr?.author))) return true
    // A maintainer's latest decisive review counts. COMMENTED and PENDING reviews leave it standing.
    const decisive = Object.values(snapshot.reviews ?? {})
      .filter(review => !review.deleted && approvers.has(login(review.user ?? review.author)))
      .filter(review => ['approved', 'changes_requested', 'dismissed'].includes(String(review.state ?? '').toLowerCase()))
      .sort((a, b) => String(a.submitted_at ?? a.submittedAt ?? '').localeCompare(String(b.submitted_at ?? b.submittedAt ?? '')))
    const latest = decisive.at(-1)
    const state = String(latest?.state ?? '').toLowerCase()
    const commit = latest?.commit_id ?? latest?.commit?.oid
    if (state === 'approved' && commit === head) return true
    const who = [...maintainers].join(' or ')
    if (state === 'approved') return `a maintainer approval of head ${head.slice(0, 7)}: ${who} approved ${String(commit).slice(0, 7)}, and outside contributor PRs merge only on an approved head`
    return `a maintainer approval: outside contributor PRs merge only after ${who} approves head ${head.slice(0, 7)}`
  }
}
