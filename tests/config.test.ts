import assert from 'node:assert/strict'
import test from 'node:test'
import { babysitterConfig, botLogins } from '../server/agents/babysitter/config.ts'
import { dropInEnv } from './org-env.ts'

test('an empty environment names no organization', () => {
  const config = babysitterConfig({})
  assert.deepEqual(config.repositories, [])
  assert.deepEqual(config.maintainers, [])
  assert.deepEqual(config.contributors, [])
  assert.deepEqual(config.reviewChecks, [])
  assert.deepEqual(config.trustedAuthors, [])
  assert.deepEqual(config.authorFilter, { authorAssociation: { allow: ['OWNER', 'MEMBER', 'COLLABORATOR'] } })
  assert.equal(config.model, 'gpt-6.1-sol')
  assert.equal(config.reasoningEffort, 'medium')
  assert.equal(config.concurrency, 16)
  assert.deepEqual(config.inputTokens, { hourly: undefined, daily: undefined })
})

test('maintainers switch the filter to a login list with Renovate and Dependabot', () => {
  const config = babysitterConfig({ BABYSITTER_MAINTAINERS: ' alice, bob ', BABYSITTER_CONTRIBUTORS: 'carol' })
  assert.deepEqual(config.authorFilter, { author: { allow: ['alice', 'bob', 'carol', 'renovate[bot]', 'renovate', 'dependabot[bot]', 'dependabot'] } })
  assert.deepEqual(config.trustedAuthors, ['alice', 'bob', 'renovate[bot]', 'renovate', 'dependabot[bot]', 'dependabot'])
})

test('bot authors replace the defaults and match both login spellings', () => {
  assert.deepEqual(botLogins(['my-app', 'other[bot]']), ['my-app[bot]', 'my-app', 'other[bot]', 'other'])
  const config = babysitterConfig({ BABYSITTER_MAINTAINERS: 'alice', BABYSITTER_BOT_AUTHORS: 'my-app' })
  assert.deepEqual(config.authorFilter, { author: { allow: ['alice', 'my-app[bot]', 'my-app'] } })
})

test('lists accept commas and whitespace, and BABYSITTER_REPO still works', () => {
  assert.deepEqual(babysitterConfig({ BABYSITTER_REPOS: 'a/b,c/d e/f' }).repositories, ['a/b', 'c/d', 'e/f'])
  assert.deepEqual(babysitterConfig({ BABYSITTER_REPO: 'a/b' }).repositories, ['a/b'])
  assert.deepEqual(babysitterConfig({ BABYSITTER_REVIEW_CHECKS: 'pullfrog\npullfrog-approval' }).reviewChecks, ['pullfrog', 'pullfrog-approval'])
})

test('input token limits must be non-negative integers', () => {
  assert.deepEqual(babysitterConfig({ BABYSITTER_HOURLY_INPUT_TOKENS: '0', BABYSITTER_DAILY_INPUT_TOKENS: ' ' }).inputTokens, { hourly: 0, daily: undefined })
  assert.throws(() => babysitterConfig({ BABYSITTER_DAILY_INPUT_TOKENS: '-1' }), /BABYSITTER_DAILY_INPUT_TOKENS must be a non-negative integer/)
})

test("vite-hub's drop-in keeps the authors and review checks it had before they moved to env", () => {
  const config = babysitterConfig(dropInEnv())
  assert.deepEqual(config.authorFilter, { author: { allow: ['onmax', 'OrlS15', 'renovate[bot]', 'renovate', 'dependabot[bot]', 'dependabot', 'vite-hub[bot]', 'vite-hub', 'vitehub-bot[bot]', 'vitehub-bot'] } })
  assert.deepEqual(config.trustedAuthors, ['onmax', 'renovate[bot]', 'renovate', 'dependabot[bot]', 'dependabot', 'vite-hub[bot]', 'vite-hub', 'vitehub-bot[bot]', 'vitehub-bot'])
  assert.deepEqual(config.reviewChecks, ['pullfrog', 'pullfrog-approval'])
})
