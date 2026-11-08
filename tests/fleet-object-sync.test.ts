import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createSshBoxRuntime, localTransport, q, type FleetTransport } from '../server/fleet/ssh-box.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' }).trim()

function fixture() {
  const root = mkdtempSync(join(process.cwd(), '.fleet-object-test-'))
  const source = join(root, 'source')
  mkdirSync(source)
  git(source, 'init', '-q', '-b', 'main')
  git(source, 'remote', 'add', 'origin', 'https://example.invalid/source.git')
  writeFileSync(join(source, 'file.txt'), 'base\n')
  git(source, 'add', '.')
  git(source, 'commit', '-qm', 'base')
  git(source, 'tag', '-am', 'base tag', 'base-tag')
  for (const branch of ['one', 'two', 'three']) {
    git(source, 'checkout', '-qb', branch, 'main')
    writeFileSync(join(source, 'file.txt'), `${branch}\n`)
    git(source, 'commit', '-qam', branch)
  }
  git(source, 'update-ref', 'refs/review/extra', 'two')
  const checkouts = ['one', 'two', 'three'].map(branch => {
    const work = join(root, branch)
    cpSync(source, work, { recursive: true })
    git(work, 'checkout', '-q', branch)
    return work
  })
  return { root, checkouts }
}

function controlledTransport(root: string, failFirst = false) {
  const gate = join(root, 'release')
  const entered = Promise.withResolvers<void>()
  let transfers = 0
  const transport: FleetTransport = {
    start(script) {
      if (script.includes('sync.bundle')) {
        transfers++
        if (transfers === 1) entered.resolve()
        script = `until test -e ${q(gate)}; do sleep 0.01; done; ${failFirst && transfers === 1 ? 'exit 73' : script}`
      }
      return spawn('sh', ['-c', script], { stdio: 'pipe' })
    },
  }
  return { transport, entered: entered.promise, release: () => writeFileSync(gate, ''), transfers: () => transfers }
}

function runtime(root: string, transport: FleetTransport, host = 'test') {
  return createSshBoxRuntime({ host, transport, root: join(root, 'remote'), path: process.env.PATH ?? '/usr/bin:/bin' })
}

async function open(box: ReturnType<typeof runtime>, cwd: string, signal?: AbortSignal) {
  const input = { cwd, identity: 'test', plan: { env: {}, files: {}, state: [] }, requirements: [] }
  const plan = await box.prepare(input)
  return box.open(input, { executionAuthority: plan.executionAuthority, signal })
}

function verify(source: string, work: string) {
  for (const args of [['rev-parse', 'HEAD'], ['for-each-ref', '--format=%(refname) %(objectname)'], ['rev-list', '--all', 'HEAD'], ['show', 'HEAD:file.txt'], ['cat-file', '-p', 'base-tag']]) {
    assert.equal(git(work, ...args), git(source, ...args))
  }
  git(work, 'fsck', '--connectivity-only', '--no-dangling')
}

for (const scope of ['same', 'separate']) {
  test(`cold opens on ${scope} runtimes share an object transfer and retain their own heads and refs`, { timeout: 20_000 }, async () => {
    const { root, checkouts } = fixture()
    const control = controlledTransport(root)
    const shared = runtime(root, control.transport)
    const pending = checkouts.map(cwd => open(scope === 'same' ? shared : runtime(root, { ...control.transport }), cwd))
    try {
      await control.entered
      const otherSource = join(root, 'other-source')
      cpSync(checkouts[0]!, otherSource, { recursive: true })
      git(otherSource, 'remote', 'set-url', 'origin', 'https://example.invalid/other.git')
      const otherHostRoot = join(root, 'other-host')
      const otherHost: FleetTransport = { start: script => localTransport().start(script.replaceAll(join(root, 'remote'), otherHostRoot)) }
      const independent = await Promise.all([
        open(runtime(root, localTransport()), otherSource),
        open(runtime(root, otherHost, 'other-host'), checkouts[0]!),
        open(runtime(join(root, 'other-root'), localTransport()), checkouts[0]!),
      ])
      await Promise.all(independent.map(session => session.close()))
      await delay(200)
      control.release()
      const sessions = await Promise.all(pending)
      try {
        sessions.forEach((session, index) => verify(checkouts[index]!, session.cwd))
        assert.equal(control.transfers(), 1, 'the shared history should cross the transport once')
        const previousHead = git(sessions[0]!.cwd, 'rev-parse', 'HEAD')
        writeFileSync(join(checkouts[0]!, 'file.txt'), 'new head\n')
        git(checkouts[0]!, 'commit', '-qam', 'new head')
        const updated = await open(shared, checkouts[0]!)
        try {
          verify(checkouts[0]!, updated.cwd)
          assert.equal(git(sessions[0]!.cwd, 'rev-parse', 'HEAD'), previousHead)
          assert.equal(control.transfers(), 2, 'later heads must sync new objects')
        }
        finally { await updated.close() }
      }
      finally { await Promise.all(sessions.map(session => session.close())) }
    }
    finally {
      control.release()
      await Promise.allSettled(pending)
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('cancelling a queued open leaves the owner and later opens usable without another transfer', { timeout: 20_000 }, async () => {
  const { root, checkouts } = fixture()
  const control = controlledTransport(root)
  const owner = open(runtime(root, control.transport), checkouts[0]!)
  const controller = new AbortController()
  try {
    await control.entered
    const cancelled = open(runtime(root, control.transport), checkouts[1]!, controller.signal)
    const rejected = assert.rejects(cancelled, /waiter cancelled/)
    await delay(200)
    controller.abort(new Error('waiter cancelled'))
    await rejected
    const queued = open(runtime(root, control.transport), checkouts[2]!)
    control.release()
    const session = await owner
    try {
      verify(checkouts[0]!, session.cwd)
      assert.ok(session.spawn)
      const child = await session.spawn('sh', ['-c', 'printf owner'])
      assert.equal(await new Response(child.stdout).text(), 'owner')
      assert.equal((await child.wait()).code, 0)
      const later = await queued
      try { verify(checkouts[2]!, later.cwd) }
      finally { await later.close() }
      assert.equal(control.transfers(), 1, 'a cancelled waiter must not start a redundant transfer')
    }
    finally { await session.close() }
    assert.deepEqual(execFileSync('ls', [join(root, 'remote/boxes')], { encoding: 'utf8' }).trim(), '')
  }
  finally {
    control.release()
    await owner.then(session => session.close(), () => {})
    rmSync(root, { recursive: true, force: true })
  }
})

for (const mode of ['failed', 'aborted']) {
  test(`a${mode === 'aborted' ? 'n' : ''} ${mode} transfer releases the mirror so queued opens retry once and keep complete history`, { timeout: 20_000 }, async () => {
    const { root, checkouts } = fixture()
    const control = controlledTransport(root, mode === 'failed')
    const controller = new AbortController()
    const failed = open(runtime(root, control.transport), checkouts[0]!, controller.signal)
    const rejected = assert.rejects(failed, mode === 'failed' ? /git object transfer failed \(73\)/ : /owner cancelled/)
    try {
      await control.entered
      const pending = checkouts.slice(1).map(cwd => open(runtime(root, control.transport), cwd))
      await delay(200)
      if (mode === 'aborted') controller.abort(new Error('owner cancelled'))
      else control.release()
      await rejected
      control.release()
      const sessions = await Promise.all(pending)
      try {
        sessions.forEach((session, index) => verify(checkouts[index + 1]!, session.cwd))
        assert.equal(control.transfers(), 2, 'one failed attempt and one successful retry should suffice')
      }
      finally { await Promise.all(sessions.map(session => session.close())) }
    }
    finally {
      control.release()
      await rejected
      rmSync(root, { recursive: true, force: true })
    }
  })
}
