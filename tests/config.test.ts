import assert from 'node:assert/strict'
import test from 'node:test'
import { babysitterConfig } from '../server/agents/babysitter/config.ts'

test('an empty environment names no organization', () => {
  const config = babysitterConfig({})
  assert.deepEqual(config.repositories, [])
  assert.deepEqual(config.maintainers, [])
  assert.deepEqual(config.contributors, [])
  assert.deepEqual(config.reviewChecks, [])
  assert.deepEqual(config.trustedAuthors, [])
  assert.deepEqual(config.bypassInheritedChecks, {})
  assert.equal(config.mainRepair, false)
  assert.deepEqual(config.authorFilter, { authorAssociation: { allow: ['OWNER', 'MEMBER', 'COLLABORATOR'] } })
  assert.equal(config.model, 'gpt-6.1-sol')
  assert.equal(config.reasoningEffort, 'medium')
  assert.equal(config.concurrency, 16)
  assert.equal(config.modelConcurrency, undefined)
  assert.deepEqual(config.inputTokens, { hourly: undefined, daily: undefined })
})

test('maintainers switch the filter to a login list with Renovate and Dependabot', () => {
  const config = babysitterConfig({ BABYSITTER_MAINTAINERS: ' alice, bob ', BABYSITTER_CONTRIBUTORS: 'carol' })
  assert.deepEqual(config.authorFilter, { author: { allow: ['alice', 'bob', 'carol', 'renovate', 'dependabot'] } })
  assert.deepEqual(config.trustedAuthors, ['alice', 'bob', 'renovate', 'dependabot'])
})

test('bot authors replace the defaults', () => {
  const config = babysitterConfig({ BABYSITTER_MAINTAINERS: 'alice', BABYSITTER_BOT_AUTHORS: 'my-app' })
  assert.deepEqual(config.authorFilter, { author: { allow: ['alice', 'my-app'] } })
})

test('lists accept commas and whitespace', () => {
  assert.deepEqual(babysitterConfig({ BABYSITTER_REPOS: 'a/b,c/d e/f' }).repositories, ['a/b', 'c/d', 'e/f'])
  assert.deepEqual(babysitterConfig({ BABYSITTER_REVIEW_CHECKS: 'pullfrog\npullfrog-approval' }).reviewChecks, ['pullfrog', 'pullfrog-approval'])
})

test('inherited checks to merge past are a JSON map of repository to check names', () => {
  const config = babysitterConfig({ BABYSITTER_BYPASS_INHERITED_CHECKS: '{"vite-hub/vitehub":["ci","publish preview packages"]}' })
  assert.deepEqual(config.bypassInheritedChecks, { 'vite-hub/vitehub': ['ci', 'publish preview packages'] })
})

test('counts must be non-negative integers', () => {
  assert.deepEqual(babysitterConfig({ BABYSITTER_HOURLY_INPUT_TOKENS: '0', BABYSITTER_DAILY_INPUT_TOKENS: ' ' }).inputTokens, { hourly: 0, daily: undefined })
  assert.equal(babysitterConfig({ BABYSITTER_MODEL_CONCURRENCY: '20' }).modelConcurrency, 20)
  assert.throws(() => babysitterConfig({ BABYSITTER_DAILY_INPUT_TOKENS: '-1' }), /BABYSITTER_DAILY_INPUT_TOKENS must be a non-negative integer/)
})

test('main repair watches the listed repositories, on ci unless workflows are named', () => {
  assert.deepEqual(babysitterConfig({ BABYSITTER_MAIN_REPAIR_REPOS: 'a/b' }).mainRepair, { repositories: ['a/b'], workflows: ['ci'] })
  assert.deepEqual(babysitterConfig({ BABYSITTER_MAIN_REPAIR_REPOS: 'a/b', BABYSITTER_MAIN_REPAIR_WORKFLOWS: 'ci,pkg.pr.new' }).mainRepair, { repositories: ['a/b'], workflows: ['ci', 'pkg.pr.new'] })
  assert.equal(babysitterConfig({ BABYSITTER_MAIN_REPAIR_WORKFLOWS: 'ci' }).mainRepair, false)
})
