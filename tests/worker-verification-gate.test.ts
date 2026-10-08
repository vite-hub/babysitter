import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFile, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const gate = new URL('../scripts/heavy-command-gate.cjs', import.meta.url).pathname

test('workers with separate private scratch directories share a read-only host lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babysitter-gate-'))
  try {
    const lock = join(root, 'host.lock')
    const log = join(root, 'events.jsonl')
    await writeFile(lock, '')
    await chmod(lock, 0o444)
    await appendFile(log, '')
    const runs = await Promise.all(['a', 'b'].map(async name => {
      const privateDir = join(root, name)
      const script = join(privateDir, 'node_modules/typescript/bin/tsc')
      await mkdir(join(privateDir, 'node_modules/typescript/bin'), { recursive: true })
      await writeFile(script, `const fs = require('node:fs'); const log = ${JSON.stringify(log)}; fs.appendFileSync(log, JSON.stringify({ name: ${JSON.stringify(name)}, kind: 'start' }) + '\\n'); setTimeout(() => { fs.appendFileSync(log, JSON.stringify({ name: ${JSON.stringify(name)}, kind: 'end' }) + '\\n') }, 150)`)
      return await new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, ['--require', gate, script], {
          env: { ...process.env, FLEET_QUEUE_ACTIVE: '', BABYSITTER_HEAVY_SLOT: '', BABYSITTER_HEAVY_LOCK: lock, BABYSITTER_HEAVY_DIR: privateDir },
          stdio: 'pipe',
        })
        let stderr = ''
        child.stderr.on('data', chunk => { stderr += chunk })
        child.once('error', reject)
        child.once('exit', code => code === 0 ? resolve(code) : reject(new Error(stderr)))
      })
    }))
    assert.deepEqual(runs, [0, 0])
    const events = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(events.map(event => event.kind), ['start', 'end', 'start', 'end'])
    assert.equal(events[0].name, events[1].name)
    assert.equal(events[2].name, events[3].name)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
