import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('heartbeat wakes work while HTTP is live and permits exit after HTTP closes', async () => {
  const source = await readFile(new URL('../server/agents/babysitter/agent.ts', import.meta.url), 'utf8')
  // Execute the production timer block without constructing a real provider,
  // touching its database, or requiring server credentials. Shorten only its
  // period so the process lifecycle proof does not take ten seconds.
  const block = source.match(/setTimeout\(\(\) => \{\n  host\.wake\(\)[\s\S]*?\n\}, 0\)/)?.[0]
  assert.ok(block, 'production heartbeat initialization is present')
  const timerBlock = block.replace('10_000', '20')

  async function exercise(initialization: string) {
    const script = `
      const http = require('node:http');
      let wakes = 0;
      const server = http.createServer((request, response) => response.end(String(wakes)));
      const host = { wake() {
        wakes++;
        if (wakes !== 2) return;
        http.get({ hostname: '127.0.0.1', port: server.address().port }, response => {
          let reply = '';
          response.on('data', chunk => reply += chunk);
          response.on('end', () => server.close(() => {
            console.log(JSON.stringify({ wakes, reply, serverClosed: true }));
          }));
        });
      }};
      server.listen(0, '127.0.0.1', () => { ${initialization} });
    `
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = '', timedOut = false
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { errors += chunk })
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 2000)
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      assert.equal(errors, '')
      const result = JSON.parse(output.trim())
      assert.equal(result.serverClosed, true)
      assert.ok(Number(result.reply) >= 2, 'the recurring heartbeat ran while HTTP was serving')
      assert.ok(result.wakes >= Number(result.reply))
      return { code, timedOut }
    }
    finally {
      clearTimeout(timeout)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }

  assert.deepEqual(await exercise(timerBlock), { code: 0, timedOut: false })
  // Red control reproduces the deployed shutdown hang with the original
  // referenced timer, even after the exact same HTTP lifecycle completes.
  assert.deepEqual(await exercise(timerBlock.replace('.unref()', '')), { code: null, timedOut: true })
})
