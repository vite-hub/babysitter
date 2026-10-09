import { defineConsoleAuthorize } from 'vite-hub/console/auth'

// The service is exposed through the host's private deployment boundary. Keep
// ViteHub's route-level check explicit while leaving authentication to that
// boundary, as required by the host-managed Console contract.
export default defineConsoleAuthorize(() => true)
