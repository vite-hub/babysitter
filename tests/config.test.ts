import assert from 'node:assert/strict'
import test from 'node:test'
import { babysitterConfig, type BabysitterLists } from '../server/agents/babysitter/config.ts'

// The defaults that vite.config.ts declares. ViteHub's env.list() and env.json() parse the variables.
function lists(values: Partial<BabysitterLists> = {}): BabysitterLists {
  return {
    repos: [],
    maintainers: [],
    contributors: [],
    botAuthors: ['renovate', 'dependabot'],
    reviewChecks: [],
    mainRepairRepos: [],
    mainRepairWorkflows: ['ci'],
    bypassInheritedChecks: {},
    forkHeadBranches: {},
    ...values,
  }
}

test('an empty environment names no organization', () => {
  const config = babysitterConfig(lists(), {})
  assert.deepEqual(config.repositories, [])
  assert.deepEqual(config.maintainers, [])
  assert.deepEqual(config.contributors, [])
  assert.deepEqual(config.reviewChecks, [])
  assert.deepEqual(config.trustedAuthors, [])
  assert.deepEqual(config.bypassInheritedChecks, {})
  assert.equal(config.mainRepair, false)
  assert.deepEqual(config.authorFilter, { authorAssociation: { allow: ['OWNER', 'MEMBER', 'COLLABORATOR'] } })
  assert.equal(config.model, 'gpt-6.2-sol')
  assert.equal(config.reasoningEffort, 'high')
  assert.equal(config.concurrency, 16)
  assert.equal(config.modelConcurrency, undefined)
  assert.deepEqual(config.inputTokens, { hourly: undefined, daily: undefined })
})

test('maintainers switch the filter to a login list with Renovate and Dependabot', () => {
  const config = babysitterConfig(lists({ maintainers: ['alice', 'bob'], contributors: ['carol'] }), {})
  assert.deepEqual(config.authorFilter, { author: { allow: ['alice', 'bob', 'carol', 'renovate', 'dependabot'] } })
  assert.deepEqual(config.trustedAuthors, ['alice', 'bob', 'renovate', 'dependabot'])
})

test('bot authors replace the defaults', () => {
  const config = babysitterConfig(lists({ maintainers: ['alice'], botAuthors: ['my-app'] }), {})
  assert.deepEqual(config.authorFilter, { author: { allow: ['alice', 'my-app'] } })
})

test('the merge gate trusts bots in their [bot] spelling', () => {
  assert.deepEqual(babysitterConfig(lists(), {}).botAuthors, ['renovate[bot]', 'dependabot[bot]'])
  assert.deepEqual(babysitterConfig(lists({ botAuthors: ['my-app', 'other[bot]'] }), {}).botAuthors, ['my-app[bot]', 'other[bot]'])
})

test('inherited checks to merge past are a JSON map of repository to check names', () => {
  const config = babysitterConfig(lists({ bypassInheritedChecks: { 'vite-hub/vitehub': ['ci', 'publish preview packages'] } }), {})
  assert.deepEqual(config.bypassInheritedChecks, { 'vite-hub/vitehub': ['ci', 'publish preview packages'] })
})

test('fork head branches are a JSON map of repository to branch', () => {
  assert.deepEqual(babysitterConfig(lists(), {}).forkHeadBranches, {})
  const config = babysitterConfig(lists({ forkHeadBranches: { 'vite-hub/vitehub': 'preview/pr-{number}' } }), {})
  assert.deepEqual(config.forkHeadBranches, { 'vite-hub/vitehub': 'preview/pr-{number}' })
})

test('counts must be non-negative integers', () => {
  assert.deepEqual(babysitterConfig(lists(), { BABYSITTER_HOURLY_INPUT_TOKENS: '0', BABYSITTER_DAILY_INPUT_TOKENS: ' ' }).inputTokens, { hourly: 0, daily: undefined })
  assert.equal(babysitterConfig(lists(), { BABYSITTER_MODEL_CONCURRENCY: '20' }).modelConcurrency, 20)
  assert.throws(() => babysitterConfig(lists(), { BABYSITTER_DAILY_INPUT_TOKENS: '-1' }), /BABYSITTER_DAILY_INPUT_TOKENS must be a non-negative integer/)
})

test('main repair watches the listed repositories, on ci unless workflows are named', () => {
  assert.deepEqual(babysitterConfig(lists({ mainRepairRepos: ['a/b'] }), {}).mainRepair, { repositories: ['a/b'], workflows: ['ci'] })
  assert.deepEqual(babysitterConfig(lists({ mainRepairRepos: ['a/b'], mainRepairWorkflows: ['ci', 'pkg.pr.new'] }), {}).mainRepair, { repositories: ['a/b'], workflows: ['ci', 'pkg.pr.new'] })
  assert.equal(babysitterConfig(lists({ mainRepairWorkflows: ['ci'] }), {}).mainRepair, false)
})
