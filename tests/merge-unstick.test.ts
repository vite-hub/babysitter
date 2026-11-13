// 2026-11-13: three ways open PRs stopped moving.
// - readBaseCheckEvidence refused whenever main moved after the pass started, so conflict repairs on vitehub
//   ended without a push and spent their no-progress budget.
// - Green drafts by maintainers waited on `draft` because only the reviewed-head path marked them ready.
// - In repositories that delete merged branches, a stack parent refused to merge over its open child's base
//   while the child waited for the parent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dist } from './agent-dist.ts'

const { r: createGitHubPullRequestOperations } = await import(join(dist, 'github-C5fJH50u.js'))
const assigned = 'b'.repeat(40)
const head = 'a'.repeat(40)

function operations(liveBase: string, compare: { status: string, behind_by: number }) {
  const calls: string[] = []
  const pullRequest = {
    id: 'PR_1', number: 1, state: 'OPEN', isDraft: false, headRefOid: head, headRefName: 'feature', baseRefName: 'main', baseRefOid: liveBase,
    title: 't', body: '', author: { login: 'onmax', __typename: 'User' }, authorAssociation: 'OWNER', isCrossRepository: false,
    headRepository: { nameWithOwner: 'o/r' }, labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    reviewDecision: null, autoMergeRequest: null, latestOpinionatedReviews: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  }
  const github = {
    ensureGraphQLBudget: async () => ({ submit() {}, settle() {}, release() {} }),
    command: async (args: string[]) => {
      const path = args[1] === 'graphql' ? 'graphql' : args[1]
      calls.push(path)
      if (path === 'graphql') return { stdout: JSON.stringify({ data: { repository: { autoMergeAllowed: true, squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false, deleteBranchOnMerge: false, pullRequest } } }) }
      if (path.includes('/compare/')) return { stdout: JSON.stringify(compare) }
      if (path.includes('/check-runs')) return { stdout: JSON.stringify({ total_count: 1, check_runs: [{ id: 7, head_sha: assigned, name: 'ci', status: 'completed', conclusion: 'failure' }] }) }
      if (path.includes('/statuses')) return { stdout: '[]' }
      if (path.includes('/actions/runs')) return { stdout: JSON.stringify({ total_count: 0, workflow_runs: [] }) }
      throw new Error(`unexpected ${path}`)
    },
  }
  return { calls, ops: createGitHubPullRequestOperations(github, { repository: 'o/r', number: 1, expectedHeadOid: head, expectedBaseOid: assigned }) }
}

test('base CI evidence stays readable after main moves forward from the assigned base', async () => {
  const { ops, calls } = operations('c'.repeat(40), { status: 'ahead', behind_by: 0 })
  const evidence = await ops.readBaseCheckEvidence()
  assert.equal(evidence.headSha, assigned)
  assert.deepEqual(evidence.checkRuns.map((check: { name: string }) => check.name), ['ci'])
  assert.ok(calls.some(call => call === `/repos/o/r/compare/${assigned}...${'c'.repeat(40)}?per_page=1`))
})

test('base CI evidence is still refused when the base no longer contains the assigned commit', async () => {
  const { ops } = operations('c'.repeat(40), { status: 'diverged', behind_by: 2 })
  await assert.rejects(ops.readBaseCheckEvidence(), /Pull request base changed/)
})

test('an unchanged base needs no compare call', async () => {
  const { ops, calls } = operations(assigned, { status: 'diverged', behind_by: 1 })
  assert.equal((await ops.readBaseCheckEvidence()).headSha, assigned)
  assert.ok(!calls.some(call => call.includes('/compare/')))
})

const server = readFileSync(join(dist, 'server-DZOuXkga.js'), 'utf8')
const mergeReady = server.slice(server.indexOf('async function mergeReadyPullRequest('), server.indexOf('let decision = directMergeReadiness(snapshot, evaluation.state'))

test('the merge-on-green path marks a maintainer draft ready unless its checks fail or it conflicts', () => {
  assert.match(mergeReady, /if \(!pending && snapshot\.pr\?\.draft === true && merge\.markDraftsReady && evaluation\.state !== "failed" && snapshot\.pr\.mergeable !== false && snapshot\.pr\.mergeable_state !== "dirty" && await markDraftReady\(snapshot, owner, signal\)\) \{/)
  assert.match(mergeReady, /text: "Marked the draft ready for review so it can merge\.",[\s\S]*?retryAt: Date\.now\(\) \+ 12e4[\s\S]*?return "blocked";/)
})

test('a stack parent retargets its open children onto its base before a merge deletes their base branch', () => {
  const site = server.slice(server.indexOf('const readStackChildren = '), server.indexOf('if (branchSafety !== true) {'))
  assert.match(site, /branchSafety === "repository cleanup would delete an open child pull request's base branch"/)
  assert.match(site, /"PATCH",\n\t+`repos\/\$\{repository\}\/pulls\/\$\{field\(child, "number"\)\}`,\n\t+"-f",\n\t+`base=\$\{parentBase\}`/)
  assert.match(site, /branchSafety = directMergeBranchSafety\(repositorySettings, live, await readStackChildren\(\)\);/)
  assert.match(site, /schedulerEvent\("babysitter\.stack\.children_retargeted"/)
})
