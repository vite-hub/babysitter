import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stackRetargetBase } from '../server/babysitter.stack-base.ts'

const repo = { default_branch: 'main', owner: { login: 'vite-hub' } }
const child = (base: string) => ({ base: { ref: base, repo } })
const parent = (state: string, merged: boolean, into = 'main') => ({ state, merged_at: merged ? '2026-10-01T00:00:00Z' : null, base: { ref: into }, head: { ref: 'feat/parent', repo: { owner: { login: 'vite-hub' } } } })

test('a stacked PR moves to the default branch only after its parent merged', () => {
  assert.equal(stackRetargetBase(child('feat/parent'), [parent('closed', true)]), 'main')
  assert.equal(stackRetargetBase(child('feat/parent'), [parent('open', false)]), undefined)
  assert.equal(stackRetargetBase(child('feat/parent'), [parent('closed', false)]), undefined)
  assert.equal(stackRetargetBase(child('feat/parent'), []), undefined)
  assert.equal(stackRetargetBase(child('feat/parent'), [parent('closed', true, 'feat/grandparent')]), undefined)
  assert.equal(stackRetargetBase(child('main'), [parent('closed', true)]), undefined)
  assert.equal(stackRetargetBase(child('feat/parent'), [parent('closed', true), parent('open', false)]), undefined)
  assert.equal(stackRetargetBase(child('feat/parent'), [{ ...parent('closed', true), head: { ref: 'feat/parent', repo: { owner: { login: 'fork' } } } }]), undefined)
})
