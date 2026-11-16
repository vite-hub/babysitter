import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { leaseEnvironment } from '../server/agents/babysitter/placement/index.ts'
import { startModelRelay } from '../server/agents/babysitter/placement/relay.ts'
import { withProducer } from '../server/agents/babysitter/placement/ssh.ts'

test('the relay swaps a lease token for the real key and refuses it once revoked', async () => {
  const seen: { authorization?: string, path?: string, body: string }[] = []
  const upstream = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => body += chunk)
    request.on('end', () => {
      seen.push({ authorization: request.headers.authorization, path: request.url, body })
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: ok\n\n')
    })
  }).listen(0, '127.0.0.1')
  await new Promise(resolve => upstream.once('listening', resolve))
  const relay = await startModelRelay({ upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, apiKey: 'real-key' })
  try {
    const lease = relay.issue()
    const call = (token: string) => fetch(`http://127.0.0.1:${relay.port}/v1/responses?x=1`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{"input":"hi"}' })
    const accepted = await call(lease.token)
    assert.equal(accepted.status, 200)
    assert.equal(await accepted.text(), 'data: ok\n\n')
    assert.deepEqual(seen, [{ authorization: 'Bearer real-key', path: '/v1/responses?x=1', body: '{"input":"hi"}' }])
    assert.equal((await call('real-key')).status, 401)
    assert.equal((await call(relay.issue().token.slice(1))).status, 401)
    lease.revoke()
    assert.equal((await call(lease.token)).status, 401)
    assert.equal(seen.length, 1)
  }
  finally {
    await relay.close()
    upstream.close()
  }
})

test('a remote environment carries the lease token and never the real key', () => {
  const remote = leaseEnvironment({ CLIPROXY_API_KEY: 'real-key', OTHER: 'Bearer real-key', OPENAI_BASE_URL: 'http://127.0.0.1:8317/v1', HOME: '/h' }, 'real-key', 'lease-token', 'http://127.0.0.1:4000/v1')
  assert.deepEqual(remote, { OPENAI_BASE_URL: 'http://127.0.0.1:4000/v1', HOME: '/h', VITEHUB_PLACEMENT_MODEL_TOKEN: 'lease-token' })
})

// The bracket keeps pgrep from matching its own shell, whose command line holds the pattern.
const running = (marker: string) => execFileSync('sh', ['-c', `pgrep -f -- ${JSON.stringify(`[${marker[0]}]${marker.slice(1)}`)} || true`], { encoding: 'utf8' }).trim()

test('a producer whose consumer fails is killed, not left blocked on a full pipe', async () => {
  const marker = `yes placement-producer-${process.pid}`
  await assert.rejects(withProducer('sh', ['-c', `exec ${marker}`], {}, async () => { throw new Error('ssh exited 255') }), /ssh exited 255/)
  await sleep(100)
  assert.equal(running(marker), '')
})

test('a consumer that stops reading fails the upload once the producer stays blocked', async () => {
  const marker = `yes placement-blocked-${process.pid}`
  await assert.rejects(withProducer('sh', ['-c', `exec ${marker}`], { drainMs: 200 }, async () => 'remote exited 0 early'), /did not finish/)
  await sleep(100)
  assert.equal(running(marker), '')
})

test('a failed producer fails the upload, and a finished one returns the consumer result', async () => {
  await assert.rejects(withProducer('sh', ['-c', 'echo partial; echo "tar: file changed as we read it" >&2; exit 2'], {}, async stdout => { for await (const _ of stdout); return 'ok' }), /exited 2: tar: file changed/)
  assert.equal(await withProducer('sh', ['-c', 'cat'], { input: 'abc' }, async (stdout) => { let text = ''; for await (const chunk of stdout) text += chunk; return text }), 'abc')
})
