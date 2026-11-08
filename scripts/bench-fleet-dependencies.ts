import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus, loadavg, platform, release, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { createSshBoxRuntime, localTransport } from '../server/fleet/ssh-box.ts'

// Run through heavy. The fixture and every cache belong to this worktree.
const output = resolve(process.env.BENCH_OUTPUT ?? '.data/dependency-bench')
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(output, 'run-'))
const checkout = join(root, 'source')
const base = process.env.BENCH_BASE ?? execFileSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8' }).trim()
const candidateSourceSha256 = createHash('sha256').update(await readFile('server/fleet/ssh-box.ts')).digest('hex')
const corepack = execFileSync('corepack', ['--version'], { encoding: 'utf8' }).trim()
execFileSync('git', ['clone', '-q', '--shared', '--no-checkout', '.', checkout])
execFileSync('git', ['-C', checkout, 'checkout', '-q', '--detach', base])
const lock = await readFile(join(checkout, 'pnpm-lock.yaml'))
const baselinePath = join(root, 'baseline.ts')
await writeFile(baselinePath, execFileSync('git', ['show', `${base}:server/fleet/ssh-box.ts`]))
const { createSshBoxRuntime: baselineRuntime } = await import(baselinePath)
const results: object[] = []
const transport = localTransport()
const trials = Number(process.env.TRIALS ?? 5)
let installs = 0
let failures = 0

async function measure(label: string, shared: boolean, concurrency = 1) {
  const started = performance.now()
  const rows = await Promise.all(Array.from({ length: concurrency }, async () => {
    const events: { event: string, fields: Readonly<Record<string, unknown>> }[] = []
    const runtime = (shared ? createSshBoxRuntime : baselineRuntime)({
      host: 'local-fixture', transport, root: join(root, 'fleet'), path: process.env.PATH!,
      log: (event: string, fields: Record<string, unknown>) => events.push({ event, fields }),
    })
    const input = { cwd: checkout, identity: 'benchmark', plan: { env: {}, files: {}, state: [] }, requirements: [{ command: 'git', name: 'git', args: [] }] }
    const plan = await runtime.prepare(input)
    const before = performance.now()
    const session = await runtime.open(input, { executionAuthority: plan.executionAuthority })
    const openMs = performance.now() - before
    try {
      const record = JSON.parse(Buffer.from((await session.files.read(`${session.cwd}/.git/vitehub-install.json`))!).toString())
      assert.equal(record.status, 'installed')
      const check = await session.exec(process.execPath, ['--input-type=module', '-e', `import {createRequire} from 'node:module'; const require=createRequire(process.cwd()+'/package.json'); const evlog=require('evlog'); if(typeof evlog!=='object') process.exit(1); console.log(JSON.stringify({evlog:require('evlog/package.json').version,h3:require('h3/package.json').version}))`])
      assert.equal(check.code, 0, check.stderr)
      assert.deepEqual(Buffer.from((await session.files.read(`${session.cwd}/pnpm-lock.yaml`))!), lock)
      assert.equal((await session.exec('git', ['rev-parse', 'HEAD'])).stdout.trim(), base)
      const manager = await session.exec('pnpm', ['--version'])
      assert.equal(manager.code, 0, manager.stderr)
      assert.equal(manager.stdout.trim(), '10.33.0')
      const files = await session.exec('sh', ['-c', 'find node_modules -type f | wc -l; find node_modules -type l | wc -l'])
      assert.equal(files.code, 0)
      installs++
      return { openMs, events, versions: JSON.parse(check.stdout), filesAndLinks: files.stdout.trim().split('\n').map(Number) }
    }
    catch (error) { failures++; throw error }
    finally { await session.close() }
  }))
  const result = { label, concurrency, load: loadavg(), wallIncludingCloseMs: performance.now() - started, rows }
  results.push(result)
  await writeFile(join(output, 'samples.json'), JSON.stringify({ base, candidateSourceSha256, corepack, node: process.version, pnpm: '10.33.0', lockSha256: createHash('sha256').update(lock).digest('hex'), machine: { cpu: cpus()[0]?.model, cores: cpus().length, platform: platform(), kernel: release(), memoryBytes: totalmem() }, conditions: 'ext4; local transport; network enabled; no page-cache eviction; own initially empty pnpm store; lifecycle scripts and pnpm hooks disabled by existing fleet command; each open gets a new workspace and home; baseline module extracted from base commit; candidate uses current runtime; close excluded from openMs', installs, failures, results }, null, 2))
  console.log(JSON.stringify(result))
}

try {
  await measure('cold-store-baseline', false)
  await measure('cold-corepack-candidate', true)
  for (let trial = 0; trial < trials; trial++) {
    await measure('warm-store-baseline', false)
    await measure('warm-store-candidate', true)
  }
  for (let trial = 0; trial < trials; trial++) {
    await measure('concurrent-baseline', false, 2)
    await measure('concurrent-candidate', true, 2)
  }
}
finally { await rm(root, { recursive: true, force: true }) }
