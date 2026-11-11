import assert from 'node:assert/strict'
import test from 'node:test'
import { loginList, maintainerApprovalForContributors, ownDraftsReady } from '../server/agents/babysitter/contributors.ts'

const ready = maintainerApprovalForContributors(['OrlS15'], ['onmax'])
const head = 'a'.repeat(40)
const old = 'b'.repeat(40)
const review = (login: string, state: string, commit: string, at: string) => ({ user: { login }, state, commit_id: commit, submitted_at: at })
const pr = (author: string, reviews: ReturnType<typeof review>[] = []) => ({
  head,
  snapshot: { pr: { user: { login: author } }, reviews: Object.fromEntries(reviews.map((value, index) => [String(index), value])) },
})

test('maintainer PRs merge without an approval', () => {
  assert.equal(ready(pr('onmax')), true)
  assert.equal(ready(pr('renovate[bot]')), true)
})

test('a contributor PR waits for a maintainer approval of its current head', () => {
  assert.match(String(ready(pr('OrlS15'))), /onmax approves head aaaaaaa/)
  assert.equal(ready(pr('orls15', [review('onmax', 'APPROVED', head, '2026-11-11T08:00:00Z')])), true)
})

test('an approval of an earlier head does not merge pushes made after it', () => {
  assert.match(String(ready(pr('OrlS15', [review('onmax', 'APPROVED', old, '2026-11-11T08:00:00Z')]))), /approved bbbbbbb/)
})

test('only maintainers approve, and their latest decisive review wins', () => {
  assert.notEqual(ready(pr('OrlS15', [review('OrlS15', 'APPROVED', head, '2026-11-11T08:00:00Z')])), true)
  assert.notEqual(ready(pr('OrlS15', [
    review('onmax', 'APPROVED', head, '2026-11-11T08:00:00Z'),
    review('onmax', 'CHANGES_REQUESTED', head, '2026-11-11T09:00:00Z'),
  ])), true)
  assert.equal(ready(pr('OrlS15', [
    review('onmax', 'APPROVED', head, '2026-11-11T08:00:00Z'),
    review('onmax', 'COMMENTED', head, '2026-11-11T09:00:00Z'),
  ])), true)
})

test('login lists fall back when the variable is empty', () => {
  assert.deepEqual(loginList(undefined, ['onmax']), ['onmax'])
  assert.deepEqual(loginList(' a, b ', ['onmax']), ['a', 'b'])
})

test('maintainer and bot drafts on a repository branch are marked ready, outside drafts are not', () => {
  const drafts = ownDraftsReady(['onmax', 'renovate[bot]'])
  const draft = (author: string, headRepo: string) => ({ repository: 'vite-hub/drop', snapshot: { pr: { user: { login: author }, head: { repo: { full_name: headRepo } } } } })
  assert.equal(drafts(draft('onmax', 'vite-hub/drop')), true)
  assert.equal(drafts(draft('Onmax', 'Vite-Hub/Drop')), true)
  assert.equal(drafts(draft('renovate[bot]', 'vite-hub/drop')), true)
  assert.equal(drafts(draft('OrlS15', 'vite-hub/drop')), false)
  assert.equal(drafts(draft('onmax', 'onmax/drop')), false)
  assert.equal(drafts({ repository: 'vite-hub/drop', snapshot: {} }), false)
})
