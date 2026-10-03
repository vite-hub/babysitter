import { randomUUID } from 'node:crypto'
import { cp, lstat, readdir, realpath, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)

/** Preserve the actual checkout's ancestry in ViteHub's materialized workspace. */
export async function prepareProviderGit(checkout: string, target: string) {
  if (await realpath(checkout) === await realpath(target)) throw new Error('Provider workspace must be separate from prepared checkout.')
  // withPullRequestCheckout creates an independent clone. A linked worktree
  // pointer cannot be copied because it would share its source index.
  if (!(await lstat(join(checkout, '.git'))).isDirectory()) throw new Error('Expected independent prepared Git clone.')
  const expected = (await exec('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout.trim()
  // The provider may recycle a materialized directory. Remove stale metadata
  // before copying so an old index/config/ref cannot survive this invocation.
  await rm(join(target, '.git'), { recursive: true, force: true })
  await cp(join(checkout, '.git'), join(target, '.git'), { recursive: true })
  const actual = (await exec('git', ['rev-parse', 'HEAD'], { cwd: target })).stdout.trim()
  if (actual !== expected) throw new Error('Provider checkout head mismatch.')
  await exec('git', ['remote', 'get-url', 'origin'], { cwd: target })
}


/** Capture local Git proof before the disposable provider workspace is removed. */
export async function createProviderProofLaunch(checkout: string, target: string, command: string) {
  // Reused checkouts keep .git between passes. Drop earlier launchers and proofs.
  const gitDirectory = join(checkout, '.git')
  await Promise.all((await readdir(gitDirectory)).filter(name => name.startsWith('babysitter-provider-'))
    .map(name => rm(join(gitDirectory, name), { force: true })))
  const id = randomUUID()
  const proofPath = join(checkout, '.git', `babysitter-provider-head-${id}.json`)
  const scriptPath = join(checkout, '.git', `babysitter-provider-launch-${id}.mjs`)
  const script = `import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync, renameSync } from 'node:fs'
const cwd = ${JSON.stringify(target)}
const proofPath = ${JSON.stringify(proofPath)}
function captureHead() {
  try {
    const head = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (!/^[a-f0-9]{40,64}$/.test(head)) return
    writeFileSync(proofPath + '.tmp', JSON.stringify({ cwd, head }), { mode: 0o600 })
    renameSync(proofPath + '.tmp', proofPath)
  } catch {}
}
const child = spawn(process.argv[2], process.argv.slice(3), { cwd, env: process.env, stdio: 'inherit' })
const signals = ['SIGTERM', 'SIGINT', 'SIGHUP']
for (const signal of signals) process.on(signal, () => { child.kill(signal) })
child.once('error', () => process.exit(127))
child.once('exit', (code, signal) => {
  captureHead()
  if (signal) {
    for (const name of signals) process.removeAllListeners(name)
    process.kill(process.pid, signal)
  } else process.exit(code ?? 1)
})
`
  await writeFile(scriptPath, script, { mode: 0o600 })
  return { command: process.execPath, args: [scriptPath, command], proofPath }
}

export async function readProviderHeadProof(proofPath: string | undefined, target: string | undefined): Promise<string | undefined> {
  if (!proofPath || !target) return undefined
  try {
    const proof = JSON.parse(await readFile(proofPath, 'utf8'))
    if (proof.cwd === target && typeof proof.head === 'string' && /^[a-f0-9]{40,64}$/.test(proof.head)) return proof.head
  } catch {}
}

/** A completed provider's captured HEAD precedes any later workspace restoration. */
export async function selectProviderHeadProof(
  target: string | undefined,
  proofPath: string | undefined,
  readLive: () => Promise<string>,
): Promise<{ head?: string; source: 'provider-exit' | 'live-git' | 'unavailable'; errorCode?: string }> {
  const captured = await readProviderHeadProof(proofPath, target)
  if (captured) return { head: captured, source: 'provider-exit' }
  if (!target) return { source: 'unavailable', errorCode: 'PROVIDER_NOT_PREPARED' }
  try { return { head: await readLive(), source: 'live-git' } }
  catch (error) {
    // Exit can occur while the live read is pending.
    const capturedAfterRead = await readProviderHeadProof(proofPath, target)
    if (capturedAfterRead) return { head: capturedAfterRead, source: 'provider-exit' }
    return { source: 'unavailable', errorCode: String((error as NodeJS.ErrnoException)?.code ?? 'unknown') }
  }
}

/** GitHub checkout scoping must not redirect commands away from restored provider Git metadata. */
export function providerGitEnvironment(environment: Record<string, string | undefined>): Record<string, string | undefined> {
  const ownCheckout = { ...environment }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete ownCheckout[key]
  return ownCheckout
}

/** pnpm keeps a copy of the lockfile it installed. Equal files mean node_modules is current. */
export async function dependencyState(checkout: string): Promise<'current' | 'stale' | 'missing' | 'unknown'> {
  const [wanted, installed] = await Promise.all([
    readFile(join(checkout, 'pnpm-lock.yaml')).catch(() => undefined),
    readFile(join(checkout, 'node_modules', '.pnpm', 'lock.yaml')).catch(() => undefined),
  ])
  if (!wanted) return 'unknown'
  if (!installed) return 'missing'
  return wanted.equals(installed) ? 'current' : 'stale'
}
