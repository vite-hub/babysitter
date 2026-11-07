import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dist } from './agent-dist.ts'

const github = await import(pathToFileURL(join(dist, 'github-C5fJH50u.js')).href)
const head = 'a'.repeat(40)

function fakeGitHub(resolved = false) {
  const calls: Array<{ query: string; variables: Record<string, string> }> = []
  const client = {
    ensureGraphQLBudget: async () => ({ submit() {}, settle() {}, release() {} }),
    command: async (args: string[]) => {
      const query = args[args.indexOf('-f') + 1]!.slice('query='.length)
      const variables: Record<string, string> = {}
      for (let i = args.indexOf('-f') + 2; i < args.length; i += 2) {
        const [key, ...value] = args[i + 1]!.split('=')
        variables[key!] = value.join('=')
      }
      calls.push({ query, variables })
      let data: unknown = {}
      if (query.includes('latestOpinionatedReviews(first:100)')) data = { repository: {
        autoMergeAllowed: true, squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true, deleteBranchOnMerge: true,
        pullRequest: {
          id: 'PR_1', number: 7, state: 'OPEN', isDraft: false, headRefOid: head, headRefName: 'feature', baseRefName: 'main', baseRefOid: 'b'.repeat(40),
          title: 'feat: x', body: '', author: { login: 'onmax', __typename: 'User' }, authorAssociation: 'OWNER', isCrossRepository: false,
          headRepository: { nameWithOwner: 'acme/app' }, labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          reviewDecision: null, autoMergeRequest: null,
          latestOpinionatedReviews: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      } }
      else if (query.includes('PullRequestReviewThread{pullRequest{id} isResolved}')) data = { node: { pullRequest: { id: 'PR_1' }, isResolved: resolved } }
      return { stdout: JSON.stringify({ data }) }
    },
  }
  const operations = github.r(client, { repository: 'acme/app', number: 7, expectedHeadOid: head, commentPrefix: '<!-- repair -->\n' })
  const mutations = () => calls.filter(call => call.query.startsWith('mutation')).map(call => ({ name: call.query.match(/\{(\w+)\(/)![1], ...call.variables }))
  return { operations, mutations }
}

test('a declined review thread gets its reason as a reply before it is resolved', async () => {
  const { operations, mutations } = fakeGitHub()
  await operations.resolveThread('THREAD_1', { outcome: 'declined', reason: 'P2 edge case outside this PR; tracked by the class reply above.' })
  assert.deepEqual(mutations(), [
    { name: 'addPullRequestReviewThreadReply', id: 'THREAD_1', body: '<!-- repair -->\n<!-- vitehub-babysitter-outcome:declined -->\n**Declined.** P2 edge case outside this PR; tracked by the class reply above.' },
    { name: 'resolveReviewThread', id: 'THREAD_1' },
  ])
})

test('a fixed thread may omit the reason, and every other outcome needs one', async () => {
  const fixed = fakeGitHub()
  await fixed.operations.resolveThread('THREAD_2', { outcome: 'fixed' })
  assert.equal(fixed.mutations()[0]!.body, '<!-- repair -->\n<!-- vitehub-babysitter-outcome:fixed -->\n**Fixed.**')
  const silent = fakeGitHub()
  await assert.rejects(silent.operations.resolveThread('THREAD_3', { outcome: 'disproved', reason: ' ' }), /needs a one-sentence reason/)
  await assert.rejects(silent.operations.resolveThread('THREAD_3', { outcome: 'ignored', reason: 'x' }), /must be one of/)
  assert.deepEqual(silent.mutations(), [])
})

test('an already resolved thread gets no reply', async () => {
  const { operations, mutations } = fakeGitHub(true)
  await operations.resolveThread('THREAD_4', { outcome: 'declined', reason: 'Out of scope.' })
  assert.deepEqual(mutations(), [])
})

test('the worker tool requires an outcome and the third review round asks for a class-level fix', () => {
  const server = readFileSync(join(dist, 'server-DZOuXkga.js'), 'utf8')
  assert.match(server, /required: \["id", "outcome"\]/)
  assert.match(server, /operations\.resolveThread\(stringField\(input, "id"\), \{\s*outcome: stringField\(input, "outcome"\),\s*reason\s*\}\)/)
  assert.match(server, /await resolveThread\(id, answer\);/)
  assert.match(server, /reviewPushesSoFar >= 2 \? `\\n\\n<review-convergence>/)
  assert.match(server, /\$\{reviewBudgetContext\}\$\{convergenceContext\}\$\{pushContext\}/)
})
