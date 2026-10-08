import { host } from '../../.vitehub/agent/process-hosts'

export default async function health() {
  return await host.health()
}
