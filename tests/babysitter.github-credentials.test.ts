import { test } from 'node:test'
import assert from 'node:assert/strict'
import { credentialsForRepository, GitHubAppInstallationRequired } from '../server/babysitter.github-credentials.ts'

const credentials = { appId: '4698907', owner: 'vite-hub', installationId: '156121915', privateKey: 'test-key' }
const installations = JSON.stringify({ 'vite-hub': 156121915, 'nuxt-modules': 159985432 })

test('selects the repository owner installation for GitHub comments and API calls', () => {
  assert.deepEqual(credentialsForRepository(credentials, 'nuxt-modules/better-auth', installations), {
    ...credentials, owner: 'nuxt-modules', installationId: '159985432',
  })
  assert.deepEqual(credentialsForRepository(credentials, 'vite-hub/vitehub', installations), credentials)
})

test('unmapped repositories cannot use personal credentials and bad installation IDs fail', () => {
  assert.throws(() => credentialsForRepository(credentials, 'onmax/vite-doctor', installations), GitHubAppInstallationRequired)
  assert.throws(() => credentialsForRepository(credentials, 'nuxt-modules/better-auth', undefined), GitHubAppInstallationRequired)
  assert.throws(() => credentialsForRepository(credentials, undefined, installations), /require a repository/)
  assert.throws(() => credentialsForRepository(credentials, 'nuxt-modules/better-auth', '{"nuxt-modules":"bad"}'), /Invalid GitHub App installation ID/)
  assert.throws(() => credentialsForRepository(credentials, 'nuxt-modules/better-auth', '[]'), /must be a JSON object/)
  assert.throws(() => credentialsForRepository({ ...credentials, privateKey: undefined }, 'vite-hub/vitehub', installations), /requires complete vitehub-bot App credentials/)
})
