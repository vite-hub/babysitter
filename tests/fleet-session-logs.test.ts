// Fleet passes delete their Box on close. These tests cover the Codex session log copy that runs
// first, and the step timings each Box logs, through the local transport.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSshBoxRuntime, localTransport, pruneSessionArchive, type FleetBoxSession } from '../server/fleet/ssh-box.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()

function checkout() {
  const root = mkdtempSync(join(tmpdir(), 'fleet-sessions-test-'))
  const work = join(root, 'checkout')
  mkdirSync(work)
  git(work, 'init', '-q')
  git(work, 'remote', 'add', 'origin', join(root, 'origin.git'))
  writeFileSync(join(work, 'a.txt'), 'one\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-qm', 'base')
  return { root, work }
}

async function openBox(root: string, work: string, archive?: string) {
  const events: Array<[string, Record<string, unknown>]> = []
  const runtime = createSshBoxRuntime({
    host: 'servarica',
    transport: localTransport(),
    root: join(root, 'remote'),
    path: process.env.PATH!,
    sessionArchive: archive,
    log: (event, fields) => { events.push([event, fields]) },
  })
  const input = { cwd: work, identity: 'i', plan: { env: {}, files: {}, state: [] }, requirements: [] }
  const plan = await runtime.prepare(input)
  const session = await runtime.open(input, { executionAuthority: plan.executionAuthority }) as FleetBoxSession
  const home = join(root, 'remote', 'boxes', session.id, 'home')
  return { session, events, home }
}

test('copies the Codex session logs out of the Box before close removes it', async () => {
  const { root, work } = checkout()
  const archive = join(root, 'archive')
  try {
    const { session, events, home } = await openBox(root, work, archive)
    const day = join(home, '.codex', 'sessions', '2026', '11', '08')
    mkdirSync(day, { recursive: true })
    writeFileSync(join(day, 'rollout-2026-11-08T10-00-00-abc.jsonl'), '{"type":"session_meta"}\n')
    // Only regular session logs leave the Box: no other files, no links that point elsewhere.
    writeFileSync(join(day, 'notes.txt'), 'x')
    writeFileSync(join(root, 'secret'), 'secret')
    symlinkSync(join(root, 'secret'), join(day, 'rollout-link.jsonl'))
    writeFileSync(join(home, '.codex', 'sessions', 'rollout-top.jsonl'), 'x')
    await session.close()

    assert.equal(existsSync(join(root, 'remote', 'boxes', session.id)), false)
    assert.deepEqual(readdirSync(join(archive, 'servarica', '2026', '11', '08')), ['rollout-2026-11-08T10-00-00-abc.jsonl'])
    assert.equal(readFileSync(join(archive, 'servarica', '2026', '11', '08', 'rollout-2026-11-08T10-00-00-abc.jsonl'), 'utf8'), '{"type":"session_meta"}\n')
    const closed = events.find(([event]) => event === 'box.closed')?.[1]
    assert.equal(closed?.sessions, 1)
    assert.equal(closed?.host, 'servarica')
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('logs how long each Box step took', async () => {
  const { root, work } = checkout()
  try {
    const { session, events } = await openBox(root, work)
    await session.refreshDependencies(work)
    await session.close()
    const opened = events.find(([event]) => event === 'box.opened')?.[1]
    assert.ok(opened)
    for (const field of ['mirrorMs', 'uploadMs', 'installMs', 'setupMs', 'totalMs']) assert.equal(typeof opened[field], 'number', field)
    assert.equal(opened.installed, true)
    assert.deepEqual(events.find(([event]) => event === 'box.refreshed')?.[1].skipped, true)
    // Without an archive directory nothing is copied, and the Box is still removed.
    assert.equal(events.find(([event]) => event === 'box.closed')?.[1].sessions, 0)
    assert.equal(existsSync(join(root, 'remote', 'boxes', session.id)), false)
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('prunes archived session logs older than the retention', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-sessions-prune-'))
  try {
    const old = join(root, 'servarica', '2026', '10', '01')
    const fresh = join(root, 'servarica', '2026', '11', '08')
    mkdirSync(old, { recursive: true })
    mkdirSync(fresh, { recursive: true })
    writeFileSync(join(old, 'rollout-old.jsonl'), 'x')
    writeFileSync(join(fresh, 'rollout-new.jsonl'), 'x')
    const now = Date.parse('2026-11-08T12:00:00Z')
    utimesSync(join(old, 'rollout-old.jsonl'), new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'))
    utimesSync(join(fresh, 'rollout-new.jsonl'), new Date(now), new Date(now))
    await pruneSessionArchive(root, 14, now)
    assert.equal(existsSync(join(root, 'servarica', '2026', '10')), false)
    assert.deepEqual(readdirSync(fresh), ['rollout-new.jsonl'])
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})
