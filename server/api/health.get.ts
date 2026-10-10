import { host } from '../../.vitehub/agent/process-hosts'
import manifest from '../../package.json' with { type: 'json' }

export default async function health() {
  return { ...await host.health(), vitehubRevision: manifest.dependencies['vite-hub'].split('@').at(-1) }
}
