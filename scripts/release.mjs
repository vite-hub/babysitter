#!/usr/bin/env node
// Release one commit to the Slimbook Babysitter, or roll it back.
//
//   pnpm release <sha> [--smoke-only]
//
// Builds and tests the commit in a clean worktree, stages it into
// /home/workspace/babysitter-release-<sha>, smoke-boots it on a spare port with
// scratch data, switches release.conf atomically, drains and restarts the live
// service, then watches /tmp, free disk and token rate. A spike, a failed health
// check or a stopped service restores the previous release.conf.
//
// The smoke boot excludes real authors and uses a zero token budget. Host-only
// merges and retargeting remain available under model admission blocks.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const UNIT = 'babysitter-vitehub.service'
const RELEASE_CONF = '/etc/systemd/system/babysitter-vitehub.service.d/release.conf'
const WORKSPACE = '/home/workspace'
const LIVE = 'http://127.0.0.1:3028'
const WATCH_MS = Number(process.env.RELEASE_WATCH_MINUTES ?? 15) * 60_000
const SAMPLE_MS = 30_000
// Rollback triggers during the watch.
const TMP_MAX_PERCENT = 85
const DISK_MIN_FREE = 20 * 2 ** 30
// Other sessions share this disk, so only an absolute floor is a Babysitter signal.
// The token guard is a per-window cap. Usage well past it means the cap is not enforced.
const TOKEN_CAP_FACTOR = 1.5
const FLEET_QUEUE = '/home/maxi/.local/bin/fleet-queue'

const args = process.argv.slice(2)
const smokeOnly = args.includes('--smoke-only')
const ref = args.find(arg => !arg.startsWith('--'))
if (!ref) fail('usage: pnpm release <sha> [--smoke-only]')

const log = (message) => console.log(`[release ${new Date().toLocaleTimeString('en-GB')}] ${message}`)
function fail(message) {
  console.error(`[release] ${message}`)
  process.exit(1)
}
function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', ...options })
  if (result.status !== 0 && !options.allowFailure) fail(`${command} ${argv.join(' ')} exited ${result.status}${options.capture ? `\n${result.stderr}` : ''}`)
  return result
}
function queued(command, argv, options = {}) {
  return run(FLEET_QUEUE, [command, ...argv], options)
}
const sudo = (argv, options) => run('sudo', argv, options)
const out = (command, argv) => execFileSync(command, argv, { encoding: 'utf8' }).trim()

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return await response.json()
}
const babysitterHealth = async base => {
  const health = await json(`${base}/api/health`)
  const agents = health.agents ?? {}
  return { status: health.status, agent: Array.isArray(agents) ? agents[0] : agents.babysitter ?? Object.values(agents)[0] }
}
async function waitFor(what, timeoutMs, check) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      last = error
    }
    await sleep(2_000)
  }
  fail(`${what} did not happen within ${timeoutMs / 1000}s${last ? `: ${last.message}` : ''}`)
}
const portFree = port => new Promise(resolve => {
  const socket = createConnection({ host: '127.0.0.1', port })
  socket.once('connect', () => { socket.destroy(); resolve(false) })
  socket.once('error', () => resolve(true))
})
function tmpUsage(path = '/tmp') {
  try {
    const stats = statfsSync(path)
    return 100 * (1 - stats.bavail / stats.blocks)
  } catch (error) {
    // The live service keeps its TMPDIR under /home/workspace, which is
    // intentionally inaccessible to the release user. Read the same mount's
    // usage through the already-authorized sudo boundary instead of silently
    // skipping the resource watch.
    const result = spawnSync('sudo', ['-n', 'df', '-P', '-k', path], { encoding: 'utf8' })
    if (result.status === 0) {
      const fields = result.stdout.trim().split(/\s+/)
      const capacity = fields.at(-2)
      if (capacity?.endsWith('%')) return Number.parseFloat(capacity)
    }
    throw error
  }
}
function workspaceFree() {
  // The workspace is not readable by maxi; its filesystem is /home's.
  const stats = statfsSync('/home')
  return stats.bavail * stats.bsize
}

// 1. Build and test the exact commit in a clean worktree.
const repo = out('git', ['rev-parse', '--show-toplevel'])
const sha = out('git', ['rev-parse', '--verify', `${ref}^{commit}`])
const short = sha.slice(0, 7)
const cache = join(homedir(), '.cache/babysitter-release', short)
const source = join(cache, 'src')
const unitEnvironment = out('systemctl', ['show', UNIT, '-p', 'Environment', '--value'])
const publicUrl = unitEnvironment.match(/(?:^|\s)"?BABYSITTER_PUBLIC_URL=([^\s"]+)/)?.[1]
if (!publicUrl) fail('cannot read BABYSITTER_PUBLIC_URL from the live unit')
log(`building ${sha} in ${source}`)
rmSync(cache, { force: true, recursive: true })
mkdirSync(cache, { recursive: true })
run('git', ['-C', repo, 'worktree', 'add', '--detach', '--force', source, sha])
const inSource = { cwd: source, env: { ...process.env, CI: '1', TMPDIR: join(cache, 'tmp'), BABYSITTER_PUBLIC_URL: publicUrl } }
mkdirSync(inSource.env.TMPDIR, { recursive: true })
run('corepack', ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline'], inSource)
// The build generates the #vitehub/env types that typecheck needs.
queued('corepack', ['pnpm', 'build'], inSource)
queued('corepack', ['pnpm', 'typecheck'], inSource)
queued('corepack', ['pnpm', 'test'], inSource)

// 2. Stage the server output next to the earlier releases.
let releaseName = `babysitter-release-${short}`
if (sudo(['test', '-e', join(WORKSPACE, releaseName)], { allowFailure: true }).status === 0)
  releaseName += `-${new Date().toISOString().replace(/\D/g, '').slice(0, 12)}`
const release = join(WORKSPACE, releaseName)
log(`staging ${release}`)
sudo(['install', '-d', '-o', 'svc-babysitter', '-g', 'codex-workspace', '-m', '2775', release])
sudo(['cp', '-a', join(source, '.output'), release])
sudo(['chown', '-R', 'svc-babysitter:codex-workspace', release])
const entry = join(release, '.output/server/index.mjs')
sudo(['-u', 'svc-babysitter', '/usr/local/bin/node', '--check', entry])
run('git', ['-C', repo, 'worktree', 'remove', '--force', source])

// 3. Smoke-boot the release with scratch data and a forced zero token budget.
let port = 3128
while (!(await portFree(port))) port++
const scratch = join(WORKSPACE, `babysitter-smoke-${short}`)
const smokeUnit = `babysitter-smoke-${short}`
const pick = name => unitEnvironment.match(new RegExp(`(?:^|\\s)"?${name}=([^"\\s]*)`))?.[1]
const envFiles = out('systemctl', ['show', UNIT, '-p', 'EnvironmentFiles', '--value']).split('\n').map(line => line.split(' ')[0]).filter(Boolean)
sudo(['rm', '-rf', scratch])
sudo(['install', '-d', '-o', 'svc-babysitter', '-g', 'codex-workspace', '-m', '2770', scratch, join(scratch, 'tmp')])
log(`smoke-booting on 127.0.0.1:${port} with scratch data in ${scratch}`)
const smokeEnv = {
  HOME: pick('HOME') ?? '/home/agents',
  CODEX_HOME: pick('CODEX_HOME') ?? '/home/agents/.codex',
  PATH: pick('PATH') ?? '/usr/local/bin:/usr/bin:/bin',
  BABYSITTER_REPOS: pick('BABYSITTER_REPOS') ?? '',
  BABYSITTER_MAX_OWNERS: pick('BABYSITTER_MAX_OWNERS') ?? '1',
  BABYSITTER_PUBLIC_URL: publicUrl,
  HOST: '127.0.0.1',
  PORT: String(port),
  NODE_ENV: 'production',
  TMPDIR: join(scratch, 'tmp'),
  VITEHUB_CONSOLE_DATABASE_URL: `file:${join(scratch, 'console.sqlite')}`,
  BABYSITTER_HOURLY_INPUT_TOKENS: '0',
  BABYSITTER_SMOKE_ONLY: '1',
}
sudo(['systemd-run', `--unit=${smokeUnit}`, '--collect', '--quiet',
  '-p', 'User=svc-babysitter', '-p', 'Group=codex-workspace', '-p', 'UMask=0002',
  '-p', `WorkingDirectory=${scratch}`, '-p', 'NoNewPrivileges=yes', '-p', 'PrivateTmp=yes',
  '-p', 'ProtectSystem=strict', '-p', 'ProtectHome=read-only', '-p', `ReadWritePaths=${scratch}`,
  '-p', 'MemoryMax=2G', ...envFiles.flatMap(file => ['-p', `EnvironmentFile=${file}`]),
  ...Object.entries(smokeEnv).map(([key, value]) => `--setenv=${key}=${value}`),
  '/usr/local/bin/node', entry])
const stopSmoke = () => {
  sudo(['systemctl', 'stop', smokeUnit], { allowFailure: true, capture: true })
  sudo(['rm', '-rf', scratch], { allowFailure: true })
}
try {
  const { agent } = await waitFor('smoke health', 90_000, async () => {
    const health = await babysitterHealth(`http://127.0.0.1:${port}`)
    return health.agent?.budget && health.agent.admission?.reason === 'token-budget-hourly' ? health : undefined
  })
  if (agent.release !== sha) throw new Error(`smoke release is ${agent.release}, expected ${sha}`)
  const drain = await json(`http://127.0.0.1:${port}/api/drain`)
  if (drain.status !== 'accepting') throw new Error(`smoke drain status is ${drain.status}`)
  log(`smoke ok: release ${short}, admission paused (${agent.admission.detail}), drain ${drain.status}`)
  if (agent.workload?.active !== 0 || agent.queue?.working !== 0 || agent.queue?.ready !== 0)
    throw new Error('smoke configuration admitted real PR work')
  log('smoke has no eligible PR work')
}
catch (error) {
  sudo(['journalctl', '-u', smokeUnit, '-n', '40', '--no-pager'], { allowFailure: true })
  stopSmoke()
  fail(`smoke boot failed: ${error.message}`)
}
stopSmoke()
if (smokeOnly) {
  log(`--smoke-only: staged ${release}; live service untouched`)
  process.exit(0)
}

// 4. Switch release.conf atomically, then drain and restart.
const previousConf = out('sudo', ['cat', RELEASE_CONF])
const nextConf = `[Service]\nExecStart=\nExecStartPre=/usr/local/bin/node --check ${entry}\nExecStart=/usr/local/bin/node ${entry}\n`
function installReleaseConf(content) {
  const staged = join(cache, 'release.conf')
  writeFileSync(staged, content)
  sudo(['install', '-m', '644', staged, `${RELEASE_CONF}.next`])
  sudo(['mv', '-f', `${RELEASE_CONF}.next`, RELEASE_CONF]) // rename(2) in one directory
  sudo(['systemctl', 'daemon-reload'])
}
async function drainAndRestart(expectedRelease) {
  log('draining: SIGUSR2 to the main process')
  sudo(['systemctl', 'kill', '--kill-whom=main', '--signal=SIGUSR2', UNIT])
  const started = Date.now()
  let lastReport = 0
  for (;;) {
    const status = await json(`${LIVE}/api/drain`).then(body => body.status, () => 'unavailable')
    if (status === 'drained') break
    if (Date.now() - lastReport >= 60_000) {
      lastReport = Date.now()
      const running = await babysitterHealth(LIVE).then(health => health.agent?.workload?.active, () => '?')
      log(`drain ${status}, ${running} passes running, ${Math.round((Date.now() - started) / 60_000)} min`)
    }
    await sleep(5_000)
  }
  log('drained; restarting')
  sudo(['systemctl', 'restart', UNIT])
  await waitFor('live health after restart', 120_000, async () => {
    const health = await babysitterHealth(LIVE)
    return (!expectedRelease || health.agent?.release === expectedRelease) && (await json(`${LIVE}/api/drain`)).status === 'accepting'
  })
}
const initialHealth = await babysitterHealth(LIVE)
const serviceTmp = initialHealth.agent?.budget?.tmp?.dir || '/tmp'
const baseline = { tmp: tmpUsage(serviceTmp), free: workspaceFree() }
log(`baseline: service tmp ${baseline.tmp.toFixed(0)}% (${serviceTmp}), ${(baseline.free / 2 ** 30).toFixed(0)} GiB free`)
const previousRelease = (await babysitterHealth(LIVE).catch(() => undefined))?.agent?.release
installReleaseConf(nextConf)
const preflight = sudo(['-u', 'svc-babysitter', '/home/workspace/babysitter-data/bin/verify-merge-gate'], { allowFailure: true })
if (preflight.status !== 0) {
  installReleaseConf(previousConf)
  fail('release preflight failed; restored the previous systemd target')
}
await drainAndRestart(sha)
log(`live on ${release}`)

// 5. Watch shared resources; roll back on a spike.
let problem
// Health can miss one sample while passes start; three in a row (90 s) is an outage.
let healthFailures = 0
for (const until = Date.now() + WATCH_MS; Date.now() < until && !problem; await sleep(SAMPLE_MS)) {
  const health = await babysitterHealth(LIVE).catch(error => ({ error }))
  const tmpDir = health.agent?.budget?.tmp?.dir || serviceTmp
  const tmp = tmpUsage(tmpDir)
  const free = workspaceFree()
  if (tmp >= TMP_MAX_PERCENT) problem = `service tmp ${tmpDir} at ${tmp.toFixed(0)}% (baseline ${baseline.tmp.toFixed(0)}%)`
  else if (free < DISK_MIN_FREE) problem = `free disk ${(free / 2 ** 30).toFixed(0)} GiB (baseline ${(baseline.free / 2 ** 30).toFixed(0)} GiB)`
  else if (out('systemctl', ['is-active', UNIT]) !== 'active') problem = `${UNIT} is not active`
  else {
    const hourly = health.agent?.budget?.hourly
    healthFailures = health.error ? healthFailures + 1 : 0
    if (healthFailures >= 3) problem = `health failed ${healthFailures} times in a row: ${health.error.message}`
    else {
      for (const [name, window] of [['hourly', hourly], ['daily', health.agent?.budget?.daily]]) {
        if (window && typeof window.inputTokens === 'number' && window.limit > 0 && window.inputTokens > TOKEN_CAP_FACTOR * window.limit) {
          problem = `${name} input tokens ${(window.inputTokens / 1e6).toFixed(1)}M exceed ${TOKEN_CAP_FACTOR}x the ${(window.limit / 1e6).toFixed(0)}M cap; the guard is not enforcing it`
        }
      }
    }
    const budgetErrors = health.agent?.budget?.errors?.join('; ')
    log(`watch: service tmp ${tmp.toFixed(0)}%, ${(free / 2 ** 30).toFixed(0)} GiB free, ${health.error ? `health failed (${health.error.message})` : typeof hourly?.inputTokens === 'number' ? `${(hourly.inputTokens / 1e6).toFixed(1)}M of ${(hourly.limit / 1e6).toFixed(0)}M tokens this hour` : 'no budget data'}${budgetErrors ? ` [${budgetErrors}]` : ''}, admission ${health.agent?.admission?.accepting === false ? `paused (${health.agent.admission.reason})` : 'open'}`)
  }
}
if (!problem) {
  log(`release ${short} held for ${WATCH_MS / 60_000} minutes; done`)
  rmSync(cache, { force: true, recursive: true })
  process.exit(0)
}
log(`rolling back: ${problem}`)
installReleaseConf(previousConf.endsWith('\n') ? previousConf : `${previousConf}\n`)
await drainAndRestart(previousRelease)
fail(`rolled back to ${previousRelease ?? 'the previous release.conf'} after: ${problem}`)
