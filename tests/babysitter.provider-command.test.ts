import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveProviderCommand } from '../server/babysitter.provider-command.ts'

test('uses the provider name so the service PATH selects the installed Codex CLI', () => {
  assert.equal(resolveProviderCommand(undefined), 'codex')
  assert.equal(resolveProviderCommand('   '), 'codex')
})

test('honors an explicit provider executable override', () => {
  assert.equal(resolveProviderCommand('/opt/codex/bin/codex'), '/opt/codex/bin/codex')
})
