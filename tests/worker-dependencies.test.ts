import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dist } from './agent-dist.ts'

const source = readFileSync(join(dist, 'provider-agent.js'), 'utf8')

test('workers keep the host installation only after a successful install, locally and in a Box', async () => {
  const helper = source.match(/async function installedDependencyEnvironment\(readRecord\) \{[^]*?\n\}/)?.[0]
  assert.ok(helper, 'worker launch must derive pnpm configuration from the install result')
  const { installedDependencyEnvironment: environment } = await import(`data:text/javascript;base64,${Buffer.from(`${helper}\nexport { installedDependencyEnvironment };`).toString('base64')}`)
  assert.deepEqual(await environment(async () => '{"status":"installed"}'), { npm_config_verify_deps_before_run: 'false' })
  assert.deepEqual(await environment(async () => '{"status":"failed"}'), {})
  assert.deepEqual(await environment(async () => { throw new Error('no install record') }), {})
  assert.deepEqual(await environment(async () => 'invalid record'), {})
  assert.match(source, /Object\.assign\(providerRuntimeEnvironment, await installedDependencyEnvironment\(\(\) => readFile\(join\(providerCwd/)
  assert.match(source, /providerBox\.session\.exec\("cat", \[posix\.join\(providerBox\.session\.cwd, "\.git", "vitehub-install\.json"\)/)
  assert.match(source, /const explicitEnvironment = \[\.\.\.Object\.keys\(providerEnvironmentOverrides \|\| \{\}\), \.\.\.Object\.keys\(dependencyEnvironment\)\]/)
})
