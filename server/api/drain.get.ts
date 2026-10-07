import { host } from '../../.vitehub/agent/process-hosts'

export default function drain() {
  return { status: host.status() }
}
