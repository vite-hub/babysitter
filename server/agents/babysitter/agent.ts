import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { codexDriver } from '@vite-hub/agent/harness/codex'
import { defineAgent } from 'vite-hub/agent'
import { trustedHost } from 'vite-hub/box'

const exec = promisify(execFile)
const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
const codexAuth = join(codexHome, 'auth.json')

export default defineAgent({
  box: {
    runtime: trustedHost(),
    cwd: ({ input }) => {
      if (!input.options?.checkout) throw new Error('Babysitter requires a checkout.')
      return input.options.checkout
    },
    env: {
      GH_TOKEN: async () => (await exec('gh', ['auth', 'token'])).stdout.trim(),
      GIT_AUTHOR_EMAIL: () => readGitConfig('user.email'),
      GIT_AUTHOR_NAME: () => readGitConfig('user.name'),
      GIT_COMMITTER_EMAIL: () => readGitConfig('user.email'),
      GIT_COMMITTER_NAME: () => readGitConfig('user.name'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    home: {
      files: {
        ...(existsSync(codexAuth) ? {
          '.codex/auth.json': { contents: () => readFile(codexAuth) },
          '.codex/config.toml': { contents: 'cli_auth_credentials_store = "file"\n' },
        } : {}),
      },
    },
    requires: [
      'git',
      { command: 'git', args: ['config', '--get', 'user.name'] },
      { command: 'git', args: ['config', '--get', 'user.email'] },
      { command: 'gh', args: ['auth', 'status'] },
      'pnpm',
    ],
  },
  driver: codexDriver<{ checkout: string }>(),
})

async function readGitConfig(key: string) {
  return (await exec('git', ['config', '--get', key])).stdout.trim()
}
