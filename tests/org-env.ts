import { readFileSync } from 'node:fs'

/** The environment that vite-hub's systemd drop-in (ops/org/org.conf) sets. */
export function dropInEnv(): Record<string, string> {
  const conf = readFileSync(new URL('../ops/org/org.conf', import.meta.url), 'utf8')
  return Object.fromEntries([...conf.matchAll(/^Environment=(\w+)=(.*)$/gm)].map(([, name, value]) => [name!, value!]))
}
