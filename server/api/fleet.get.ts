import { registeredFleet } from '../fleet/fleet.ts'

export default function fleet() {
  return registeredFleet()?.status() ?? { enabled: false }
}
