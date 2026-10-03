import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('babysitter provider driver is wired to the durable session store', () => {
  const probe = spawnSync(process.execPath, [
    '--experimental-transform-types', '--input-type=module', '-e',
    `const module = await import('./server/agents/babysitter/agent.ts')
const drivers = [
  module.default.__vitehubWorkspaceAgentOptions.driver,
  module.createBabysitterAgent('/tmp/babysitter-test-checkout', 'example/repository').__vitehubWorkspaceAgentOptions.driver,
]
if (drivers.some(driver => driver.sessionStorePath !== module.host.providerSessionStorePath)) {
  console.error(JSON.stringify({ drivers: drivers.map(driver => driver.sessionStorePath), host: module.host.providerSessionStorePath }))
  process.exit(1)
}
process.exit(0)`,
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(probe.status, 0, `${probe.stdout}${probe.stderr}`)
})
