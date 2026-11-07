import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function installedDist() {
  let modules = dirname(realpathSync(fileURLToPath(import.meta.resolve('vite-hub/agent'))))
  while (!modules.endsWith('/node_modules')) modules = dirname(modules)
  return join(modules, '@vite-hub/agent/dist')
}

export const dist = process.env.BABYSITTER_TEST_DIST ?? installedDist()
